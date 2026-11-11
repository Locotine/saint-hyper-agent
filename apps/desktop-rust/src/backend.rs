// FILE: backend.rs
// Purpose: Spawns and supervises the `apps/server` sidecar binary (`saint-server` compiled
//          via `bun build --compile` in production, or `bun run src/index.ts` in dev),
//          detects the listening HTTP/WS port, verifies readiness, and manages clean teardown.
// Layer: Desktop sidecar supervision (Option 1A+ / 4A).

use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::state::SaintPaths;

pub const BACKEND_MAX_CONSECUTIVE_START_FAILURES: u32 = 3;
pub const READINESS_SOFT_LOG_INTERVAL: Duration = Duration::from_secs(25);
pub const READINESS_MAX_CEILING: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTranscriptionInput {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub provider_instance_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub audio_base64: String,
    pub mime_type: String,
    #[serde(default)]
    pub sample_rate_hz: Option<u32>,
    #[serde(default)]
    pub duration_ms: Option<u32>,
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
    http_base_url: String,
    ws_url: String,
    ready: AtomicBool,
    shutting_down: AtomicBool,
    child_pid: AtomicU32,
    child: Mutex<Option<Child>>,
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
        // ponytail: Port is allocated once at supervisor creation so the window's
        // static initialization script keeps a stable endpoint across retries and
        // page reloads. Ceiling: a port taken between allocation and spawn fails
        // all retries; upgrade path is a dynamic bridge query for the URL.
        let port = Self::allocate_ephemeral_port();
        let auth_token = std::env::var("SAINT_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()));
        let shutdown_token = uuid::Uuid::new_v4().simple().to_string();
        let http_base_url = format!("http://127.0.0.1:{port}");
        let ws_url = format!("ws://127.0.0.1:{port}/?token={auth_token}");

        Self {
            paths,
            port,
            auth_token,
            shutdown_token,
            http_base_url,
            ws_url,
            ready: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            child: Mutex::new(None),
        }
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    pub fn current_ws_url(&self) -> &str {
        &self.ws_url
    }

    pub fn current_http_base_url(&self) -> &str {
        &self.http_base_url
    }

    pub fn is_child_running(&self) -> bool {
        self.check_child_exited().is_none()
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
        let sidecar_candidates = [
            exe_dir.join(sidecar_name),
            exe_dir.join("binaries").join(sidecar_name),
            exe_dir.join("..").join("Resources").join(sidecar_name),
            exe_dir
                .join("..")
                .join("Resources")
                .join("binaries")
                .join(sidecar_name),
        ];
        let bundled_sidecar = sidecar_candidates.into_iter().find(|p| p.is_file());

        let mut cmd = if !cfg!(debug_assertions) {
            if let Some(sidecar_path) = bundled_sidecar {
                let mut c = Command::new(sidecar_path);
                c.arg("--port").arg(port.to_string());
                c
            } else {
                let mut c = Command::new(exe_dir.join(sidecar_name));
                c.arg("--port").arg(port.to_string());
                c
            }
        } else if let Some(sidecar_path) = bundled_sidecar {
            let mut c = Command::new(sidecar_path);
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
            .env("SAINT_DESKTOP_PARENT_STDIN", "1")
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
                let mut candidates = vec![
                    exe_dir.join("client"),
                    exe_dir.join("resources").join("client"),
                    exe_dir.join("..").join("Resources").join("client"),
                    exe_dir.join("..").join("Resources").join("resources").join("client"),
                ];
                if cfg!(debug_assertions) {
                    candidates.push(
                        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                            .parent()
                            .and_then(|p| p.parent())
                            .map(|r| r.join("apps/web/dist"))
                            .unwrap_or_else(|| PathBuf::from("apps/web/dist")),
                    );
                }
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

        #[cfg(unix)]
        {
            // Spawn the sidecar in its own process group (PGID = child PID) so
            // kill_process_tree can terminate the entire sidecar process group.
            cmd.process_group(0);
        }

        cmd
    }

    fn take_child_from_guard(&self, guard: &mut Option<Child>) -> Option<(Child, Option<u32>)> {
        let child = guard.take()?;
        let stored_pid = self.child_pid.swap(0, Ordering::SeqCst);
        let pid = if stored_pid != 0 {
            Some(stored_pid)
        } else {
            child.id()
        };
        Some((child, pid))
    }

    fn take_child_with_pid(&self) -> Option<(Child, Option<u32>)> {
        let mut guard = self.child.lock().ok()?;
        self.take_child_from_guard(&mut guard)
    }

    async fn abort_child<T>(&self, err: impl Into<String>) -> Result<T, String> {
        let taken = self.take_child_with_pid();
        self.ready.store(false, Ordering::SeqCst);
        if let Some((mut aborted, pid)) = taken {
            Self::force_kill_child(&mut aborted, pid).await;
        }
        Err(err.into())
    }

    pub async fn start_and_wait_ready(
        &self,
        bridge: SidecarRuntimeBridgeConfig,
    ) -> Result<String, String> {
        if self.is_shutting_down() {
            return Err("Backend supervisor is shutting down".to_string());
        }

        let mut stale_child = None;
        let mut already_running = false;
        if let Ok(mut guard) = self.child.lock() {
            let child_running = match guard.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => false,
            };
            if let Some(existing_ws) =
                resolve_cached_running_ws_url(child_running, self.is_ready(), &self.ws_url)
            {
                return Ok(existing_ws);
            }
            if child_running {
                already_running = true;
            } else {
                stale_child = self.take_child_from_guard(&mut guard);
            }
        }
        self.ready.store(false, Ordering::SeqCst);
        if let Some((mut stale, pid)) = stale_child {
            Self::force_kill_child(&mut stale, pid).await;
        }
        if self.is_shutting_down() {
            return Err("Backend supervisor is shutting down".to_string());
        }

        let port = self.port;
        let http_base = self.http_base_url.clone();
        let ws_url = self.ws_url.clone();

        if !already_running {
            eprintln!(
                "[saint-desktop-rust] Starting saint-server on 127.0.0.1:{port} (home: {})",
                self.paths.base_dir.display()
            );

            let mut command = self.resolve_server_command(port, &bridge);
            {
                let mut guard = self
                    .child
                    .lock()
                    .map_err(|_| "Backend supervisor child lock poisoned".to_string())?;
                if self.is_shutting_down() {
                    return Err("Backend supervisor is shutting down".to_string());
                }
                let mut child = command
                    .spawn()
                    .map_err(|e| format!("Failed to spawn saint-server sidecar: {e}"))?;
                self.child_pid
                    .store(child.id().unwrap_or(0), Ordering::SeqCst);

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

                *guard = Some(child);
            }
        }

        if self.is_shutting_down() {
            return self.abort_child("Backend supervisor is shutting down").await;
        }

        if let Err(err) = self
            .wait_for_http_ready(
                &http_base,
                READINESS_SOFT_LOG_INTERVAL,
                READINESS_MAX_CEILING,
            )
            .await
        {
            if self.is_shutting_down() || !self.is_child_running() {
                return self.abort_child(err).await;
            }
            return Err(err);
        }

        if self.is_shutting_down() {
            return self.abort_child("Backend supervisor is shutting down").await;
        }

        eprintln!("[saint-desktop-rust] saint-server is READY at {http_base}");

        self.ready.store(true, Ordering::SeqCst);

        Ok(ws_url)
    }

    fn check_child_exited(&self) -> Option<String> {
        let mut guard = match self.child.lock() {
            Ok(guard) => guard,
            Err(_) => return Some("Backend supervisor child lock poisoned".to_string()),
        };
        let Some(child) = guard.as_mut() else {
            return Some("saint-server process is not running".to_string());
        };
        match child.try_wait() {
            Ok(Some(status)) => Some(format!(
                "saint-server exited before becoming ready (status: {status})"
            )),
            Ok(None) => None,
            Err(err) => Some(format!("Failed to poll saint-server child process: {err}")),
        }
    }

    pub(crate) fn kill_process_tree(pid: u32) {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000)
                .status();
        }
        #[cfg(unix)]
        {
            let Ok(pgid) = libc::pid_t::try_from(pid) else {
                return;
            };
            if pgid <= 0 {
                return;
            }
            // SAFETY: killpg signals the process group `pgid` created via `process_group(0)`.
            let term_rc = unsafe { libc::killpg(pgid, libc::SIGTERM) };
            if term_rc != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            let deadline = std::time::Instant::now() + Duration::from_millis(250);
            while std::time::Instant::now() < deadline {
                // Reap the process group leader if it has already exited so a zombie
                // leader does not keep `killpg(pgid, 0)` succeeding for the full 250ms.
                let mut status: libc::c_int = 0;
                let _ = unsafe { libc::waitpid(pgid, &mut status, libc::WNOHANG) };
                let probe_rc = unsafe { libc::killpg(pgid, 0) };
                if probe_rc != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            unsafe {
                let _ = libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }

    async fn force_kill_child(child: &mut Child, pid: Option<u32>) {
        drop(child.stdin.take());
        if let Some(pid) = pid.or_else(|| child.id()) {
            let _ = tokio::task::spawn_blocking(move || {
                Self::kill_process_tree(pid);
            })
            .await;
        }
        let _ = child.kill().await;
    }

    async fn wait_for_http_ready(
        &self,
        base_url: &str,
        soft_timeout: Duration,
        max_ceiling: Duration,
    ) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(1500))
            .build()
            .map_err(|e| e.to_string())?;
        let health_url = format!("{base_url}/health");
        let start = tokio::time::Instant::now();
        let ceiling_deadline = start + max_ceiling;
        let soft_step = if soft_timeout.is_zero() {
            READINESS_SOFT_LOG_INTERVAL
        } else {
            soft_timeout
        };
        let mut next_soft_log = start + soft_step;

        while tokio::time::Instant::now() < ceiling_deadline {
            if self.is_shutting_down() {
                return Err("Backend supervisor is shutting down".to_string());
            }
            if let Some(exit_err) = self.check_child_exited() {
                return Err(exit_err);
            }
            if let Ok(resp) = client.get(&health_url).send().await {
                if resp.status().is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    let still_starting = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|val| val.get("startupReady").and_then(|v| v.as_bool()))
                        == Some(false);
                    if !still_starting {
                        return Ok(());
                    }
                }
            }
            let now = tokio::time::Instant::now();
            if now >= next_soft_log {
                eprintln!(
                    "[saint-desktop-rust] saint-server is still starting at {base_url} ({:?} elapsed)...",
                    start.elapsed()
                );
                while next_soft_log <= now {
                    next_soft_log += soft_step;
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }

        Err(format!(
            "Timed out waiting for saint-server readiness at {base_url}"
        ))
    }

    pub async fn transcribe_voice(
        &self,
        input: VoiceTranscriptionInput,
    ) -> Result<VoiceTranscriptionResult, String> {
        use base64::Engine as _;

        if !self.is_ready() {
            return Err("Backend server is not ready".to_string());
        }
        let base_url = self.current_http_base_url();
        let audio_bytes = base64::engine::general_purpose::STANDARD
            .decode(input.audio_base64.trim())
            .map_err(|e| format!("Invalid audioBase64 payload: {e}"))?;

        let mut query_params: Vec<(&str, String)> = vec![
            ("mimeType", input.mime_type.clone()),
            ("token", self.auth_token.clone()),
        ];
        if let Some(provider) = &input.provider {
            query_params.push(("provider", provider.clone()));
        }
        if let Some(provider_instance_id) = &input.provider_instance_id {
            query_params.push(("providerInstanceId", provider_instance_id.clone()));
        }
        if let Some(cwd) = &input.cwd {
            query_params.push(("cwd", cwd.clone()));
        }
        if let Some(thread_id) = &input.thread_id {
            query_params.push(("threadId", thread_id.clone()));
        }
        if let Some(sample_rate_hz) = input.sample_rate_hz {
            query_params.push(("sampleRateHz", sample_rate_hz.to_string()));
        }
        if let Some(duration_ms) = input.duration_ms {
            query_params.push(("durationMs", duration_ms.to_string()));
        }
        if let Some(language) = &input.language {
            query_params.push(("language", language.clone()));
        }

        let endpoint = format!("{base_url}/api/voice/transcribe");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .post(endpoint)
            .query(&query_params)
            .header(reqwest::header::CONTENT_TYPE, input.mime_type)
            .header(reqwest::header::ORIGIN, base_url)
            .bearer_auth(&self.auth_token)
            .body(audio_bytes)
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
        self.begin_shutdown();
        let Some((mut child, pid)) = self.take_child_with_pid() else {
            return;
        };

        // Dropping stdin signals EOF to `desktopParentLifetime.ts` in `apps/server`
        // so the server begins graceful shutdown immediately.
        drop(child.stdin.take());

        let shutdown_url = format!("{}/api/desktop/shutdown", self.current_http_base_url());
        let shutdown_token = self.shutdown_token.clone();
        tokio::spawn(async move {
            if let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
            {
                let _ = client
                    .post(shutdown_url)
                    .bearer_auth(shutdown_token)
                    .send()
                    .await;
            }
        });

        let grace = Duration::from_secs(4);
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            #[cfg(unix)]
            if let Some(pid) = pid {
                let _ = tokio::task::spawn_blocking(move || {
                    Self::kill_process_tree(pid);
                })
                .await;
            }
            return;
        }

        Self::force_kill_child(&mut child, pid).await;
    }

    pub fn kill_sync(&self) {
        self.begin_shutdown();
        let Some((mut child, pid)) = self.take_child_with_pid() else {
            return;
        };
        drop(child.stdin.take());
        if let Some(pid) = pid {
            Self::kill_process_tree(pid);
        }
        let _ = child.start_kill();
    }
}

pub fn resolve_cached_running_ws_url(
    child_running: bool,
    ready: bool,
    ws_url: &str,
) -> Option<String> {
    if child_running && ready && !ws_url.is_empty() {
        Some(ws_url.to_owned())
    } else {
        None
    }
}

impl Drop for BackendSupervisor {
    fn drop(&mut self) {
        self.kill_sync();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn cached_ws_url_returned_only_when_child_running_and_ready() {
        let ws = "ws://127.0.0.1:41820/?token=abc";

        assert_eq!(
            resolve_cached_running_ws_url(true, true, ws).as_deref(),
            Some(ws)
        );
        assert_eq!(resolve_cached_running_ws_url(false, true, ws), None);
        assert_eq!(resolve_cached_running_ws_url(true, false, ws), None);
        assert_eq!(resolve_cached_running_ws_url(true, true, ""), None);
    }

    #[tokio::test]
    async fn backend_supervisor_exposes_precomputed_urls_and_rejects_transcribe_until_ready() {
        let root = std::env::temp_dir().join(format!(
            "saint-backend-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = SaintPaths::from_base_dir(root.clone());
        let supervisor = BackendSupervisor::new(paths);

        assert!(!supervisor.is_ready());
        assert!(supervisor
            .current_http_base_url()
            .starts_with("http://127.0.0.1:"));
        assert!(supervisor.current_ws_url().starts_with("ws://127.0.0.1:"));

        let err = supervisor
            .transcribe_voice(VoiceTranscriptionInput {
                provider: None,
                provider_instance_id: None,
                cwd: None,
                thread_id: None,
                audio_base64: "AA==".to_string(),
                mime_type: "audio/webm".to_string(),
                sample_rate_hz: None,
                duration_ms: None,
                language: None,
            })
            .await
            .expect_err("must reject when backend server is not ready");
        assert_eq!(err, "Backend server is not ready");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn wait_for_http_ready_requires_2xx_and_fails_fast_when_child_exits() {
        let root = std::env::temp_dir().join(format!(
            "saint-backend-ready-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = SaintPaths::from_base_dir(root.clone());
        let supervisor = BackendSupervisor::new(paths);

        // 1. When no child is running, wait_for_http_ready fails fast without waiting for timeout.
        let start = tokio::time::Instant::now();
        let err = supervisor
            .wait_for_http_ready(
                "http://127.0.0.1:9",
                Duration::from_secs(25),
                Duration::from_secs(600),
            )
            .await
            .expect_err("must fail fast when child is not running");
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(err.contains("not running"));

        // 2. Spawn a long-lived child and verify 503 is not accepted, then 200 succeeds.
        #[cfg(target_os = "windows")]
        let child = Command::new("cmd.exe")
            .args(["/C", "ping -n 10 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 10"])
            .spawn()
            .unwrap();
        *supervisor.child.lock().unwrap() = Some(child);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for response_raw in [
                "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 42\r\nConnection: close\r\n\r\n{\"status\":\"starting\",\"startupReady\":false}",
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 35\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"startupReady\":true}",
            ] {
                if let Ok((mut socket, _)) = listener.accept().await {
                    let mut buf = [0u8; 512];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(response_raw.as_bytes()).await;
                }
            }
        });

        supervisor
            .wait_for_http_ready(
                &format!("http://127.0.0.1:{port}"),
                Duration::from_secs(5),
                Duration::from_secs(30),
            )
            .await
            .expect("must succeed once 200 OK with startupReady: true is returned");

        supervisor.stop_and_wait().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn slow_starting_child_past_soft_timeout_is_not_killed_and_succeeds_when_health_turns_2xx() {
        let root = std::env::temp_dir().join(format!(
            "saint-backend-slow-start-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = SaintPaths::from_base_dir(root.clone());
        let supervisor = BackendSupervisor::new(paths);

        #[cfg(target_os = "windows")]
        let child = Command::new("cmd.exe")
            .args(["/C", "ping -n 10 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 10"])
            .spawn()
            .unwrap();
        let initial_pid = child.id().expect("fake child must have pid");
        supervisor.child_pid.store(initial_pid, Ordering::SeqCst);
        *supervisor.child.lock().unwrap() = Some(child);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let start = tokio::time::Instant::now();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 512];
                let _ = socket.read(&mut buf).await;
                // Stay non-2xx past multiple soft-timeout intervals (300ms > 3 * 80ms) before turning 200 OK.
                if start.elapsed() < Duration::from_millis(320) {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                } else {
                    let _ = socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                        )
                        .await;
                    break;
                }
            }
        });

        supervisor
            .wait_for_http_ready(
                &format!("http://127.0.0.1:{port}"),
                Duration::from_millis(80),
                Duration::from_secs(10),
            )
            .await
            .expect("must keep polling past soft timeout while child is alive and succeed when /health turns 200");

        assert!(
            supervisor.is_child_running(),
            "child must remain alive and not be killed across soft timeouts"
        );
        assert_eq!(supervisor.child_pid.load(Ordering::SeqCst), initial_pid);

        supervisor.stop_and_wait().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn endpoint_stays_stable_and_shutdown_guard_blocks_start() {
        let root = std::env::temp_dir().join(format!(
            "saint-backend-shutdown-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = SaintPaths::from_base_dir(root.clone());
        let supervisor = BackendSupervisor::new(paths);

        let initial_port = supervisor.port();
        let initial_http = supervisor.current_http_base_url().to_string();
        let initial_ws = supervisor.current_ws_url().to_string();

        supervisor.begin_shutdown();
        assert!(supervisor.is_shutting_down());
        let err = supervisor
            .start_and_wait_ready(SidecarRuntimeBridgeConfig::default())
            .await
            .expect_err("must refuse to start after shutdown has begun");
        assert!(err.contains("shutting down"));
        assert!(supervisor.child.lock().unwrap().is_none());
        assert_eq!(supervisor.port(), initial_port);
        assert_eq!(supervisor.current_http_base_url(), initial_http);
        assert_eq!(supervisor.current_ws_url(), initial_ws);

        // Verify abort_child clears ready, takes child + stored pid, and kills the child.
        #[cfg(target_os = "windows")]
        let child = Command::new("cmd.exe")
            .args(["/C", "ping -n 10 127.0.0.1 >nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .unwrap();
        #[cfg(not(target_os = "windows"))]
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 10"])
            .process_group(0)
            .spawn()
            .unwrap();
        supervisor
            .child_pid
            .store(child.id().unwrap_or(0), Ordering::SeqCst);
        supervisor.ready.store(true, Ordering::SeqCst);
        *supervisor.child.lock().unwrap() = Some(child);

        let abort_res: Result<(), String> = supervisor.abort_child("aborted for test").await;
        assert_eq!(abort_res, Err("aborted for test".to_string()));
        assert!(!supervisor.is_ready());
        assert_eq!(supervisor.child_pid.load(Ordering::SeqCst), 0);
        assert!(supervisor.child.lock().unwrap().is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_kill_process_tree_terminates_process_group_descendants() {
        let mut group_leader = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pgid = group_leader.id().expect("group leader must have pid");
        tokio::time::sleep(Duration::from_millis(50)).await;

        BackendSupervisor::kill_process_tree(pgid);
        let _ = group_leader.wait().await;
        let probe_rc = unsafe { libc::killpg(pgid as libc::pid_t, 0) };
        assert_ne!(probe_rc, 0, "process group must no longer exist");
    }
}
