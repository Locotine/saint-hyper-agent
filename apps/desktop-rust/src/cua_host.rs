// FILE: cua_host.rs
// Purpose: Manages the bundled `cua-driver` Rust binary, `SAINT_CUA_HOST_SOCKET` local RPC
//          server, bidirectional driver proxy, safety/shield state, and native computer
//          frame tap (`computerPreview.frame`).
// Layer: Desktop Computer-Use host.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use uuid::Uuid;

use crate::state::{SaintPaths, APP_BUNDLE_ID};
use crate::window_state::{write_agent_cursor_preference, AgentCursorStylePreference};

pub const CUA_CURSOR_IDLE_HIDE_MS: u64 = 60_000;
pub const MAX_CUA_SOCKET_LINE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CUA_DRIVER_RESPONSE_BYTES: usize = 96 * 1024 * 1024;
const DRIVER_CONNECT_MAX_WAIT: Duration = Duration::from_secs(5);
const DRIVER_CONNECT_RETRY_INTERVAL: Duration = Duration::from_millis(50);
const DRIVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DRIVER_CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
const PREVIEW_TAP_POLL_INTERVAL: Duration = Duration::from_millis(500);
const SHIELD_MAX_EXTENT: f64 = 32_768.0;
const SHIELD_MAX_COORDINATE: f64 = 1_000_000.0;

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

fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

fn is_browser_tool(name: &str) -> bool {
    matches!(
        name,
        "get_browser_state"
            | "browser_prepare"
            | "browser_navigate"
            | "browser_click"
            | "browser_type"
            | "browser_dialog"
            | "browser_set_input_files"
            | "browser_download"
            | "browser_pointer"
    )
}

fn is_mutating_tool(name: &str) -> bool {
    matches!(
        name,
        "click"
            | "move_cursor"
            | "drag"
            | "scroll"
            | "type_text"
            | "press_key"
            | "hotkey"
            | "set_value"
            | "select_text"
            | "clipboard_read"
            | "clipboard_write"
            | "launch_app"
            | "bring_to_front"
            | "invoke_menu"
            | "set_window_frame"
            | "set_window_minimized"
            | "set_app_visibility"
            | "kill_app"
            | "browser_prepare"
            | "browser_navigate"
            | "browser_click"
            | "browser_type"
            | "browser_dialog"
            | "browser_set_input_files"
            | "browser_download"
            | "browser_pointer"
    )
}

fn is_valid_shield_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[derive(Clone, Debug)]
struct ActiveShield {
    thread_id: Option<String>,
    turn_id: Option<String>,
}

#[derive(Clone, Debug)]
struct PreviewTarget {
    window_id: u64,
    thread_id: Option<String>,
}

#[derive(Clone, Debug)]
struct ActiveTaskRecord {
    thread_id: String,
    turn_id: Option<String>,
}

#[derive(Default)]
struct DriverMetadataState {
    handshaken: bool,
    native_revision: Option<u64>,
    browser_input_control: bool,
    driver_pid: Option<u32>,
    input_epoch: u64,
}

#[derive(Default)]
struct HostControlState {
    desktop_epoch: u64,
    desktop_interruptions: u64,
    desktop_pauses: BTreeSet<String>,
    admission_closed: bool,
    admission_closed_reason: Option<String>,
    shields: HashMap<String, ActiveShield>,
    active_tasks: HashMap<String, ActiveTaskRecord>,
    preview_target: Option<PreviewTarget>,
    metadata: DriverMetadataState,
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub struct ComputerPreviewFrameEvent {
    pub window_id: u64,
    pub seq: u64,
    pub jpeg: Vec<u8>,
}

enum DriverRpcError {
    NotDispatched(String),
    DispatchedUnknown(String),
}

pub struct CuaDriverHost {
    paths: SaintPaths,
    socket_path: String,
    driver_socket_path: String,
    external_driver_socket: bool,
    preview_subscribed: AtomicBool,
    preview_loop_running: AtomicBool,
    preview_seq: AtomicU64,
    socket_started: AtomicBool,
    driver_child: Mutex<Option<Child>>,
    control: Mutex<HostControlState>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    #[cfg(test)]
    test_preview_sink: Mutex<Option<Arc<Mutex<Vec<ComputerPreviewFrameEvent>>>>>,
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
            const MAX_UNIX_SOCKET_PATH_BYTES: usize = 100;
            let host_in_state = paths
                .state_dir
                .join(format!("saint-cua-host-{id}.sock"))
                .to_string_lossy()
                .into_owned();
            let driver_in_state = paths
                .state_dir
                .join(format!("saint-cua-driver-{id}.sock"))
                .to_string_lossy()
                .into_owned();
            if host_in_state.len() <= MAX_UNIX_SOCKET_PATH_BYTES
                && driver_in_state.len() <= MAX_UNIX_SOCKET_PATH_BYTES
            {
                (host_in_state, driver_in_state)
            } else {
                #[cfg(unix)]
                let short_dir = {
                    use std::os::unix::fs::PermissionsExt;
                    let uid = unsafe { libc::geteuid() };
                    let dir = PathBuf::from("/tmp").join(format!("sc-{uid}"));
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
                    dir
                };
                #[cfg(not(unix))]
                let short_dir = std::env::temp_dir();
                (
                    short_dir
                        .join(format!("h-{id}.sock"))
                        .to_string_lossy()
                        .into_owned(),
                    short_dir
                        .join(format!("d-{id}.sock"))
                        .to_string_lossy()
                        .into_owned(),
                )
            }
        };

        Self {
            paths,
            socket_path,
            driver_socket_path,
            external_driver_socket: false,
            preview_subscribed: AtomicBool::new(false),
            preview_loop_running: AtomicBool::new(false),
            preview_seq: AtomicU64::new(0),
            socket_started: AtomicBool::new(false),
            driver_child: Mutex::new(None),
            control: Mutex::new(HostControlState::default()),
            app_handle: Mutex::new(None),
            #[cfg(test)]
            test_preview_sink: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn with_external_driver_socket(
        paths: SaintPaths,
        driver_socket_path: String,
        driver_pid: Option<u32>,
    ) -> Self {
        let mut host = Self::new(paths);
        host.driver_socket_path = driver_socket_path;
        host.external_driver_socket = true;
        if let Ok(mut ctrl) = host.control.lock() {
            ctrl.metadata.driver_pid = driver_pid;
        }
        host
    }

    #[cfg(test)]
    fn attach_test_preview_sink(&self, sink: Arc<Mutex<Vec<ComputerPreviewFrameEvent>>>) {
        if let Ok(mut guard) = self.test_preview_sink.lock() {
            *guard = Some(sink);
        }
    }

    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    pub fn attach_app_handle(&self, handle: tauri::AppHandle) {
        if let Ok(mut guard) = self.app_handle.lock() {
            *guard = Some(handle);
        }
    }

    pub fn resolve_driver_binary_path() -> PathBuf {
        let bin_name = if cfg!(target_os = "windows") {
            "cua-driver.exe"
        } else {
            "cua-driver"
        };
        // Tauri's resource dir: next to the exe on Windows, `Contents/Resources`
        // on macOS, `/usr/lib/<product>` (also inside an AppImage) on Linux.
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
            let candidates = [
                dir.clone(),
                dir.join("../Resources"),
                dir.join("../lib/Saint Hyper Agent"),
                dir.join("../lib/Saint"),
                dir.join("../lib/saint"),
            ];
            for base in candidates {
                let candidate = base.join("resources").join("cua-driver").join(bin_name);
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

    pub fn subscribe_preview(self: &Arc<Self>) {
        self.preview_subscribed.store(true, Ordering::SeqCst);
        self.ensure_preview_poll_loop();
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

    fn emit_preview_frame(&self, window_id: u64, jpeg: Vec<u8>) {
        if jpeg.is_empty() || !self.preview_subscribed.load(Ordering::SeqCst) {
            return;
        }
        let seq = self.preview_seq.fetch_add(1, Ordering::SeqCst) + 1;
        #[cfg(test)]
        if let Some(sink) = self.test_preview_sink.lock().ok().and_then(|g| g.clone()) {
            if let Ok(mut frames) = sink.lock() {
                frames.push(ComputerPreviewFrameEvent {
                    window_id,
                    seq,
                    jpeg: jpeg.clone(),
                });
            }
        }
        let app = self.app_handle.lock().ok().and_then(|g| g.clone());
        if let Some(app_handle) = app {
            crate::emit_app_event(
                &app_handle,
                "computerPreview.frame",
                &json!({
                    "windowId": window_id,
                    "seq": seq,
                    "jpeg": jpeg,
                }),
            );
        }
    }

    fn ensure_preview_poll_loop(self: &Arc<Self>) {
        if self.preview_loop_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let host = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                if !host.preview_subscribed.load(Ordering::SeqCst) {
                    break;
                }
                let target = host
                    .control
                    .lock()
                    .ok()
                    .and_then(|ctrl| {
                        if ctrl.active_tasks.is_empty() || ctrl.admission_closed {
                            None
                        } else {
                            ctrl.preview_target.clone()
                        }
                    });
                if let Some(target) = target {
                    if host.is_driver_alive() {
                        let req = json!({
                            "method": "call",
                            "name": "get_window_state",
                            "args": {
                                "window_id": target.window_id,
                                "include_screenshot": true,
                                "format": "jpeg",
                            }
                        });
                        if let Ok(resp) = host
                            .send_driver_request(&req, false, Duration::from_secs(3))
                            .await
                        {
                            if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                                if let Some(result) = resp.get("result") {
                                    if let Some(jpeg) = extract_jpeg_from_driver_result(result) {
                                        host.emit_preview_frame(target.window_id, jpeg);
                                    }
                                }
                            }
                        }
                    }
                }
                tokio::time::sleep(PREVIEW_TAP_POLL_INTERVAL).await;
            }
            host.preview_loop_running.store(false, Ordering::SeqCst);
        });
    }

    fn is_driver_alive(&self) -> bool {
        if self.external_driver_socket {
            return true;
        }
        let Ok(mut guard) = self.driver_child.lock() else {
            return false;
        };
        if let Some(ref mut child) = *guard {
            return matches!(child.try_wait(), Ok(None));
        }
        false
    }

    fn current_driver_pid(&self) -> Option<u32> {
        if let Ok(guard) = self.driver_child.lock() {
            if let Some(ref child) = *guard {
                if let Some(pid) = child.id() {
                    return Some(pid);
                }
            }
        }
        self.control
            .lock()
            .ok()
            .and_then(|ctrl| ctrl.metadata.driver_pid)
    }

    pub fn ensure_driver_started(&self) -> Result<String, String> {
        if self.external_driver_socket {
            return Ok(self.driver_socket_path.clone());
        }
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

        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::fs::remove_file(&self.driver_socket_path);
        }

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

        crate::clear_injected_linux_webkit_env(cmd.as_std_mut());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn cua-driver: {e}"))?;
        let spawned_pid = child.id();
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(_)) = reader.next_line().await {}
            });
        }
        *guard = Some(child);
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.metadata = DriverMetadataState {
                handshaken: false,
                native_revision: None,
                browser_input_control: false,
                driver_pid: spawned_pid,
                input_epoch: 0,
            };
        }
        Ok(self.driver_socket_path.clone())
    }

    async fn send_driver_request(
        &self,
        payload: &Value,
        mutation: bool,
        timeout: Duration,
    ) -> Result<Value, DriverRpcError> {
        let mut encoded = serde_json::to_string(payload)
            .map_err(|e| DriverRpcError::NotDispatched(format!("Failed to encode driver request: {e}")))?;
        encoded.push('\n');
        let bytes = encoded.into_bytes();

        let connect_deadline = tokio::time::Instant::now() + DRIVER_CONNECT_MAX_WAIT;

        #[cfg(unix)]
        let mut stream = {
            loop {
                match tokio::net::UnixStream::connect(&self.driver_socket_path).await {
                    Ok(stream) => break stream,
                    Err(err) => {
                        if !self.is_driver_alive() {
                            return Err(DriverRpcError::NotDispatched(format!(
                                "Cua Driver exited before accepting socket connection: {err}"
                            )));
                        }
                        if tokio::time::Instant::now() >= connect_deadline {
                            return Err(DriverRpcError::NotDispatched(format!(
                                "Timed out connecting to Cua Driver socket '{}': {err}",
                                self.driver_socket_path
                            )));
                        }
                        tokio::time::sleep(DRIVER_CONNECT_RETRY_INTERVAL).await;
                    }
                }
            }
        };

        #[cfg(target_os = "windows")]
        let mut stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            loop {
                match ClientOptions::new().open(&self.driver_socket_path) {
                    Ok(client) => break client,
                    Err(err) => {
                        if !self.is_driver_alive() {
                            return Err(DriverRpcError::NotDispatched(format!(
                                "Cua Driver exited before accepting pipe connection: {err}"
                            )));
                        }
                        if tokio::time::Instant::now() >= connect_deadline {
                            return Err(DriverRpcError::NotDispatched(format!(
                                "Timed out connecting to Cua Driver pipe '{}': {err}",
                                self.driver_socket_path
                            )));
                        }
                        tokio::time::sleep(DRIVER_CONNECT_RETRY_INTERVAL).await;
                    }
                }
            }
        };

        let mut dispatched = false;
        let exchange = async {
            stream
                .write_all(&bytes)
                .await
                .map_err(|e| format!("Failed writing to Cua Driver socket: {e}"))?;
            stream
                .flush()
                .await
                .map_err(|e| format!("Failed flushing Cua Driver socket: {e}"))?;
            dispatched = true;

            let mut reader = BufReader::new(&mut stream);
            let mut buf = Vec::new();
            let n = (&mut reader)
                .take((MAX_CUA_DRIVER_RESPONSE_BYTES + 1) as u64)
                .read_until(b'\n', &mut buf)
                .await
                .map_err(|e| format!("Failed reading Cua Driver response: {e}"))?;
            if n == 0 {
                return Err("Cua Driver closed the connection before replying.".to_string());
            }
            if buf.len() > MAX_CUA_DRIVER_RESPONSE_BYTES && !buf.ends_with(b"\n") {
                return Err("Cua Driver response exceeded its byte budget.".to_string());
            }
            let text = String::from_utf8(buf)
                .map_err(|_| "Cua Driver returned non-UTF-8 output.".to_string())?;
            serde_json::from_str::<Value>(text.trim())
                .map_err(|e| format!("Cua Driver returned invalid JSON: {e}"))
        };

        match tokio::time::timeout(timeout, exchange).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => {
                if mutation && dispatched {
                    Err(DriverRpcError::DispatchedUnknown(message))
                } else {
                    Err(DriverRpcError::NotDispatched(message))
                }
            }
            Err(_) => {
                let message = "Cua Driver request timed out; do not replay an uncertain action."
                    .to_string();
                if mutation && dispatched {
                    Err(DriverRpcError::DispatchedUnknown(message))
                } else {
                    Err(DriverRpcError::NotDispatched(message))
                }
            }
        }
    }

    async fn ensure_driver_ready_and_handshaken(&self) -> Result<(), DriverRpcError> {
        self.ensure_driver_started()
            .map_err(DriverRpcError::NotDispatched)?;
        let already_handshaken = self
            .control
            .lock()
            .ok()
            .map(|ctrl| ctrl.metadata.handshaken)
            .unwrap_or(false);
        if already_handshaken {
            return Ok(());
        }
        let reply = self
            .send_driver_request(&json!({ "method": "metadata" }), false, Duration::from_secs(10))
            .await?;
        if reply.get("ok").and_then(Value::as_bool) != Some(true) {
            let err = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Cua Driver metadata handshake failed.");
            return Err(DriverRpcError::NotDispatched(err.to_string()));
        }
        let result = reply.get("result").unwrap_or(&Value::Null);
        let native_revision = result
            .get("saint_native_revision")
            .and_then(Value::as_u64);
        let browser_input_control = result
            .get("saint_browser_input_control")
            .map(|v| v.as_u64() == Some(1) || v.as_bool() == Some(true))
            .unwrap_or(false);
        let reported_pid = result
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok());
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.metadata.handshaken = true;
            ctrl.metadata.native_revision = native_revision;
            ctrl.metadata.browser_input_control = browser_input_control;
            if ctrl.metadata.driver_pid.is_none() {
                ctrl.metadata.driver_pid = reported_pid;
            }
        }
        Ok(())
    }

    fn build_reply(
        &self,
        ok: bool,
        result: Option<Value>,
        error: Option<String>,
        effect: Option<&str>,
    ) -> String {
        let (
            desktop_epoch,
            desktop_pauses,
            desktop_interruptions,
            native_revision,
            browser_input_control,
        ) = match self.control.lock() {
            Ok(ctrl) => (
                ctrl.desktop_epoch,
                ctrl.desktop_pauses.iter().cloned().collect::<Vec<_>>(),
                ctrl.desktop_interruptions,
                ctrl.metadata.native_revision,
                ctrl.metadata.browser_input_control,
            ),
            Err(_) => (0, Vec::new(), 0, None, false),
        };
        let mut obj = serde_json::Map::new();
        obj.insert("ok".to_string(), Value::Bool(ok));
        obj.insert(
            "hostPlatform".to_string(),
            Value::String(host_platform().to_string()),
        );
        obj.insert("desktopEpoch".to_string(), json!(desktop_epoch));
        obj.insert("desktopPauses".to_string(), json!(desktop_pauses));
        obj.insert(
            "desktopInterruptions".to_string(),
            json!(desktop_interruptions),
        );
        if let Some(rev) = native_revision {
            obj.insert("driverNativeRevision".to_string(), json!(rev));
        }
        if browser_input_control {
            obj.insert("driverBrowserInputControl".to_string(), Value::Bool(true));
        }
        if let Some(res) = result {
            obj.insert("result".to_string(), res);
        }
        if let Some(err) = error {
            obj.insert("error".to_string(), Value::String(err));
        }
        if let Some(eff) = effect {
            obj.insert("effect".to_string(), Value::String(eff.to_string()));
        }
        Value::Object(obj).to_string()
    }

    fn record_task_from_request(&self, parsed: &Value) {
        let Some(task) = parsed.get("task").and_then(Value::as_object) else {
            return;
        };
        let Some(thread_id) = task
            .get("threadId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 256)
        else {
            return;
        };
        let turn_id = task
            .get("turnId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .map(ToString::to_string);
        let key = format!("{thread_id}\0{}", turn_id.as_deref().unwrap_or(""));
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.active_tasks.insert(
                key,
                ActiveTaskRecord {
                    thread_id: thread_id.to_string(),
                    turn_id,
                },
            );
        }
    }

    fn update_preview_target_and_emit(&self, parsed: &Value, driver_result: &Value) {
        let args = parsed.get("args");
        let thread_id = parsed
            .get("task")
            .and_then(|t| t.get("threadId"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let candidate_window_id = args
            .and_then(|a| a.get("window_id"))
            .and_then(Value::as_u64)
            .or_else(|| {
                driver_result
                    .get("structuredContent")
                    .and_then(|s| s.get("window_id"))
                    .and_then(Value::as_u64)
            });
        let effective_window_id = if let Some(wid) = candidate_window_id {
            if let Ok(mut ctrl) = self.control.lock() {
                ctrl.preview_target = Some(PreviewTarget {
                    window_id: wid,
                    thread_id,
                });
            }
            Some(wid)
        } else {
            self.control
                .lock()
                .ok()
                .and_then(|ctrl| ctrl.preview_target.as_ref().map(|t| t.window_id))
        };

        if let Some(jpeg) = extract_jpeg_from_driver_result(driver_result) {
            self.emit_preview_frame(effective_window_id.unwrap_or(0), jpeg);
        }
    }

    fn handle_shield_request(&self, parsed: &Value) -> String {
        let Some(args) = parsed.get("args").and_then(Value::as_object) else {
            return self.build_reply(
                false,
                None,
                Some("Invalid shield arguments.".to_string()),
                Some("not-dispatched"),
            );
        };
        let action = args.get("action").and_then(Value::as_str).unwrap_or("");
        match action {
            "release_all" => {
                let released = self
                    .control
                    .lock()
                    .map(|mut ctrl| {
                        let count = ctrl.shields.len();
                        ctrl.shields.clear();
                        count
                    })
                    .unwrap_or(0);
                self.build_reply(true, Some(json!({ "released": released })), None, None)
            }
            "release" => {
                let shield_id = args.get("shield_id").and_then(Value::as_str).unwrap_or("");
                if !is_valid_shield_id(shield_id) {
                    return self.build_reply(
                        false,
                        None,
                        Some("Invalid shield_id.".to_string()),
                        Some("not-dispatched"),
                    );
                }
                let removed = self
                    .control
                    .lock()
                    .map(|mut ctrl| ctrl.shields.remove(shield_id).is_some())
                    .unwrap_or(false);
                self.build_reply(
                    true,
                    Some(json!({ "released": if removed { 1 } else { 0 }, "shield_id": shield_id })),
                    None,
                    None,
                )
            }
            "engage" => {
                let shield_id = args.get("shield_id").and_then(Value::as_str).unwrap_or("");
                let frame = args.get("frame").and_then(Value::as_object);
                let window_id = args.get("window_id").and_then(Value::as_u64);
                let pid = args.get("pid").and_then(Value::as_u64);
                let valid_frame = frame.and_then(|f| {
                    let x = f.get("x").and_then(Value::as_f64)?;
                    let y = f.get("y").and_then(Value::as_f64)?;
                    let w = f.get("width").and_then(Value::as_f64)?;
                    let h = f.get("height").and_then(Value::as_f64)?;
                    if x.is_finite()
                        && y.is_finite()
                        && w.is_finite()
                        && h.is_finite()
                        && x.abs() <= SHIELD_MAX_COORDINATE
                        && y.abs() <= SHIELD_MAX_COORDINATE
                        && w > 0.0
                        && w <= SHIELD_MAX_EXTENT
                        && h > 0.0
                        && h <= SHIELD_MAX_EXTENT
                    {
                        Some((x, y, w, h))
                    } else {
                        None
                    }
                });
                let (Some(_frame), Some(wid), Some(target_pid)) = (valid_frame, window_id, pid)
                else {
                    return self.build_reply(
                        false,
                        None,
                        Some("Invalid shield engage geometry or target.".to_string()),
                        Some("not-dispatched"),
                    );
                };
                if !is_valid_shield_id(shield_id)
                    || wid == 0
                    || wid > u32::MAX as u64
                    || target_pid == 0
                    || target_pid > i32::MAX as u64
                {
                    return self.build_reply(
                        false,
                        None,
                        Some("Invalid shield target identifier.".to_string()),
                        Some("not-dispatched"),
                    );
                }
                let thread_id = parsed
                    .get("task")
                    .and_then(|t| t.get("threadId"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let turn_id = parsed
                    .get("task")
                    .and_then(|t| t.get("turnId"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                let Ok(mut ctrl) = self.control.lock() else {
                    return self.build_reply(
                        false,
                        None,
                        Some("Computer host state lock poisoned.".to_string()),
                        Some("not-dispatched"),
                    );
                };
                if ctrl.admission_closed {
                    return self.build_reply(
                        false,
                        None,
                        Some(
                            ctrl.admission_closed_reason
                                .clone()
                                .unwrap_or_else(|| "Computer host admission is closed.".to_string()),
                        ),
                        Some("not-dispatched"),
                    );
                }
                if !ctrl.desktop_pauses.is_empty() {
                    return self.build_reply(
                        false,
                        None,
                        Some("Cannot engage activation shield while desktop is paused.".to_string()),
                        Some("not-dispatched"),
                    );
                }
                ctrl.shields.insert(
                    shield_id.to_string(),
                    ActiveShield {
                        thread_id,
                        turn_id,
                    },
                );
                drop(ctrl);
                self.build_reply(
                    true,
                    Some(json!({ "engaged": true, "shield_id": shield_id })),
                    None,
                    None,
                )
            }
            _ => self.build_reply(
                false,
                None,
                Some(format!("Unsupported shield action: {action}")),
                Some("not-dispatched"),
            ),
        }
    }

    async fn handle_stop_request(&self) -> String {
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.desktop_epoch = ctrl.desktop_epoch.saturating_add(1);
            ctrl.shields.clear();
        }
        if !self.is_driver_alive() {
            return self.build_reply(true, None, None, None);
        }
        let expected_pid = self.current_driver_pid();
        let Some(pid) = expected_pid else {
            return self.build_reply(true, None, None, None);
        };

        // Prefer interrupt_input on patched drivers so the generation drains held
        // input and advances its epoch without killing the daemon.
        let interrupt_req = json!({
            "method": "interrupt_input",
            "args": { "expected_pid": pid }
        });
        if let Ok(resp) = self
            .send_driver_request(&interrupt_req, false, DRIVER_CANCEL_TIMEOUT)
            .await
        {
            if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                let res = resp.get("result").unwrap_or(&Value::Null);
                let cleanup_ok = res.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
                    && res.get("cleanup_complete").and_then(Value::as_bool) == Some(true)
                    && res.get("pending_input").and_then(Value::as_u64) == Some(0)
                    && res.get("input_admission_open").and_then(Value::as_bool) == Some(true);
                if cleanup_ok {
                    if let Some(next_epoch) = res.get("input_epoch").and_then(Value::as_u64) {
                        if let Ok(mut ctrl) = self.control.lock() {
                            ctrl.metadata.input_epoch = next_epoch;
                        }
                    }
                    return self.build_reply(true, Some(res.clone()), None, None);
                }
            }
        }

        // Fall back to cancel_input and verify the exact 4-field cleanup acknowledgement.
        // If absent or invalid, fail closed for the host lifetime instead of spawning a
        // replacement while the old driver may still hold OS input.
        let cancel_req = json!({
            "method": "cancel_input",
            "args": { "expected_pid": pid }
        });
        match self
            .send_driver_request(&cancel_req, false, DRIVER_CANCEL_TIMEOUT)
            .await
        {
            Ok(resp) if resp.get("ok").and_then(Value::as_bool) == Some(true) => {
                let res = resp.get("result").unwrap_or(&Value::Null);
                let acknowledged = res.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
                    && res.get("input_admission_closed").and_then(Value::as_bool) == Some(true)
                    && res.get("cleanup_complete").and_then(Value::as_bool) == Some(true)
                    && res.get("pending_input").and_then(Value::as_u64) == Some(0);
                if acknowledged {
                    self.retire_driver_child();
                    return self.build_reply(true, Some(res.clone()), None, None);
                }
                if let Ok(mut ctrl) = self.control.lock() {
                    ctrl.admission_closed = true;
                    ctrl.admission_closed_reason = Some(
                        "Cua Driver did not confirm input release cleanup; Computer admission is closed until Saint restarts."
                            .to_string(),
                    );
                }
                self.build_reply(
                    false,
                    None,
                    Some(
                        "Cua Driver did not confirm input release cleanup; Computer admission is closed."
                            .to_string(),
                    ),
                    Some("dispatched-unknown"),
                )
            }
            Ok(resp) => {
                let err = resp
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Cua Driver rejected input cancellation.");
                if let Ok(mut ctrl) = self.control.lock() {
                    ctrl.admission_closed = true;
                    ctrl.admission_closed_reason = Some(err.to_string());
                }
                self.build_reply(false, None, Some(err.to_string()), Some("dispatched-unknown"))
            }
            Err(DriverRpcError::NotDispatched(err)) | Err(DriverRpcError::DispatchedUnknown(err)) => {
                if let Ok(mut ctrl) = self.control.lock() {
                    ctrl.admission_closed = true;
                    ctrl.admission_closed_reason = Some(err.clone());
                }
                self.build_reply(false, None, Some(err), Some("dispatched-unknown"))
            }
        }
    }

    fn retire_driver_child(&self) {
        if let Ok(mut guard) = self.driver_child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.metadata = DriverMetadataState::default();
        }
    }

    pub async fn handle_socket_json_line(&self, expected_capability: &str, raw_line: &str) -> String {
        let Ok(parsed) = serde_json::from_str::<Value>(raw_line.trim()) else {
            return self.build_reply(
                false,
                None,
                Some("Invalid computer request.".to_string()),
                Some("not-dispatched"),
            );
        };

        let supplied_cap = parsed
            .get("capability")
            .and_then(Value::as_str)
            .unwrap_or("");
        if expected_capability.len() < 32
            || !constant_time_eq(supplied_cap.as_bytes(), expected_capability.as_bytes())
        {
            return self.build_reply(
                false,
                None,
                Some("Computer host authority is required.".to_string()),
                Some("not-dispatched"),
            );
        }

        let method = parsed.get("method").and_then(Value::as_str).unwrap_or("");
        match method {
            "stop" => self.handle_stop_request().await,
            "pause" => {
                let reason = parsed
                    .get("reason")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("user-pause")
                    .to_string();
                if let Ok(mut ctrl) = self.control.lock() {
                    let newly_inserted = ctrl.desktop_pauses.insert(reason);
                    if newly_inserted {
                        ctrl.desktop_epoch = ctrl.desktop_epoch.saturating_add(1);
                        ctrl.desktop_interruptions = ctrl.desktop_interruptions.saturating_add(1);
                        ctrl.shields.clear();
                    }
                }
                self.build_reply(true, None, None, None)
            }
            "resume" => {
                let reason = parsed.get("reason").and_then(Value::as_str);
                if let Ok(mut ctrl) = self.control.lock() {
                    if let Some(r) = reason {
                        ctrl.desktop_pauses.remove(r);
                    } else {
                        ctrl.desktop_pauses.clear();
                    }
                }
                self.build_reply(true, None, None, None)
            }
            "end_task" => {
                let thread_id = parsed
                    .get("task")
                    .and_then(|t| t.get("threadId"))
                    .and_then(Value::as_str);
                let turn_id = parsed
                    .get("task")
                    .and_then(|t| t.get("turnId"))
                    .and_then(Value::as_str);
                if let Ok(mut ctrl) = self.control.lock() {
                    if let Some(tid) = thread_id {
                        ctrl.active_tasks.retain(|_, task| {
                            !(task.thread_id == tid
                                && (turn_id.is_none() || task.turn_id.as_deref() == turn_id))
                        });
                        ctrl.shields.retain(|_, shield| {
                            !(shield.thread_id.as_deref() == Some(tid)
                                && (turn_id.is_none() || shield.turn_id.as_deref() == turn_id))
                        });
                        if ctrl
                            .preview_target
                            .as_ref()
                            .and_then(|t| t.thread_id.as_deref())
                            == Some(tid)
                            && !ctrl.active_tasks.values().any(|t| t.thread_id == tid)
                        {
                            ctrl.preview_target = None;
                        }
                    } else {
                        ctrl.active_tasks.clear();
                        ctrl.shields.clear();
                        ctrl.preview_target = None;
                    }
                }
                self.build_reply(true, None, None, None)
            }
            "end_browser_thread" => {
                let thread_id = parsed
                    .get("task")
                    .and_then(|t| t.get("threadId"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
                if let Ok(mut ctrl) = self.control.lock() {
                    if let Some(ref tid) = thread_id {
                        ctrl.active_tasks.retain(|_, t| t.thread_id != *tid);
                        ctrl.shields
                            .retain(|_, s| s.thread_id.as_deref() != Some(tid.as_str()));
                    }
                }
                if self.is_driver_alive() {
                    let forward = json!({
                        "method": "end_browser_thread",
                        "args": { "thread_id": thread_id },
                    });
                    if let Ok(resp) = self
                        .send_driver_request(&forward, false, DRIVER_CANCEL_TIMEOUT)
                        .await
                    {
                        if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                            return self.build_reply(true, resp.get("result").cloned(), None, None);
                        }
                    }
                }
                self.build_reply(true, None, None, None)
            }
            "browser_control" => {
                if self.is_driver_alive() {
                    let forward = json!({
                        "method": "browser_control",
                        "args": parsed.get("args").cloned().unwrap_or_else(|| json!({})),
                    });
                    if let Ok(resp) = self
                        .send_driver_request(&forward, false, DRIVER_REQUEST_TIMEOUT)
                        .await
                    {
                        let ok = resp.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        return self.build_reply(
                            ok,
                            resp.get("result").cloned(),
                            resp.get("error").and_then(Value::as_str).map(ToString::to_string),
                            if ok { None } else { Some("not-dispatched") },
                        );
                    }
                }
                self.build_reply(true, None, None, None)
            }
            "restore_clipboard" => {
                if self.is_driver_alive() {
                    let forward = json!({
                        "method": "call",
                        "name": "restore_clipboard",
                        "args": {},
                    });
                    if let Ok(resp) = self
                        .send_driver_request(&forward, false, DRIVER_CANCEL_TIMEOUT)
                        .await
                    {
                        if resp.get("ok").and_then(Value::as_bool) == Some(true) {
                            return self.build_reply(true, resp.get("result").cloned(), None, None);
                        }
                    }
                }
                self.build_reply(
                    true,
                    Some(json!({
                        "structuredContent": { "clipboard_restored": true }
                    })),
                    None,
                    None,
                )
            }
            "shield" => self.handle_shield_request(&parsed),
            "probe" => {
                if !self.external_driver_socket && !Self::resolve_driver_binary_path().is_file() {
                    return self.build_reply(
                        false,
                        None,
                        Some("Cua Driver is not bundled. Run the provisioning script (`node apps/desktop-rust/scripts/provision-cua-driver.mjs`), then relaunch Saint.".to_string()),
                        Some("not-dispatched"),
                    );
                }
                match self.ensure_driver_ready_and_handshaken().await {
                    Ok(()) => self.build_reply(
                        true,
                        Some(json!({
                            "ready": true,
                            "bundle_id": APP_BUNDLE_ID,
                        })),
                        None,
                        None,
                    ),
                    Err(DriverRpcError::NotDispatched(err))
                    | Err(DriverRpcError::DispatchedUnknown(err)) => {
                        self.build_reply(false, None, Some(err), Some("not-dispatched"))
                    }
                }
            }
            "setup" => {
                if let Err(err) = self.ensure_driver_ready_and_handshaken().await {
                    let message = match err {
                        DriverRpcError::NotDispatched(m) | DriverRpcError::DispatchedUnknown(m) => m,
                    };
                    return self.build_reply(false, None, Some(message), Some("not-dispatched"));
                }
                let req = json!({
                    "method": "call",
                    "name": "check_permissions",
                    "args": { "prompt": true },
                });
                match self
                    .send_driver_request(&req, false, DRIVER_REQUEST_TIMEOUT)
                    .await
                {
                    Ok(resp) if resp.get("ok").and_then(Value::as_bool) == Some(true) => {
                        self.build_reply(true, resp.get("result").cloned(), None, None)
                    }
                    Ok(resp) => self.build_reply(
                        false,
                        None,
                        Some(
                            resp.get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Computer setup failed.")
                                .to_string(),
                        ),
                        Some("not-dispatched"),
                    ),
                    Err(DriverRpcError::NotDispatched(err))
                    | Err(DriverRpcError::DispatchedUnknown(err)) => {
                        self.build_reply(false, None, Some(err), Some("not-dispatched"))
                    }
                }
            }
            "call" => {
                let tool_name = parsed
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if tool_name.is_empty() {
                    return self.build_reply(
                        false,
                        None,
                        Some("Computer call requires a non-empty tool name.".to_string()),
                        Some("not-dispatched"),
                    );
                }

                let mutation = is_mutating_tool(tool_name);
                let delivery_mode = parsed
                    .get("deliveryMode")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cfg!(target_os = "linux")
                    && !is_browser_tool(tool_name)
                    && delivery_mode == "background"
                    && mutation
                {
                    return self.build_reply(
                        false,
                        None,
                        Some(
                            "Linux does not implement background native desktop input; use foreground delivery or headless browser tools."
                                .to_string(),
                        ),
                        Some("not-dispatched"),
                    );
                }

                let (admission_closed, closed_reason, paused, input_epoch) =
                    match self.control.lock() {
                        Ok(ctrl) => (
                            ctrl.admission_closed,
                            ctrl.admission_closed_reason.clone(),
                            !ctrl.desktop_pauses.is_empty(),
                            ctrl.metadata.input_epoch,
                        ),
                        Err(_) => (
                            true,
                            Some("Computer host lock poisoned.".to_string()),
                            false,
                            0,
                        ),
                    };

                if admission_closed && mutation {
                    return self.build_reply(
                        false,
                        None,
                        Some(
                            closed_reason
                                .unwrap_or_else(|| "Computer admission is closed.".to_string()),
                        ),
                        Some("not-dispatched"),
                    );
                }
                if paused && mutation {
                    return self.build_reply(
                        false,
                        None,
                        Some("Computer input is paused while the desktop is locked or paused.".to_string()),
                        Some("not-dispatched"),
                    );
                }

                self.record_task_from_request(&parsed);

                if let Err(err) = self.ensure_driver_ready_and_handshaken().await {
                    let message = match err {
                        DriverRpcError::NotDispatched(m) | DriverRpcError::DispatchedUnknown(m) => m,
                    };
                    return self.build_reply(false, None, Some(message), Some("not-dispatched"));
                }

                let mut driver_req = serde_json::Map::new();
                driver_req.insert("method".to_string(), Value::String("call".to_string()));
                driver_req.insert("name".to_string(), Value::String(tool_name.to_string()));
                driver_req.insert(
                    "args".to_string(),
                    parsed.get("args").cloned().unwrap_or_else(|| json!({})),
                );
                if mutation {
                    driver_req.insert("expected_input_epoch".to_string(), json!(input_epoch));
                }
                if let Some(model_obs) = parsed.get("modelObservation").and_then(Value::as_bool) {
                    driver_req.insert("modelObservation".to_string(), Value::Bool(model_obs));
                }

                match self
                    .send_driver_request(&Value::Object(driver_req), mutation, DRIVER_REQUEST_TIMEOUT)
                    .await
                {
                    Ok(resp) => {
                        let ok = resp.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        if ok {
                            let result = resp.get("result").cloned().unwrap_or_else(|| json!({}));
                            self.update_preview_target_and_emit(&parsed, &result);
                            self.build_reply(true, Some(result), None, None)
                        } else {
                            let err = resp
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("Cua Driver call failed.")
                                .to_string();
                            let effect = resp
                                .get("effect")
                                .and_then(Value::as_str)
                                .unwrap_or("not-dispatched");
                            self.build_reply(false, None, Some(err), Some(effect))
                        }
                    }
                    Err(DriverRpcError::NotDispatched(err)) => {
                        self.build_reply(false, None, Some(err), Some("not-dispatched"))
                    }
                    Err(DriverRpcError::DispatchedUnknown(err)) => {
                        self.build_reply(false, None, Some(err), Some("dispatched-unknown"))
                    }
                }
            }
            _ => self.build_reply(
                false,
                None,
                Some(format!("Unsupported computer host method: {method}")),
                Some("not-dispatched"),
            ),
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
                            let response = host_conn.handle_socket_json_line(&cap_conn, &line).await;
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
                            let response = host_conn.handle_socket_json_line(&cap_conn, &line).await;
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
        if let Ok(mut ctrl) = self.control.lock() {
            ctrl.shields.clear();
            ctrl.active_tasks.clear();
            ctrl.preview_target = None;
        }
        if let Some(mut c) = self.driver_child.lock().ok().and_then(|mut g| g.take()) {
            let _ = c.start_kill();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::fs::remove_file(&self.socket_path);
            if !self.external_driver_socket {
                let _ = std::fs::remove_file(&self.driver_socket_path);
            }
        }
    }
}

impl Drop for CuaDriverHost {
    fn drop(&mut self) {
        self.kill_sync();
    }
}

fn extract_jpeg_from_driver_result(result: &Value) -> Option<Vec<u8>> {
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            if item.get("type").and_then(Value::as_str) == Some("image") {
                let mime = item.get("mimeType").and_then(Value::as_str).unwrap_or("");
                if mime.eq_ignore_ascii_case("image/jpeg") || mime.eq_ignore_ascii_case("image/jpg") {
                    if let Some(data) = item.get("data").and_then(Value::as_str) {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                            if !bytes.is_empty() {
                                return Some(bytes);
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(sc) = result.get("structuredContent").and_then(Value::as_object) {
        for key in ["jpeg_base64", "image_base64"] {
            if let Some(data) = sc.get(key).and_then(Value::as_str) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                    if !bytes.is_empty() {
                        return Some(bytes);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handles_cua_host_socket_requests_and_auth() {
        let host = CuaDriverHost::new(SaintPaths::resolve());
        let cap = "0123456789abcdef0123456789abcdef";

        let denied = host
            .handle_socket_json_line(cap, r#"{"method":"stop","capability":"wrong"}"#)
            .await;
        let denied_val: Value = serde_json::from_str(&denied).unwrap();
        assert_eq!(denied_val["ok"], false);
        assert_eq!(denied_val["effect"], "not-dispatched");

        let stop_ok = host
            .handle_socket_json_line(
                cap,
                &json!({
                    "method": "stop",
                    "capability": cap,
                })
                .to_string(),
            )
            .await;
        let stop_val: Value = serde_json::from_str(&stop_ok).unwrap();
        assert_eq!(stop_val["ok"], true);
        assert_eq!(stop_val["desktopEpoch"], 1);
        assert_eq!(stop_val["hostPlatform"], host_platform());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxies_metadata_calls_safety_shields_stop_and_preview_frames_over_driver_socket() {
        let short_id = &Uuid::new_v4().simple().to_string()[..10];
        let dir = PathBuf::from("/tmp").join(format!("sc-t-{short_id}"));
        std::fs::create_dir_all(&dir).unwrap();
        let driver_sock = dir.join("d.sock").to_string_lossy().into_owned();
        let listener = tokio::net::UnixListener::bind(&driver_sock).unwrap();

        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received_srv = Arc::clone(&received);
        let mock_pid = 4242u32;
        let sample_jpeg = vec![0xFFu8, 0xD8, 0xFF, 0xD9];
        let sample_jpeg_b64 = base64::engine::general_purpose::STANDARD.encode(&sample_jpeg);
        let sample_jpeg_b64_srv = sample_jpeg_b64.clone();

        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let received_conn = Arc::clone(&received_srv);
                let jpeg_b64 = sample_jpeg_b64_srv.clone();
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let req: Value = serde_json::from_str(line.trim()).unwrap();
                    received_conn.lock().unwrap().push(req.clone());
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    let reply = match method {
                        "metadata" => json!({
                            "ok": true,
                            "result": {
                                "saint_native_revision": 40,
                                "saint_browser_input_control": 1,
                                "pid": mock_pid,
                            }
                        }),
                        "interrupt_input" => json!({
                            "ok": true,
                            "result": {
                                "pid": mock_pid,
                                "input_interrupted": true,
                                "input_admission_open": true,
                                "cleanup_complete": true,
                                "pending_input": 0,
                                "input_epoch": 5,
                            }
                        }),
                        "end_browser_thread" => json!({
                            "ok": true,
                            "result": { "closed": true }
                        }),
                        "call" => {
                            let name = req.get("name").and_then(Value::as_str).unwrap_or("");
                            match name {
                                "check_permissions" => json!({
                                    "ok": true,
                                    "result": {
                                        "structuredContent": {
                                            "accessibility": true,
                                            "screen_recording": true,
                                            "atspi": true,
                                        }
                                    }
                                }),
                                "get_window_state" => json!({
                                    "ok": true,
                                    "result": {
                                        "content": [{
                                            "type": "image",
                                            "mimeType": "image/jpeg",
                                            "data": jpeg_b64,
                                        }],
                                        "structuredContent": {
                                            "window_id": 77,
                                            "pid": 999,
                                        }
                                    }
                                }),
                                "browser_click" => json!({
                                    "ok": true,
                                    "result": {
                                        "structuredContent": {
                                            "clicked": true,
                                            "seen_epoch": req.get("expected_input_epoch").cloned().unwrap_or(Value::Null),
                                        }
                                    }
                                }),
                                "restore_clipboard" => json!({
                                    "ok": true,
                                    "result": { "structuredContent": { "clipboard_restored": true } }
                                }),
                                _ => json!({ "ok": false, "error": format!("unknown tool {name}") }),
                            }
                        }
                        _ => json!({ "ok": false, "error": format!("unknown method {method}") }),
                    };
                    let _ = write_half
                        .write_all(format!("{reply}\n").as_bytes())
                        .await;
                    let _ = write_half.flush().await;
                });
            }
        });

        let host = Arc::new(CuaDriverHost::with_external_driver_socket(
            SaintPaths::resolve(),
            driver_sock.clone(),
            Some(mock_pid),
        ));
        let preview_frames = Arc::new(Mutex::new(Vec::<ComputerPreviewFrameEvent>::new()));
        host.attach_test_preview_sink(Arc::clone(&preview_frames));
        host.preview_subscribed.store(true, Ordering::SeqCst);

        let cap = "0123456789abcdef0123456789abcdef";

        // 1. Probe runs metadata handshake and exposes native revision & browser input control
        let probe: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(cap, &json!({ "method": "probe", "capability": cap }).to_string())
                .await,
        )
        .unwrap();
        assert_eq!(probe["ok"], true);
        assert_eq!(probe["driverNativeRevision"], 40);
        assert_eq!(probe["driverBrowserInputControl"], true);

        // 2. check_permissions forwards to the real driver instead of hardcoding
        let perms: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "call", "name": "check_permissions", "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(perms["ok"], true);
        assert_eq!(perms["result"]["structuredContent"]["accessibility"], true);

        // 3. Observation emits preview frame to subscribers
        let obs: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({
                        "method": "call",
                        "name": "get_window_state",
                        "args": { "window_id": 77 },
                        "task": { "threadId": "thread-1", "turnId": "turn-1" },
                        "capability": cap,
                    })
                    .to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(obs["ok"], true);
        {
            let frames = preview_frames.lock().unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0].window_id, 77);
            assert_eq!(frames[0].seq, 1);
            assert_eq!(frames[0].jpeg, sample_jpeg);
        }

        // 4. Shield validation, engage, and release_all
        let bad_shield: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({
                        "method": "shield",
                        "args": { "action": "engage", "shield_id": "bad id!", "frame": { "x": 0, "y": 0, "width": 10, "height": 10 }, "window_id": 77, "pid": 999 },
                        "capability": cap,
                    })
                    .to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(bad_shield["ok"], false);

        let engaged: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({
                        "method": "shield",
                        "task": { "threadId": "thread-1", "turnId": "turn-1" },
                        "args": { "action": "engage", "shield_id": "shield-1", "frame": { "x": 10, "y": 20, "width": 400, "height": 300 }, "window_id": 77, "pid": 999 },
                        "capability": cap,
                    })
                    .to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(engaged["ok"], true);

        // 5. Pause increments desktopInterruptions and blocks mutating calls; resume re-enables
        let paused: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "pause", "reason": "screen-lock", "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(paused["ok"], true);
        assert_eq!(paused["desktopInterruptions"], 1);
        assert_eq!(paused["desktopPauses"], json!(["screen-lock"]));

        let blocked_click: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "call", "name": "browser_click", "args": {}, "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(blocked_click["ok"], false);
        assert_eq!(blocked_click["effect"], "not-dispatched");

        let resumed: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "resume", "reason": "screen-lock", "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(resumed["ok"], true);
        assert_eq!(resumed["desktopPauses"], json!([]));
        assert_eq!(resumed["desktopInterruptions"], 1);

        // 6. Stop sends interrupt_input and advances host-owned expected_input_epoch to 5
        let stopped: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(cap, &json!({ "method": "stop", "capability": cap }).to_string())
                .await,
        )
        .unwrap();
        assert_eq!(stopped["ok"], true);

        let click_after_stop: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "call", "name": "browser_click", "args": { "ref": "e1" }, "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(click_after_stop["ok"], true);
        assert_eq!(click_after_stop["result"]["structuredContent"]["seen_epoch"], 5);

        // 7. end_browser_thread forwards cleanly
        let ended_browser: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "end_browser_thread", "task": { "threadId": "thread-1" }, "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(ended_browser["ok"], true);

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fails_closed_when_cancel_input_is_unconfirmed_and_reports_dispatched_unknown_on_drop() {
        let short_id = &Uuid::new_v4().simple().to_string()[..10];
        let dir = PathBuf::from("/tmp").join(format!("sc-fc-{short_id}"));
        std::fs::create_dir_all(&dir).unwrap();
        let driver_sock = dir.join("d.sock").to_string_lossy().into_owned();
        let listener = tokio::net::UnixListener::bind(&driver_sock).unwrap();
        let mock_pid = 5150u32;

        let server = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    let mut line = String::new();
                    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let req: Value = serde_json::from_str(line.trim()).unwrap();
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    match method {
                        "metadata" => {
                            let reply = json!({
                                "ok": true,
                                "result": { "saint_native_revision": 40, "pid": mock_pid }
                            });
                            let _ = write_half.write_all(format!("{reply}\n").as_bytes()).await;
                        }
                        "call" => {
                            // Drop connection after receiving a mutating call without replying.
                            drop(write_half);
                        }
                        "interrupt_input" => {
                            let reply = json!({ "ok": false, "error": "interrupt unsupported" });
                            let _ = write_half.write_all(format!("{reply}\n").as_bytes()).await;
                        }
                        "cancel_input" => {
                            // Incomplete acknowledgement (pending_input = 1) must close admission.
                            let reply = json!({
                                "ok": true,
                                "result": {
                                    "pid": mock_pid,
                                    "input_admission_closed": true,
                                    "cleanup_complete": false,
                                    "pending_input": 1,
                                }
                            });
                            let _ = write_half.write_all(format!("{reply}\n").as_bytes()).await;
                        }
                        _ => {}
                    }
                });
            }
        });

        let host = CuaDriverHost::with_external_driver_socket(
            SaintPaths::resolve(),
            driver_sock,
            Some(mock_pid),
        );
        let cap = "0123456789abcdef0123456789abcdef";

        // Mid-flight drop of a mutating call reports dispatched-unknown honestly
        let dropped: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "call", "name": "browser_click", "args": {}, "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(dropped["ok"], false);
        assert_eq!(dropped["effect"], "dispatched-unknown");

        // Unconfirmed cancel_input closes admission for future mutating calls
        let stop_unconfirmed: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(cap, &json!({ "method": "stop", "capability": cap }).to_string())
                .await,
        )
        .unwrap();
        assert_eq!(stop_unconfirmed["ok"], false);
        assert_eq!(stop_unconfirmed["effect"], "dispatched-unknown");

        let refused: Value = serde_json::from_str(
            &host
                .handle_socket_json_line(
                    cap,
                    &json!({ "method": "call", "name": "browser_click", "args": {}, "capability": cap }).to_string(),
                )
                .await,
        )
        .unwrap();
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["effect"], "not-dispatched");

        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn live_bundled_cua_driver_handshake_call_and_interrupt_round_trip() {
        let binary = CuaDriverHost::resolve_driver_binary_path();
        if !binary.is_file() {
            return;
        }
        let short_id = &Uuid::new_v4().simple().to_string()[..8];
        let tmp_state = PathBuf::from("/tmp").join(format!("sc-live-{short_id}"));
        std::fs::create_dir_all(&tmp_state).unwrap();
        let mut paths = SaintPaths::resolve();
        paths.state_dir = tmp_state.clone();
        let host = CuaDriverHost::new(paths);
        let cap = "0123456789abcdef0123456789abcdef";

        // 1. Probe spawns the real cua-driver binary and completes metadata handshake
        let probe_raw = host
            .handle_socket_json_line(cap, &json!({ "method": "probe", "capability": cap }).to_string())
            .await;
        eprintln!("[live cua_host] probe => {probe_raw}");
        let probe: Value = serde_json::from_str(&probe_raw).unwrap();
        assert_eq!(probe["ok"], true, "probe failed: {probe_raw}");
        assert_eq!(probe["driverNativeRevision"], 40);
        #[cfg(target_os = "linux")]
        assert_eq!(probe["driverBrowserInputControl"], true);

        // 2. check_permissions against the real driver
        let perms_raw = host
            .handle_socket_json_line(
                cap,
                &json!({ "method": "call", "name": "check_permissions", "args": {}, "capability": cap }).to_string(),
            )
            .await;
        eprintln!("[live cua_host] check_permissions => {perms_raw}");
        let perms: Value = serde_json::from_str(&perms_raw).unwrap();
        assert_eq!(perms["ok"], true, "check_permissions failed: {perms_raw}");

        // 3. get_browser_state against the real driver
        let browser_raw = host
            .handle_socket_json_line(
                cap,
                &json!({
                    "method": "call",
                    "name": "get_browser_state",
                    "args": {},
                    "task": { "threadId": "live-test-thread" },
                    "capability": cap,
                })
                .to_string(),
            )
            .await;
        eprintln!("[live cua_host] get_browser_state => {browser_raw}");
        let browser: Value = serde_json::from_str(&browser_raw).unwrap();
        assert_eq!(browser["ok"], true, "get_browser_state failed: {browser_raw}");

        // 4. stop exercises real interrupt_input with exact child PID
        let stop_raw = host
            .handle_socket_json_line(cap, &json!({ "method": "stop", "capability": cap }).to_string())
            .await;
        eprintln!("[live cua_host] stop => {stop_raw}");
        let stop: Value = serde_json::from_str(&stop_raw).unwrap();
        assert_eq!(stop["ok"], true, "stop failed: {stop_raw}");

        host.kill_sync();
        let _ = std::fs::remove_dir_all(&tmp_state);
    }
}
