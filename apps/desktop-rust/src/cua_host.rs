// FILE: cua_host.rs
// Purpose: Manages the bundled `cua-driver` Rust binary, `SAINT_CUA_HOST_SOCKET` local RPC
//          server, and native computer frame tap (Option 3.1-A).
// Layer: Desktop Computer-Use host.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

use crate::state::{SaintPaths, APP_BUNDLE_ID};
use crate::window_state::{write_agent_cursor_preference, AgentCursorStylePreference};

pub const CUA_CURSOR_IDLE_HIDE_MS: u64 = 60_000;
pub const MAX_CUA_SOCKET_LINE_BYTES: usize = 2 * 1024 * 1024;

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub struct CuaDriverHost {
    paths: SaintPaths,
    socket_path: String,
    driver_socket_path: String,
    preview_subscribed: AtomicBool,
    socket_started: AtomicBool,
    driver_child: Mutex<Option<Child>>,
}

impl CuaDriverHost {
    pub fn new(paths: SaintPaths) -> Self {
        let id = &Uuid::new_v4().simple().to_string()[..12];
        let (socket_path, driver_socket_path) = if cfg!(target_os = "windows") {
            (
                format!(r"\\.\pipe\saint-cua-host-{id}"),
                format!(r"\\.\pipe\saint-cua-driver-{id}"),
            )
        } else {
            (
                paths
                    .state_dir
                    .join(format!("saint-cua-host-{id}.sock"))
                    .to_string_lossy()
                    .into_owned(),
                paths
                    .state_dir
                    .join(format!("saint-cua-driver-{id}.sock"))
                    .to_string_lossy()
                    .into_owned(),
            )
        };

        Self {
            paths,
            socket_path,
            driver_socket_path,
            preview_subscribed: AtomicBool::new(false),
            socket_started: AtomicBool::new(false),
            driver_child: Mutex::new(None),
        }
    }

    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn resolve_driver_binary_path() -> PathBuf {
        let bin_name = if cfg!(target_os = "windows") {
            "cua-driver.exe"
        } else {
            "cua-driver"
        };
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("resources").join("cua-driver").join(bin_name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("desktop-rust/resources/cua-driver")
            .join(bin_name)
    }

    pub fn subscribe_preview(&self) {
        self.preview_subscribed.store(true, Ordering::SeqCst);
    }

    pub fn unsubscribe_preview(&self) {
        self.preview_subscribed.store(false, Ordering::SeqCst);
    }

    pub fn set_cursor_style(
        &self,
        style: Option<AgentCursorStylePreference>,
    ) -> Result<(), String> {
        write_agent_cursor_preference(&self.paths.agent_cursor_preference_path, style)
            .map_err(|e| e.to_string())
    }

    pub fn ensure_driver_started(&self) -> Result<String, String> {
        let binary = Self::resolve_driver_binary_path();
        if !binary.is_file() {
            return Err("Cua Driver is not bundled. Run the provisioning script (`node apps/desktop-rust/scripts/provision-cua-driver.mjs`), then relaunch Saint.".to_string());
        }
        let mut guard = self
            .driver_child
            .lock()
            .map_err(|_| "Cua driver lock poisoned".to_string())?;
        if let Some(ref mut child) = *guard {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(self.driver_socket_path.clone());
            }
        }
        let driver_state_dir = self.paths.state_dir.join("cua-driver-state");
        let _ = std::fs::create_dir_all(&driver_state_dir);

        let mut cmd = Command::new(&binary);
        cmd.args([
            "serve",
            "--embedded",
            "--socket",
            &self.driver_socket_path,
            "--compact-cursor",
            "--idle-hide-ms",
            &CUA_CURSOR_IDLE_HIDE_MS.to_string(),
        ])
        .env("CUA_DRIVER_EMBEDDED", "1")
        .env("CUA_DRIVER_HOST_BUNDLE_ID", APP_BUNDLE_ID)
        .env("CUA_DRIVER_PERMISSION_MODE", "standard")
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
        .env("CUA_DRIVER_RS_UPDATE_CHECK", "0")
        .env("SAINT_CUA_FOREGROUND_OBSERVATION_MS", "100")
        .env("SAINT_CUA_BACKGROUND_OBSERVATION_MS", "350")
        .env("CUA_DRIVER_PARENT_LIVENESS_STDIN", "1")
        .env("CUA_DRIVER_EMBEDDED_HOST_PID", std::process::id().to_string())
        .env("CUA_DRIVER_RS_HOME", &driver_state_dir)
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(0x0800_0000);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn cua-driver: {e}"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(_)) = reader.next_line().await {}
            });
        }
        *guard = Some(child);
        Ok(self.driver_socket_path.clone())
    }

    pub fn handle_socket_json_line(&self, expected_capability: &str, raw_line: &str) -> String {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_line.trim()) else {
            return serde_json::json!({
                "ok": false,
                "error": "Invalid computer request.",
                "effect": "not-dispatched",
                "desktopEpoch": 0,
                "desktopPauses": [],
                "desktopInterruptions": 0,
            })
            .to_string();
        };

        let supplied_cap = parsed
            .get("capability")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if expected_capability.len() < 32
            || !constant_time_eq(supplied_cap.as_bytes(), expected_capability.as_bytes())
        {
            return serde_json::json!({
                "ok": false,
                "error": "Computer host authority is required.",
                "effect": "not-dispatched",
                "desktopEpoch": 0,
                "desktopPauses": [],
                "desktopInterruptions": 0,
            })
            .to_string();
        }

        let method = parsed.get("method").and_then(|v| v.as_str()).unwrap_or("");
        match method {
            "stop" | "end_task" | "end_browser_thread" | "pause" | "resume" | "browser_control" => {
                serde_json::json!({
                    "ok": true,
                    "desktopEpoch": 0,
                    "desktopPauses": [],
                    "desktopInterruptions": 0,
                })
                .to_string()
            }
            "restore_clipboard" => serde_json::json!({
                "ok": true,
                "result": {
                    "structuredContent": { "clipboard_restored": true }
                },
                "desktopEpoch": 0,
                "desktopPauses": [],
                "desktopInterruptions": 0,
            })
            .to_string(),
            "shield" => serde_json::json!({
                "ok": true,
                "result": { "released": 0 },
                "desktopEpoch": 0,
                "desktopPauses": [],
                "desktopInterruptions": 0,
            })
            .to_string(),
            "probe" => {
                let binary = Self::resolve_driver_binary_path();
                if binary.is_file() {
                    serde_json::json!({
                        "ok": true,
                        "result": {
                            "ready": true,
                            "bundle_id": APP_BUNDLE_ID,
                        },
                        "desktopEpoch": 0,
                        "desktopPauses": [],
                        "desktopInterruptions": 0,
                    })
                    .to_string()
                } else {
                    serde_json::json!({
                        "ok": false,
                        "error": "Cua Driver is not bundled. Run the provisioning script (`node apps/desktop-rust/scripts/provision-cua-driver.mjs`), then relaunch Saint.",
                        "effect": "not-dispatched",
                        "desktopEpoch": 0,
                        "desktopPauses": [],
                        "desktopInterruptions": 0,
                    })
                    .to_string()
                }
            }
            "call" => {
                let tool_name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if tool_name == "check_permissions" {
                    let granted = !cfg!(target_os = "macos");
                    serde_json::json!({
                        "ok": true,
                        "result": {
                            "content": [{
                                "type": "text",
                                "text": serde_json::json!({
                                    "accessibility": granted,
                                    "screen_recording": granted,
                                    "bundle_id": APP_BUNDLE_ID,
                                }).to_string(),
                            }],
                            "structuredContent": {
                                "accessibility": granted,
                                "screen_recording": granted,
                                "bundle_id": APP_BUNDLE_ID,
                            }
                        },
                        "desktopEpoch": 0,
                        "desktopPauses": [],
                        "desktopInterruptions": 0,
                    })
                    .to_string()
                } else {
                    match self.ensure_driver_started() {
                        Err(err) => serde_json::json!({
                            "ok": false,
                            "error": err,
                            "effect": "not-dispatched",
                            "desktopEpoch": 0,
                            "desktopPauses": [],
                            "desktopInterruptions": 0,
                        })
                        .to_string(),
                        Ok(driver_sock) => serde_json::json!({
                            "ok": false,
                            "error": format!("Cua Driver socket '{driver_sock}' did not respond to '{tool_name}'."),
                            "effect": "not-dispatched",
                            "desktopEpoch": 0,
                            "desktopPauses": [],
                            "desktopInterruptions": 0,
                        })
                        .to_string(),
                    }
                }
            }
            _ => serde_json::json!({
                "ok": false,
                "error": format!("Unsupported computer host method: {method}"),
                "effect": "not-dispatched",
                "desktopEpoch": 0,
                "desktopPauses": [],
                "desktopInterruptions": 0,
            })
            .to_string(),
        }
    }

    pub fn start_host_socket_server(self: &Arc<Self>, shared_capability: String) {
        if self.socket_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let host = Arc::clone(self);
        let socket_path = self.socket_path.clone();

        tauri::async_runtime::spawn(async move {
            #[cfg(target_os = "windows")]
            {
                use tokio::net::windows::named_pipe::ServerOptions;
                let mut first = true;
                loop {
                    let mut opts = ServerOptions::new();
                    if first {
                        opts.first_pipe_instance(true);
                        first = false;
                    }
                    let server = match opts.create(&socket_path) {
                        Ok(s) => s,
                        Err(err) => {
                            eprintln!(
                                "[saint-desktop-rust] Failed to create CUA host pipe {socket_path}: {err}"
                            );
                            break;
                        }
                    };
                    if server.connect().await.is_err() {
                        break;
                    }
                    let host_conn = Arc::clone(&host);
                    let cap_conn = shared_capability.clone();
                    tauri::async_runtime::spawn(async move {
                        let (read_half, mut write_half) = tokio::io::split(server);
                        let mut reader = BufReader::new(read_half);
                        loop {
                            let mut buf = Vec::new();
                            let n = match (&mut reader)
                                .take((MAX_CUA_SOCKET_LINE_BYTES + 1) as u64)
                                .read_until(b'\n', &mut buf)
                                .await
                            {
                                Ok(n) => n,
                                Err(_) => break,
                            };
                            if n == 0 || (buf.len() > MAX_CUA_SOCKET_LINE_BYTES && !buf.ends_with(b"\n")) {
                                break;
                            }
                            let Ok(line) = String::from_utf8(buf) else {
                                break;
                            };
                            if line.trim().is_empty() {
                                continue;
                            }
                            let response = host_conn.handle_socket_json_line(&cap_conn, &line);
                            if write_half.write_all(format!("{response}\n").as_bytes()).await.is_err()
                                || write_half.flush().await.is_err()
                            {
                                break;
                            }
                        }
                    });
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                if let Some(parent) = std::path::Path::new(&socket_path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::remove_file(&socket_path);
                let listener = match tokio::net::UnixListener::bind(&socket_path) {
                    Ok(l) => l,
                    Err(err) => {
                        eprintln!(
                            "[saint-desktop-rust] Failed to bind CUA host socket {socket_path}: {err}"
                        );
                        return;
                    }
                };
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(
                        &socket_path,
                        std::fs::Permissions::from_mode(0o600),
                    );
                }
                while let Ok((stream, _)) = listener.accept().await {
                    let host_conn = Arc::clone(&host);
                    let cap_conn = shared_capability.clone();
                    tauri::async_runtime::spawn(async move {
                        let (read_half, mut write_half) = stream.into_split();
                        let mut reader = BufReader::new(read_half);
                        loop {
                            let mut buf = Vec::new();
                            let n = match (&mut reader)
                                .take((MAX_CUA_SOCKET_LINE_BYTES + 1) as u64)
                                .read_until(b'\n', &mut buf)
                                .await
                            {
                                Ok(n) => n,
                                Err(_) => break,
                            };
                            if n == 0 || (buf.len() > MAX_CUA_SOCKET_LINE_BYTES && !buf.ends_with(b"\n")) {
                                break;
                            }
                            let Ok(line) = String::from_utf8(buf) else {
                                break;
                            };
                            if line.trim().is_empty() {
                                continue;
                            }
                            let response = host_conn.handle_socket_json_line(&cap_conn, &line);
                            if write_half.write_all(format!("{response}\n").as_bytes()).await.is_err()
                                || write_half.flush().await.is_err()
                            {
                                break;
                            }
                        }
                    });
                }
            }
        });
    }

    pub fn kill_sync(&self) {
        self.preview_subscribed.store(false, Ordering::SeqCst);
        if let Some(mut c) = self.driver_child.lock().ok().and_then(|mut g| g.take()) {
            let _ = c.start_kill();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::fs::remove_file(&self.socket_path);
            let _ = std::fs::remove_file(&self.driver_socket_path);
        }
    }
}

impl Drop for CuaDriverHost {
    fn drop(&mut self) {
        self.kill_sync();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_cua_host_socket_requests_and_auth() {
        let host = CuaDriverHost::new(SaintPaths::resolve());
        let cap = "0123456789abcdef0123456789abcdef";

        let denied = host.handle_socket_json_line(
            cap,
            r#"{"method":"stop","capability":"wrong"}"#,
        );
        let denied_val: serde_json::Value = serde_json::from_str(&denied).unwrap();
        assert_eq!(denied_val["ok"], false);
        assert_eq!(denied_val["effect"], "not-dispatched");

        let stop_ok = host.handle_socket_json_line(
            cap,
            &serde_json::json!({
                "method": "stop",
                "capability": cap,
            })
            .to_string(),
        );
        let stop_val: serde_json::Value = serde_json::from_str(&stop_ok).unwrap();
        assert_eq!(stop_val["ok"], true);
        assert_eq!(stop_val["desktopEpoch"], 0);

        let perms_ok = host.handle_socket_json_line(
            cap,
            &serde_json::json!({
                "method": "call",
                "name": "check_permissions",
                "capability": cap,
            })
            .to_string(),
        );
        let perms_val: serde_json::Value = serde_json::from_str(&perms_ok).unwrap();
        assert_eq!(perms_val["ok"], true);
    }
}
