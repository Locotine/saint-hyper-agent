// FILE: backend.rs
// Purpose: Spawns and supervises the `apps/server` sidecar binary (`saint-server` compiled
//          via `bun build --compile` in production, or `bun run src/index.ts` in dev),
//          detects the listening HTTP/WS port, verifies readiness, and manages clean teardown.
// Layer: Desktop sidecar supervision (Option 1A+ / 4A).

use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::state::SaintPaths;

pub const BACKEND_MAX_CONSECUTIVE_START_FAILURES: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionInput {
    pub audio_base64: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionResult {
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct SidecarRuntimeBridgeConfig {
    pub browser_pipe_path: Option<String>,
    pub browser_capability: Option<String>,
    pub cua_host_socket: Option<String>,
    pub pty_bridge_port: Option<u16>,
    pub pty_bridge_token: Option<String>,
}

pub struct BackendSupervisor {
    paths: SaintPaths,
    port: u16,
    auth_token: String,
    shutdown_token: String,
    child: Mutex<Option<Child>>,
    http_base_url: Mutex<Option<String>>,
    ws_url: Mutex<Option<String>>,
    consecutive_failures: Mutex<u32>,
}

fn resolve_bun_executable() -> PathBuf {
    #[cfg(target_os = "windows")]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let mise_bun = PathBuf::from(local_app_data)
            .join("mise")
            .join("installs")
            .join("bun")
            .join("1.4.4")
            .join("bin")
            .join("bun.exe");
        if mise_bun.is_file() {
            return mise_bun;
        }
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        let mise_bun = home
            .join(".local/share/mise/installs/bun/1.4.4/bin/bun");
        if mise_bun.is_file() {
            return mise_bun;
        }
    }
    PathBuf::from("bun")
}

impl BackendSupervisor {
    pub fn new(paths: SaintPaths) -> Self {
        let port = Self::allocate_ephemeral_port();
        let auth_token = std::env::var("SAINT_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
        let shutdown_token = uuid::Uuid::new_v4().simple().to_string();
        let http_base = format!("http://127.0.0.1:{port}");
        let ws_url = format!("ws://127.0.0.1:{port}/?token={auth_token}");

        Self {
            paths,
            port,
            auth_token,
            shutdown_token,
            child: Mutex::new(None),
            http_base_url: Mutex::new(Some(http_base)),
            ws_url: Mutex::new(Some(ws_url)),
            consecutive_failures: Mutex::new(0),
        }
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn current_ws_url(&self) -> Option<String> {
        self.ws_url.lock().ok().and_then(|g| g.clone())
    }

    pub fn current_http_base_url(&self) -> Option<String> {
        self.http_base_url.lock().ok().and_then(|g| g.clone())
    }

    fn allocate_ephemeral_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .map(|addr| addr.port())
            .unwrap_or(41820)
    }

    /// Resolves the compiled `saint-server` sidecar binary (Option 4A: `bun build --compile`)
    /// or falls back to `bun run apps/server/src/index.ts` in local development.
    fn resolve_server_command(
        &self,
        port: u16,
        bridge: &SidecarRuntimeBridgeConfig,
    ) -> Command {
        let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
        let exe_dir = current_exe
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));

        let sidecar_name = if cfg!(target_os = "windows") {
            "saint-server.exe"
        } else {
            "saint-server"
        };
        let bundled_sidecar = exe_dir.join(sidecar_name);

        let mut cmd = if !cfg!(debug_assertions) && bundled_sidecar.is_file() {
            let mut c = Command::new(bundled_sidecar);
            c.arg("--port").arg(port.to_string());
            c
        } else {
            // Development checkout fallback: invoke Mise `bun` on `apps/server/src/index.ts`.
            let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(|p| p.parent())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let server_entry = repo_root.join("apps/server/src/index.ts");
            let mut c = Command::new(resolve_bun_executable());
            c.arg("run")
                .arg(server_entry)
                .arg("--port")
                .arg(port.to_string())
                .current_dir(repo_root);
            c
        };

        let dev_url = std::env::var("VITE_DEV_SERVER_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                if cfg!(debug_assertions) {
                    Some("http://localhost:5733".to_string())
                } else {
                    None
                }
            });

        cmd.env("SAINT_MODE", "desktop")
            .env("SAINT_NO_BROWSER", "1")
            .env("SAINT_PORT", port.to_string())
            .env("SAINT_HOME", &self.paths.base_dir)
            .env("SAINT_AUTH_TOKEN", &self.auth_token)
            .env("SAINT_DESKTOP_SHUTDOWN_TOKEN", &self.shutdown_token)
            .env("SAINT_DESKTOP_BUNDLE_ID", crate::state::APP_BUNDLE_ID)
            .env("SAINT_DESKTOP_PARENT_PID", std::process::id().to_string())
            .env("SAINT_NATIVE_PTY_BACKEND", "rust-portable-pty")
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref dev_url) = dev_url {
            cmd.env("VITE_DEV_SERVER_URL", dev_url);
        }

        let static_dir = std::env::var("SAINT_STATIC_DIR")
            .ok()
            .map(|v| PathBuf::from(v.trim()))
            .filter(|p| p.join("index.html").is_file())
            .or_else(|| {
                let candidates = [
                    exe_dir.join("client"),
                    exe_dir.join("resources").join("client"),
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .and_then(|p| p.parent())
                        .map(|r| r.join("apps/web/dist"))
                        .unwrap_or_else(|| PathBuf::from("apps/web/dist")),
                ];
                candidates
                    .into_iter()
                    .find(|candidate| candidate.join("index.html").is_file())
            });
        if let Some(ref static_dir) = static_dir {
            cmd.env("SAINT_STATIC_DIR", static_dir);
        }

        if let Some(ref pipe_path) = bridge.browser_pipe_path {
            cmd.env("SAINT_BROWSER_HOST_PIPE_PATH", pipe_path)
                .env("SAINT_BROWSER_USE_PIPE_PATH", pipe_path);
        }
        if let Some(ref capability) = bridge.browser_capability {
            cmd.env("SAINT_BROWSER_HOST_CAPABILITY", capability);
        }
        if let Some(ref cua_socket) = bridge.cua_host_socket {
            cmd.env("SAINT_CUA_HOST_SOCKET", cua_socket);
        }
        if let (Some(pty_port), Some(ref pty_token)) =
            (bridge.pty_bridge_port, &bridge.pty_bridge_token)
        {
            if pty_port > 0 && !pty_token.is_empty() {
                cmd.env("SAINT_RUST_PTY_PORT", pty_port.to_string())
                    .env("SAINT_RUST_PTY_TOKEN", pty_token);
            }
        }

        #[cfg(target_os = "windows")]
        {
            // CREATE_NO_WINDOW = 0x08000000 so the sidecar never flashes a console window.
            cmd.creation_flags(0x0800_0000);
        }

        cmd
    }

    pub async fn start_and_wait_ready(
        &self,
        bridge: SidecarRuntimeBridgeConfig,
    ) -> Result<String, String> {
        if let Ok(guard) = self.child.lock() {
            if guard.is_some() {
                if let Some(existing_ws) = self.current_ws_url() {
                    return Ok(existing_ws);
                }
            }
        }

        let port = self.port;
        let http_base = format!("http://127.0.0.1:{port}");
        let ws_url = format!("ws://127.0.0.1:{port}/?token={}", self.auth_token);

        eprintln!(
            "[saint-desktop-rust] Starting saint-server on 127.0.0.1:{port} (home: {})",
            self.paths.base_dir.display()
        );

        let mut command = self.resolve_server_command(port, &bridge);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to spawn saint-server sidecar: {e}"))?;

        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[saint-server] {line}");
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[saint-server:err] {line}");
                }
            });
        }

        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }

        self.wait_for_http_ready(&http_base, Duration::from_secs(25))
            .await?;

        eprintln!("[saint-desktop-rust] saint-server is READY at {http_base}");

        if let Ok(mut guard) = self.http_base_url.lock() {
            *guard = Some(http_base);
        }
        if let Ok(mut guard) = self.ws_url.lock() {
            *guard = Some(ws_url.clone());
        }
        if let Ok(mut failures) = self.consecutive_failures.lock() {
            *failures = 0;
        }

        Ok(ws_url)
    }

    async fn wait_for_http_ready(&self, base_url: &str, timeout: Duration) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1500))
            .build()
            .map_err(|e| e.to_string())?;
        let health_url = format!("{base_url}/health");
        let deadline = tokio::time::Instant::now() + timeout;

        while tokio::time::Instant::now() < deadline {
            if let Ok(resp) = client.get(&health_url).send().await {
                if resp.status().is_success() || resp.status().is_client_error() || resp.status().is_server_error() {
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }

        if let Ok(mut failures) = self.consecutive_failures.lock() {
            *failures += 1;
        }
        Err(format!(
            "Timed out waiting for saint-server readiness at {base_url}"
        ))
    }

    pub async fn transcribe_voice(
        &self,
        input: VoiceTranscriptionInput,
    ) -> Result<VoiceTranscriptionResult, String> {
        let base_url = self
            .current_http_base_url()
            .ok_or_else(|| "Backend server is not ready".to_string())?;
        let endpoint = format!("{base_url}/api/voice/transcribe");
        let client = reqwest::Client::new();
        let response = client
            .post(endpoint)
            .json(&input)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !response.status().is_success() {
            return Err(format!(
                "Voice transcription failed with HTTP {}",
                response.status()
            ));
        }
        response
            .json::<VoiceTranscriptionResult>()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn stop_and_wait(&self) {
        let maybe_child = self.child.lock().ok().and_then(|mut g| g.take());
        let Some(mut child) = maybe_child else {
            return;
        };

        // Dropping stdin signals EOF to `desktopParentLifetime.ts` in `apps/server`
        // so the server begins graceful shutdown immediately.
        drop(child.stdin.take());

        let grace = Duration::from_secs(4);
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return;
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            if let Some(pid) = child.id() {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .status();
            }
        }

        let _ = child.kill().await;
    }

    pub fn kill_sync(&self) {
        let maybe_child = self.child.lock().ok().and_then(|mut g| g.take());
        let Some(mut child) = maybe_child else {
            return;
        };
        drop(child.stdin.take());
        #[cfg(target_os = "windows")]
        if let Some(pid) = child.id() {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .status();
        }
        let _ = child.start_kill();
    }
}

impl Drop for BackendSupervisor {
    fn drop(&mut self) {
        self.kill_sync();
    }
}
