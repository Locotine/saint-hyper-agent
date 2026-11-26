// FILE: lib.rs
// Purpose: Tauri v2 application entrypoint, IPC command handlers, window lifecycle,
//          and `window.desktopBridge` initialization script injection.
// Layer: Desktop shell core.

mod appsnap;
mod backend;
mod browser;
mod cua_host;
mod electron_storage;
mod lan_relay;
mod pty_host;
mod remote_ssh;
mod remote_ssh_scripts;
mod state;
mod updater;
mod window_state;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::appsnap::{
    DesktopAppSnapShortcutAvailability, DesktopAppSnapShortcutUpdateResult, DesktopAppSnapState,
    DesktopAudioInputDevice,
};
use crate::backend::{
    SidecarRuntimeBridgeConfig, VoiceTranscriptionInput, VoiceTranscriptionResult,
    BACKEND_MAX_CONSECUTIVE_START_FAILURES,
};
use crate::browser::{
    BrowserAttachWebviewInput, BrowserCaptureScreenshotResult, BrowserNavigateInput,
    BrowserNewTabInput, BrowserOpenInput, BrowserSetPanelBoundsInput, BrowserTabInput,
    BrowserThreadInput, ThreadBrowserState,
};
use crate::lan_relay::{
    DesktopLanRelayRevokeSessionInput, DesktopLanRelaySetEnabledInput, DesktopLanRelayState,
};
use crate::remote_ssh::{
    DesktopRemoteSshHostState, DesktopRemoteSshSavedHost, DesktopRemoteSshState,
    DesktopRemoteSshTestResult, DesktopRemoteSshUpdateHostInput, DesktopWorkspaceDownloadInput,
    DesktopWorkspaceDownloadResult,
};
use crate::state::{
    is_trusted_external_url, reveal_path_in_file_manager, DesktopSharedState, SaintPaths,
    APP_DISPLAY_NAME,
};
use crate::updater::{
    is_update_version_allowed_for_stable, is_update_version_newer, now_iso8601,
    DesktopUpdateActionResult, DesktopUpdateState,
};
use crate::window_state::{
    acknowledge_saint_storage_snapshot, apply_window_material, build_context_menu_nodes,
    decode_clipboard_png_data_url, default_custom_title_bar_preference,
    physical_to_logical_bounds, read_custom_title_bar_preference, read_desktop_window_state,
    read_saint_storage_snapshot, resolve_desktop_custom_title_bar_state,
    resolve_reported_menu_accelerators, resolve_visible_window_bounds, resolve_window_translucency,
    supports_custom_title_bar, write_custom_title_bar_preference, write_desktop_window_state,
    AgentCursorStylePreference, ContextMenuPosition, DesktopContextMenuItem,
    DesktopCustomTitleBarState, DesktopMenuAccelerators, DesktopMenuShortcuts,
    DesktopQuitConfirmationRequest, DesktopQuitConfirmationResponse, DesktopWindowBounds,
    DesktopWindowMaterial, DesktopWindowState, PersistedDesktopWindowState,
    ResolvedContextMenuNode,
};

const MAX_DROPPED_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[cfg(any(target_os = "linux", test))]
const LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS: &str = "unix:path=/nonexistent-a11y-bus";
#[cfg(any(target_os = "linux", test))]
const LINUX_DISABLED_WEBKIT_DMABUF_RENDERER: &str = "1";

#[cfg(target_os = "linux")]
static SAINT_INJECTED_LINUX_WEBKIT_A11Y: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "linux")]
static SAINT_INJECTED_LINUX_WEBKIT_DMABUF: AtomicBool = AtomicBool::new(false);

#[cfg(any(target_os = "linux", test))]
fn is_truthy_env_opt_in(value: Option<&str>) -> bool {
    value.is_some_and(|opt_in| {
        let normalized = opt_in.trim();
        normalized == "1"
            || normalized.eq_ignore_ascii_case("true")
            || normalized.eq_ignore_ascii_case("yes")
    })
}

/// WebKitGTK 2.50–2.54 aborts (`SIGABRT`) inside `WebCore::AccessibilityObjectAtspi::textInserted()`
/// when editing 16-bit text (such as Vietnamese via fcitx5-lotus Uinput) after inline chips in a
/// `contenteditable` editor. WebKitGTK connects directly to AT-SPI D-Bus via
/// `WEBKIT_A11Y_BUS_ADDRESS` and ignores `NO_AT_BRIDGE=1`. Redirecting only
/// `WEBKIT_A11Y_BUS_ADDRESS` disables that crashing bridge while preserving
/// `DBUS_SESSION_BUS_ADDRESS` (KDE Wallet, desktop portals, notifications, and IME D-Bus).
/// Users who need a screen reader can opt back in via `SAINT_ENABLE_LINUX_A11Y=1` or by setting
/// `WEBKIT_A11Y_BUS_ADDRESS` explicitly.
#[cfg(any(target_os = "linux", test))]
fn resolve_linux_webkit_a11y_bus_address(
    existing_a11y_bus: Option<&str>,
    enable_a11y_opt_in: Option<&str>,
) -> Option<&'static str> {
    if existing_a11y_bus.is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    if is_truthy_env_opt_in(enable_a11y_opt_in) {
        return None;
    }
    Some(LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS)
}

/// On Linux desktops (notably Ubuntu 24.04 LTS with WebKitGTK 4.1 under Wayland/NVIDIA/Mesa),
/// WebKitGTK's DMA-BUF renderer can freeze painting on the initial splash frame while JS and
/// WebSockets keep running underneath (often only repainting after a resize or a second window).
/// Disabling the DMA-BUF renderer switches frame sharing to POSIX shared memory while keeping
/// compositing intact. Users who explicitly set `WEBKIT_DISABLE_DMABUF_RENDERER` or opt back in
/// via `SAINT_ENABLE_LINUX_DMABUF=1` keep full control.
#[cfg(any(target_os = "linux", test))]
fn resolve_linux_webkit_dmabuf_renderer_env(
    existing_dmabuf_env: Option<&str>,
    enable_dmabuf_opt_in: Option<&str>,
) -> Option<&'static str> {
    if existing_dmabuf_env.is_some_and(|value| !value.trim().is_empty()) {
        return None;
    }
    if is_truthy_env_opt_in(enable_dmabuf_opt_in) {
        return None;
    }
    Some(LINUX_DISABLED_WEBKIT_DMABUF_RENDERER)
}

#[cfg(target_os = "linux")]
fn configure_linux_webkit_env() {
    let existing_a11y = std::env::var("WEBKIT_A11Y_BUS_ADDRESS").ok();
    let a11y_opt_in = std::env::var("SAINT_ENABLE_LINUX_A11Y").ok();
    if let Some(disabled_bus) =
        resolve_linux_webkit_a11y_bus_address(existing_a11y.as_deref(), a11y_opt_in.as_deref())
    {
        std::env::set_var("WEBKIT_A11Y_BUS_ADDRESS", disabled_bus);
        SAINT_INJECTED_LINUX_WEBKIT_A11Y.store(true, Ordering::SeqCst);
    }

    let existing_dmabuf = std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").ok();
    let dmabuf_opt_in = std::env::var("SAINT_ENABLE_LINUX_DMABUF").ok();
    if let Some(disabled_dmabuf) = resolve_linux_webkit_dmabuf_renderer_env(
        existing_dmabuf.as_deref(),
        dmabuf_opt_in.as_deref(),
    ) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", disabled_dmabuf);
        SAINT_INJECTED_LINUX_WEBKIT_DMABUF.store(true, Ordering::SeqCst);
    }
}

/// Strips Saint's internal Linux WebKitGTK workarounds (`WEBKIT_A11Y_BUS_ADDRESS`,
/// `WEBKIT_DISABLE_DMABUF_RENDERER`) from child processes (`saint-server`, `cua-driver`,
/// `xdg-open`) so user terminals, agents, and external browsers never inherit them.
pub(crate) fn clear_injected_linux_webkit_env(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    {
        if SAINT_INJECTED_LINUX_WEBKIT_A11Y.load(Ordering::Relaxed) {
            cmd.env_remove("WEBKIT_A11Y_BUS_ADDRESS");
        }
        if SAINT_INJECTED_LINUX_WEBKIT_DMABUF.load(Ordering::Relaxed) {
            cmd.env_remove("WEBKIT_DISABLE_DMABUF_RENDERER");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

#[cfg(any(target_os = "linux", test))]
const WEB_PROCESS_RECOVERY_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
#[cfg(any(target_os = "linux", test))]
const WEB_PROCESS_RECOVERY_MAX_ATTEMPTS: usize = 3;
#[cfg(target_os = "linux")]
const WEB_PROCESS_RECOVERY_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebProcessTerminationKind {
    Crashed,
    ExceededMemoryLimit,
    TerminatedByApi,
    Unknown(i32),
}

#[cfg(any(target_os = "linux", test))]
impl WebProcessTerminationKind {
    fn from_webkit_enum_value(value: i32) -> Self {
        match value {
            0 => Self::Crashed,
            1 => Self::ExceededMemoryLimit,
            2 => Self::TerminatedByApi,
            other => Self::Unknown(other),
        }
    }

    fn should_auto_recover(self) -> bool {
        matches!(self, Self::Crashed | Self::ExceededMemoryLimit)
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default)]
struct WebProcessRecoveryLimiter {
    recent_recoveries: Vec<std::time::Instant>,
}

#[cfg(any(target_os = "linux", test))]
impl WebProcessRecoveryLimiter {
    fn try_record_recovery(
        &mut self,
        now: std::time::Instant,
        kind: WebProcessTerminationKind,
    ) -> Option<usize> {
        if !kind.should_auto_recover() {
            return None;
        }
        self.recent_recoveries.retain(|ts| {
            now.checked_duration_since(*ts)
                .is_some_and(|elapsed| elapsed < WEB_PROCESS_RECOVERY_WINDOW)
        });
        if self.recent_recoveries.len() >= WEB_PROCESS_RECOVERY_MAX_ATTEMPTS {
            return None;
        }
        self.recent_recoveries.push(now);
        Some(self.recent_recoveries.len())
    }
}

#[cfg(target_os = "linux")]
fn extract_gvalue_enum_code(value: &gtk::glib::Value) -> Option<i32> {
    value
        .get::<i32>()
        .ok()
        .or_else(|| {
            value
                .transform::<i32>()
                .ok()
                .and_then(|converted| converted.get::<i32>().ok())
        })
}

#[cfg(target_os = "linux")]
fn install_linux_web_process_recovery(
    window: &tauri::WebviewWindow,
    state: Arc<DesktopSharedState>,
) {
    let window_for_reload = window.clone();
    let limiter = Arc::new(std::sync::Mutex::new(WebProcessRecoveryLimiter::default()));
    let _ = window.with_webview(move |platform| {
        use gtk::prelude::*;
        let widget: gtk::Widget = platform.inner().upcast();
        let obj: gtk::glib::Object = widget.upcast();
        obj.connect_local("web-process-terminated", false, move |args| {
            let reason_code = args
                .get(1)
                .and_then(extract_gvalue_enum_code)
                .unwrap_or(-1);
            let kind = WebProcessTerminationKind::from_webkit_enum_value(reason_code);
            if state.backend.is_shutting_down() {
                return None;
            }
            let attempt = limiter
                .lock()
                .ok()
                .and_then(|mut guard| guard.try_record_recovery(std::time::Instant::now(), kind));
            match attempt {
                Some(attempt_num) => {
                    eprintln!(
                        "[saint-desktop-rust] WebKitWebProcess terminated ({kind:?}); scheduling reload attempt {attempt_num}/{WEB_PROCESS_RECOVERY_MAX_ATTEMPTS}"
                    );
                    let window_reload = window_for_reload.clone();
                    let state_reload = Arc::clone(&state);
                    gtk::glib::timeout_add_local_once(WEB_PROCESS_RECOVERY_DELAY, move || {
                        if !state_reload.backend.is_shutting_down() {
                            if let Err(err) = window_reload.reload() {
                                eprintln!(
                                    "[saint-desktop-rust] Failed to reload webview after WebKitWebProcess termination: {err}"
                                );
                            }
                        }
                    });
                }
                None => {
                    eprintln!(
                        "[saint-desktop-rust] WebKitWebProcess terminated ({kind:?}); skipping auto-reload"
                    );
                }
            }
            None
        });
    });
}

fn cleanup_all_managed_resources(state: &DesktopSharedState) {
    state.backend.begin_shutdown();
    state.pty_host.kill_all_sync();
    state.lan_relay.stop_sync();
    state.remote_ssh.kill_all_tunnels();
    state.cua_host.kill_sync();
    state.browser.stop_rpc_pipe_server();
}

pub fn emit_window_event<T: serde::Serialize>(
    window: &tauri::Webview,
    event: &str,
    payload: &T,
) {
    let _ = window.emit(event, payload);
    if let Ok(detail_json) = serde_json::to_string(&serde_json::json!({
        "event": event,
        "payload": payload,
    })) {
        let js = format!(
            "window.dispatchEvent(new CustomEvent(\"saint:tauri-event\", {{ detail: {detail_json} }}));"
        );
        let _ = window.eval(&js);
    }
}

#[cfg(test)]
pub fn emit_app_event<T: serde::Serialize>(
    _app: &tauri::AppHandle,
    _event: &str,
    _payload: &T,
) {
}

#[cfg(not(test))]
pub fn emit_app_event<T: serde::Serialize>(
    app: &tauri::AppHandle,
    event: &str,
    payload: &T,
) {
    let _ = app.emit(event, payload);
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(detail_json) = serde_json::to_string(&serde_json::json!({
            "event": event,
            "payload": payload,
        })) {
            let js = format!(
                "window.dispatchEvent(new CustomEvent(\"saint:tauri-event\", {{ detail: {detail_json} }}));"
            );
            let _ = window.eval(&js);
        }
    }
}

#[tauri::command]
async fn desktop_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileInput {
    default_filename: String,
    contents: String,
    filters: Option<Vec<SaveFileFilter>>,
}

#[tauri::command]
async fn desktop_save_file(
    app: tauri::AppHandle,
    input: SaveFileInput,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file().set_file_name(&input.default_filename);
    if let Some(filters) = input.filters.as_ref() {
        for filter in filters {
            let ext_refs: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            if !ext_refs.is_empty() {
                builder = builder.add_filter(&filter.name, &ext_refs);
            }
        }
    }
    let target = builder.blocking_save_file();
    let Some(file_path) = target.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    std::fs::write(&file_path, input.contents.as_bytes()).map_err(|e| e.to_string())?;
    Ok(Some(file_path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn desktop_confirm(app: tauri::AppHandle, message: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let confirmed = app
        .dialog()
        .message(message)
        .title(APP_DISPLAY_NAME)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();
    Ok(confirmed)
}

#[tauri::command]
fn desktop_set_theme(webview: tauri::Webview, theme: String) -> Result<(), String> {
    let window = webview.window();
    let parsed = match theme.as_str() {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    window.set_theme(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_set_window_material(
    webview: tauri::Webview,
    input: DesktopWindowMaterial,
) -> bool {
    let window = webview.window();
    apply_window_material(&window, input)
}

fn append_context_menu_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request_id: &str,
    label: &str,
    children: &[ResolvedContextMenuNode],
) -> Result<tauri::menu::Submenu<R>, String> {
    let submenu = tauri::menu::Submenu::new(app, label, true).map_err(|e| e.to_string())?;
    for node in children {
        match node {
            ResolvedContextMenuNode::Separator => {
                let sep =
                    tauri::menu::PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
                submenu.append(&sep).map_err(|e| e.to_string())?;
            }
            ResolvedContextMenuNode::Leaf { id, label } => {
                let menu_id = format!("ctx:{request_id}:{id}");
                let item = tauri::menu::MenuItem::with_id(app, menu_id, label, true, None::<&str>)
                    .map_err(|e| e.to_string())?;
                submenu.append(&item).map_err(|e| e.to_string())?;
            }
            ResolvedContextMenuNode::Submenu {
                label: sub_label,
                children: sub_children,
            } => {
                let nested =
                    append_context_menu_submenu(app, request_id, sub_label, sub_children)?;
                submenu.append(&nested).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(submenu)
}

#[tauri::command]
async fn desktop_context_menu(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    items: Vec<DesktopContextMenuItem>,
    position: Option<ContextMenuPosition>,
) -> Result<Option<String>, String> {
    let window = webview.window();
    let nodes = build_context_menu_nodes(&items, 1);
    if nodes.is_empty() {
        return Ok(None);
    }

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let menu = tauri::menu::Menu::new(&app).map_err(|e| e.to_string())?;
    for node in &nodes {
        match node {
            ResolvedContextMenuNode::Separator => {
                let sep =
                    tauri::menu::PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
                menu.append(&sep).map_err(|e| e.to_string())?;
            }
            ResolvedContextMenuNode::Leaf { id, label } => {
                let menu_id = format!("ctx:{request_id}:{id}");
                let item =
                    tauri::menu::MenuItem::with_id(&app, menu_id, label, true, None::<&str>)
                        .map_err(|e| e.to_string())?;
                menu.append(&item).map_err(|e| e.to_string())?;
            }
            ResolvedContextMenuNode::Submenu { label, children } => {
                let submenu = append_context_menu_submenu(&app, &request_id, label, children)?;
                menu.append(&submenu).map_err(|e| e.to_string())?;
            }
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    if let Ok(mut guard) = state.active_context_menu.lock() {
        if let Some((_, prev_tx)) = guard.take() {
            let _ = prev_tx.send(None);
        }
        *guard = Some((request_id.clone(), tx));
    }

    let popup_res = match position {
        Some(pos) if pos.x.is_finite() && pos.y.is_finite() && pos.x >= 0.0 && pos.y >= 0.0 => {
            window.popup_menu_at(
                &menu,
                tauri::Position::Logical(tauri::LogicalPosition::new(pos.x, pos.y)),
            )
        }
        _ => window.popup_menu(&menu),
    };

    if popup_res.is_err() {
        if let Ok(mut guard) = state.active_context_menu.lock() {
            guard.take();
        }
        return Ok(None);
    }

    // Native `popup_menu` blocks until the menu closes on Windows/macOS and dispatches
    // `on_menu_event` either during or immediately after returning. On Linux (GTK3 / `muda`),
    // `popup_menu` returns immediately while the menu stays open asynchronously, so awaiting `rx`
    // avoids canceling the active menu after 200ms before the user clicks an item.
    #[cfg(target_os = "linux")]
    let selected = rx.await.ok().flatten();
    #[cfg(not(target_os = "linux"))]
    let selected = match tokio::time::timeout(std::time::Duration::from_millis(200), rx).await {
        Ok(Ok(selected)) => selected,
        _ => None,
    };
    if selected.is_none() {
        if let Ok(mut guard) = state.active_context_menu.lock() {
            if guard.as_ref().map(|(id, _)| id == &request_id).unwrap_or(false) {
                guard.take();
            }
        }
    }
    Ok(selected)
}

// Paths of the OS drag in progress: the page may read only these files.
static DROPPED_PATHS: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn forward_file_drag(app: &tauri::AppHandle, drag: &tauri::DragDropEvent) {
    let describe = |paths: &[PathBuf]| -> Vec<serde_json::Value> {
        paths
            .iter()
            .map(|p| serde_json::json!({ "path": p.to_string_lossy(), "isDirectory": p.is_dir() }))
            .collect()
    };
    let payload = match drag {
        tauri::DragDropEvent::Enter { paths, position } => {
            if let Ok(mut guard) = DROPPED_PATHS.lock() {
                *guard = paths.clone();
            }
            serde_json::json!({ "type": "enter", "files": describe(paths), "x": position.x, "y": position.y })
        }
        tauri::DragDropEvent::Over { position } => {
            serde_json::json!({ "type": "over", "x": position.x, "y": position.y })
        }
        tauri::DragDropEvent::Drop { paths, position } => {
            if let Ok(mut guard) = DROPPED_PATHS.lock() {
                *guard = paths.clone();
            }
            serde_json::json!({ "type": "drop", "files": describe(paths), "x": position.x, "y": position.y })
        }
        tauri::DragDropEvent::Leave => serde_json::json!({ "type": "leave" }),
        _ => return,
    };
    emit_app_event(app, "desktop:file-drag", &payload);
}

// Bytes of one file from the last OS drop, base64; refuses any other path or oversized files.
#[tauri::command]
fn desktop_read_dropped_file(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let path = PathBuf::from(path);
    let allowed = DROPPED_PATHS.lock().map(|g| g.contains(&path)).unwrap_or(false);
    if !allowed {
        return Err("not a dropped file".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "dropped file exceeds maximum inline size ({} MB)",
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "dropped file exceeds maximum inline size ({} MB)",
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

const CLIPBOARD_IO_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1_500);
#[cfg(target_os = "linux")]
const WAYLAND_CLIPBOARD_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

#[cfg(any(target_os = "linux", test))]
fn wayland_clipboard_mime_list_has_any_image(raw: &str) -> bool {
    raw.lines()
        .any(|line| line.trim().to_ascii_lowercase().starts_with("image/"))
}

#[cfg(any(target_os = "linux", test))]
fn linux_clipboard_preferred_image_mime(raw: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if !lower.starts_with("image/") {
            continue;
        }
        if lower == "image/png" {
            return Some("image/png".to_string());
        }
        if fallback.is_none()
            && matches!(
                lower.as_str(),
                "image/jpeg" | "image/jpg" | "image/webp" | "image/bmp" | "image/gif" | "image/tiff"
            )
        {
            fallback = Some(trimmed.to_string());
        }
    }
    fallback
}

#[cfg(target_os = "linux")]
fn decode_linux_image_bytes_to_png(mime: &str, bytes: &[u8]) -> Option<Vec<u8>> {
    if mime.eq_ignore_ascii_case("image/png") && bytes.starts_with(b"\x89PNG") {
        return Some(bytes.to_vec());
    }
    use gtk::gdk_pixbuf::prelude::PixbufLoaderExt as _;
    let loader = gtk::gdk_pixbuf::PixbufLoader::with_mime_type(mime)
        .or_else(|_| Ok::<_, gtk::glib::Error>(gtk::gdk_pixbuf::PixbufLoader::new()))
        .ok()?;
    loader.write(bytes).ok()?;
    loader.close().ok()?;
    let pixbuf = loader.pixbuf()?;
    pixbuf.save_to_bufferv("png", &[]).ok()
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum GtkClipboardImageOutcome {
    Image(Vec<u8>),
    NoImage,
    UnavailableOrTimedOut,
}

#[cfg(any(target_os = "linux", test))]
fn linux_atom_names_have_any_image<'a>(names: impl IntoIterator<Item = &'a str>) -> bool {
    names
        .into_iter()
        .any(|name| name.trim().to_ascii_lowercase().starts_with("image/"))
}

/// Reads an image from the native GTK3 clipboard asynchronously on the main loop with zero
/// synchronous `wait_for_*` calls (preventing self-owned clipboard deadlocks). Checks advertised
/// `TARGETS` MIME atoms first so text/URL clipboards return `NoImage` immediately without asking
/// the clipboard owner app to synthesize image data. Works natively on KDE Plasma Wayland, GNOME
/// Wayland, Sway, and X11 without requiring `wl-paste` or `xclip`.
#[cfg(target_os = "linux")]
async fn read_linux_gtk_clipboard_image_png(app: &tauri::AppHandle) -> GtkClipboardImageOutcome {
    let (tx, rx) = tokio::sync::oneshot::channel::<GtkClipboardImageOutcome>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_dispatch = std::sync::Arc::clone(&tx);
    let dispatched = app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let targets_atom = gtk::gdk::Atom::intern("TARGETS");
        clipboard.request_contents(&targets_atom, move |clipboard, selection_data| {
            let finish = |outcome: GtkClipboardImageOutcome| {
                if let Some(sender) = tx_dispatch.lock().ok().and_then(|mut g| g.take()) {
                    let _ = sender.send(outcome);
                }
            };
            if let Some(targets) = selection_data.targets() {
                let target_names: Vec<String> =
                    targets.iter().map(|atom| atom.name().to_string()).collect();
                let has_image = selection_data.targets_include_image(false)
                    || linux_atom_names_have_any_image(target_names.iter().map(String::as_str));
                if !has_image {
                    finish(GtkClipboardImageOutcome::NoImage);
                    return;
                }
            }
            let tx_img = std::sync::Arc::clone(&tx_dispatch);
            clipboard.request_image(move |_clipboard, pixbuf| {
                let outcome = match pixbuf.and_then(|pb| pb.save_to_bufferv("png", &[]).ok()) {
                    Some(png) if png.starts_with(b"\x89PNG") => GtkClipboardImageOutcome::Image(png),
                    _ => GtkClipboardImageOutcome::NoImage,
                };
                if let Some(sender) = tx_img.lock().ok().and_then(|mut g| g.take()) {
                    let _ = sender.send(outcome);
                }
            });
        });
    });
    if dispatched.is_err() {
        return GtkClipboardImageOutcome::UnavailableOrTimedOut;
    }
    match tokio::time::timeout(CLIPBOARD_IO_TIMEOUT, rx).await {
        Ok(Ok(outcome)) => outcome,
        _ => GtkClipboardImageOutcome::UnavailableOrTimedOut,
    }
}

#[cfg(target_os = "linux")]
async fn write_linux_gtk_clipboard_text(app: &tauri::AppHandle, text: String) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let dispatched = app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        clipboard.set_text(&text);
        clipboard.store();
        let _ = tx.send(true);
    });
    if dispatched.is_err() {
        return false;
    }
    matches!(
        tokio::time::timeout(CLIPBOARD_IO_TIMEOUT, rx).await,
        Ok(Ok(true))
    )
}

#[cfg(target_os = "linux")]
async fn write_linux_gtk_clipboard_image_png(app: &tauri::AppHandle, png_bytes: Vec<u8>) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let dispatched = app.run_on_main_thread(move || {
        use gtk::gdk_pixbuf::prelude::PixbufLoaderExt as _;
        let ok = (|| -> Option<()> {
            let loader = gtk::gdk_pixbuf::PixbufLoader::with_type("png").ok()?;
            loader.write(&png_bytes).ok()?;
            loader.close().ok()?;
            let pixbuf = loader.pixbuf()?;
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            clipboard.set_image(&pixbuf);
            clipboard.store();
            Some(())
        })()
        .is_some();
        let _ = tx.send(ok);
    });
    if dispatched.is_err() {
        return false;
    }
    matches!(
        tokio::time::timeout(CLIPBOARD_IO_TIMEOUT, rx).await,
        Ok(Ok(true))
    )
}

#[cfg(target_os = "linux")]
fn run_command_output_bounded(
    program: &str,
    args: &[&str],
    stdin_bytes: Option<&[u8]>,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};

    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if stdin_bytes.is_some() {
        command.stdin(Stdio::piped());
    } else {
        command.stdin(Stdio::null());
    }
    let mut child = command.spawn().ok()?;
    if let Some(bytes) = stdin_bytes {
        let mut stdin = child.stdin.take()?;
        if stdin.write_all(bytes).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        drop(stdin);
    }
    let mut stdout_pipe = child.stdout.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = stdout_pipe.take() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader.join().unwrap_or_default();
                return Some(std::process::Output {
                    status,
                    stdout,
                    stderr: Vec::new(),
                });
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                return None;
            }
        }
    }
}

// WebKitGTK hands the page no files for a pasted screenshot, so the composer asks for the
// clipboard image here when a paste carries neither files nor text.
// Runs off the GTK/UI main thread with strict timeouts so Wayland/X11 clipboard queries
// can never deadlock the window when pasting links or self-owned clipboard selections.
#[tauri::command]
async fn desktop_clipboard_read_image_png(app: tauri::AppHandle) -> Option<String> {
    use base64::Engine as _;
    let encode = |png: Vec<u8>| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    };

    // On Linux (KDE/GNOME/Sway Wayland and X11), read via GTK3's async clipboard API first so
    // image paste works natively without requiring `wl-paste` or `xclip` and without blocking
    // the main loop on self-owned clipboard selections. When GTK3 definitively confirms there is
    // no image on the clipboard (e.g. text/link paste), return immediately — never fall through
    // to X11/XWayland `arboard` polling which can hang and leak blocking threads.
    #[cfg(target_os = "linux")]
    match read_linux_gtk_clipboard_image_png(&app).await {
        GtkClipboardImageOutcome::Image(png_bytes) => return Some(encode(png_bytes)),
        GtkClipboardImageOutcome::NoImage => return None,
        GtkClipboardImageOutcome::UnavailableOrTimedOut => {}
    }

    let task = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(not(target_os = "linux"))]
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // Fallback only when GTK3 was unavailable or timed out: probe Wayland via `wl-paste`
        // or X11 via `xclip` with bounded timeouts.
        #[cfg(target_os = "linux")]
        let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        #[cfg(target_os = "linux")]
        if is_wayland {
            if let Some(types_out) = run_command_output_bounded(
                "wl-paste",
                &["--list-types"],
                None,
                WAYLAND_CLIPBOARD_LIST_TIMEOUT,
            ) {
                if types_out.status.success() {
                    let mime_list = String::from_utf8_lossy(&types_out.stdout);
                    if !wayland_clipboard_mime_list_has_any_image(&mime_list) {
                        return None;
                    }
                    if let Some(mime) = linux_clipboard_preferred_image_mime(&mime_list) {
                        if let Some(out) = run_command_output_bounded(
                            "wl-paste",
                            &["--no-newline", "--type", &mime],
                            None,
                            CLIPBOARD_IO_TIMEOUT,
                        ) {
                            if out.status.success() {
                                if let Some(png) = decode_linux_image_bytes_to_png(&mime, &out.stdout) {
                                    return Some(encode(png));
                                }
                            }
                        }
                    }
                }
            }
        }
        #[cfg(target_os = "linux")]
        if std::env::var_os("DISPLAY").is_some() {
            if let Some(targets_out) = run_command_output_bounded(
                "xclip",
                &["-selection", "clipboard", "-t", "TARGETS", "-o"],
                None,
                WAYLAND_CLIPBOARD_LIST_TIMEOUT,
            ) {
                if targets_out.status.success() {
                    let mime_list = String::from_utf8_lossy(&targets_out.stdout);
                    if !wayland_clipboard_mime_list_has_any_image(&mime_list) {
                        return None;
                    }
                    if let Some(mime) = linux_clipboard_preferred_image_mime(&mime_list) {
                        if let Some(out) = run_command_output_bounded(
                            "xclip",
                            &["-selection", "clipboard", "-t", &mime, "-o"],
                            None,
                            CLIPBOARD_IO_TIMEOUT,
                        ) {
                            if out.status.success() {
                                if let Some(png) = decode_linux_image_bytes_to_png(&mime, &out.stdout) {
                                    return Some(encode(png));
                                }
                            }
                        }
                    }
                }
            }
        }
        // `arboard` in tauri-plugin-clipboard-manager uses X11-only x11rb on Linux and can hang
        // waiting for SelectionNotify on Wayland/XWayland bridges. Never invoke it on Wayland.
        #[cfg(target_os = "linux")]
        if is_wayland {
            return None;
        }
        #[cfg(target_os = "linux")]
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let image = app.clipboard().read_image().ok()?;
        let mut png_bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, image.width(), image.height());
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(image.rgba()).ok()?;
        }
        Some(encode(png_bytes))
    });
    match tokio::time::timeout(CLIPBOARD_IO_TIMEOUT + std::time::Duration::from_millis(250), task)
        .await
    {
        Ok(Ok(result)) => result,
        _ => None,
    }
}

#[tauri::command]
async fn desktop_clipboard_write_image(app: tauri::AppHandle, data_url: String) -> bool {
    let Some(png_bytes) = decode_clipboard_png_data_url(&data_url) else {
        return false;
    };
    #[cfg(target_os = "linux")]
    if write_linux_gtk_clipboard_image_png(&app, png_bytes.clone()).await {
        return true;
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let Ok(image) = tauri::image::Image::from_bytes(&png_bytes) else {
            return false;
        };
        if app.clipboard().write_image(&image).is_ok() {
            return true;
        }
        // Mirror `wl-paste` / `xclip` fallbacks for Linux sessions where arboard cannot access
        // the clipboard directly.
        #[cfg(target_os = "linux")]
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            if let Some(out) = run_command_output_bounded(
                "wl-copy",
                &["--type", "image/png"],
                Some(&png_bytes),
                CLIPBOARD_IO_TIMEOUT,
            ) {
                if out.status.success() {
                    return true;
                }
            }
        }
        #[cfg(target_os = "linux")]
        if std::env::var_os("DISPLAY").is_some() {
            if let Some(out) = run_command_output_bounded(
                "xclip",
                &["-selection", "clipboard", "-t", "image/png", "-i"],
                Some(&png_bytes),
                CLIPBOARD_IO_TIMEOUT,
            ) {
                if out.status.success() {
                    return true;
                }
            }
        }
        false
    });
    matches!(
        tokio::time::timeout(CLIPBOARD_IO_TIMEOUT + std::time::Duration::from_millis(250), task)
            .await,
        Ok(Ok(true))
    )
}

fn install_app_menu(app_handle: &tauri::AppHandle, accelerators: &DesktopMenuAccelerators) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let terminal_new = MenuItem::with_id(
            app_handle,
            "menu:terminal.new",
            "New Terminal",
            true,
            accelerators.terminal_new.as_deref(),
        )?;
        let close_window = PredefinedMenuItem::close_window(app_handle, None)?;
        let file_menu = Submenu::with_items(app_handle, "File", true, &[&terminal_new, &close_window])?;

        #[cfg(not(target_os = "linux"))]
        let edit_menu = {
            let undo = PredefinedMenuItem::undo(app_handle, None)?;
            let redo = PredefinedMenuItem::redo(app_handle, None)?;
            let edit_sep = PredefinedMenuItem::separator(app_handle)?;
            let cut = PredefinedMenuItem::cut(app_handle, None)?;
            let copy = PredefinedMenuItem::copy(app_handle, None)?;
            let paste = PredefinedMenuItem::paste(app_handle, None)?;
            let select_all = PredefinedMenuItem::select_all(app_handle, None)?;
            Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[&undo, &redo, &edit_sep, &cut, &copy, &paste, &select_all],
            )?
        };

        let sidebar_toggle = MenuItem::with_id(
            app_handle,
            "menu:sidebar.toggle",
            "Toggle Sidebar",
            true,
            accelerators.sidebar_toggle.as_deref(),
        )?;
        let browser_toggle = MenuItem::with_id(
            app_handle,
            "menu:browser.toggle",
            "Toggle Browser",
            true,
            accelerators.browser_toggle.as_deref(),
        )?;
        let fullscreen = PredefinedMenuItem::fullscreen(app_handle, None)?;
        let view_sep = PredefinedMenuItem::separator(app_handle)?;
        let view_menu = Submenu::with_items(
            app_handle,
            "View",
            true,
            &[&sidebar_toggle, &browser_toggle, &view_sep, &fullscreen],
        )?;

        let minimize = PredefinedMenuItem::minimize(app_handle, None)?;
        let maximize = PredefinedMenuItem::maximize(app_handle, None)?;
        let win_sep = PredefinedMenuItem::separator(app_handle)?;
        let win_close = PredefinedMenuItem::close_window(app_handle, None)?;
        let window_menu = Submenu::with_items(
            app_handle,
            "Window",
            true,
            &[&minimize, &maximize, &win_sep, &win_close],
        )?;

        #[cfg(target_os = "macos")]
        {
            let about = PredefinedMenuItem::about(app_handle, None, None)?;
            let sep1 = PredefinedMenuItem::separator(app_handle)?;
            let services = PredefinedMenuItem::services(app_handle, None)?;
            let sep2 = PredefinedMenuItem::separator(app_handle)?;
            let hide = PredefinedMenuItem::hide(app_handle, None)?;
            let hide_others = PredefinedMenuItem::hide_others(app_handle, None)?;
            let show_all = PredefinedMenuItem::show_all(app_handle, None)?;
            let sep3 = PredefinedMenuItem::separator(app_handle)?;
            let quit = PredefinedMenuItem::quit(app_handle, None)?;
            let app_menu = Submenu::with_items(
                app_handle,
                APP_DISPLAY_NAME,
                true,
                &[
                    &about,
                    &sep1,
                    &services,
                    &sep2,
                    &hide,
                    &hide_others,
                    &show_all,
                    &sep3,
                    &quit,
                ],
            )?;
            Menu::with_items(
                app_handle,
                &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu],
            )
        }
        #[cfg(target_os = "linux")]
        {
            // Omit the hidden Edit submenu on Linux GTK3: muda's predefined Undo/Redo items
            // attach disabled GTK accelerators and Copy/Cut/Paste are no-ops without libxdo,
            // so letting WebKitGTK handle native editing shortcuts directly avoids conflicts.
            Menu::with_items(app_handle, &[&file_menu, &view_menu, &window_menu])
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "linux")))]
        {
            Menu::with_items(app_handle, &[&file_menu, &edit_menu, &view_menu, &window_menu])
        }
    };

    match build() {
        Ok(menu) => {
            if let Err(err) = app_handle.set_menu(menu) {
                eprintln!("[saint-desktop-rust] Failed to install application menu: {err}");
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.hide_menu();
            }
        }
        Err(err) => {
            eprintln!("[saint-desktop-rust] Failed to build application menu: {err}");
        }
    }
}

#[tauri::command]
fn desktop_set_menu_shortcuts(
    app_handle: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    shortcuts: DesktopMenuShortcuts,
) {
    let resolved = resolve_reported_menu_accelerators(&shortcuts, std::env::consts::OS);
    if let Ok(mut guard) = state.menu_accelerators.write() {
        *guard = resolved.clone();
    }
    install_app_menu(&app_handle, &resolved);
}

#[tauri::command]
fn desktop_quit_confirmation_response(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    response: DesktopQuitConfirmationResponse,
) {
    let allow_quit = match response {
        DesktopQuitConfirmationResponse::Ready {
            request_id,
            running_count,
            ..
        } => {
            let matches_pending = state
                .pending_quit_request_id
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .map(|pending| pending == request_id)
                .unwrap_or(false);
            if matches_pending {
                // Renderer acknowledged the quit prompt; cancel the unresponsive-renderer 3s timer
                // even when `running_count > 0` so the modal stays open until the user decides.
                if let Ok(mut guard) = state.awaiting_quit_ready_id.lock() {
                    if guard.as_deref() == Some(request_id.as_str()) {
                        *guard = None;
                    }
                }
            }
            if matches_pending && running_count <= 0 {
                if let Ok(mut guard) = state.pending_quit_request_id.lock() {
                    *guard = None;
                }
            }
            matches_pending && running_count <= 0
        }
        DesktopQuitConfirmationResponse::Decision { request_id, allow } => {
            let matches_pending = state
                .pending_quit_request_id
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .map(|pending| pending == request_id)
                .unwrap_or(false);
            if matches_pending {
                if let Ok(mut guard) = state.awaiting_quit_ready_id.lock() {
                    if guard.as_deref() == Some(request_id.as_str()) {
                        *guard = None;
                    }
                }
                if let Ok(mut guard) = state.pending_quit_request_id.lock() {
                    *guard = None;
                }
            }
            matches_pending && allow
        }
    };

    if allow_quit {
        state.quit_allowed.store(true, Ordering::SeqCst);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.close();
        } else {
            app.exit(0);
        }
    }
}

#[tauri::command]
fn desktop_open_external(url: String) -> Result<bool, String> {
    if !is_trusted_external_url(&url) {
        return Ok(false);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Not `cmd /C start`: cmd re-parses the URL, so `&` in a query string
        // would start a second command.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url.trim()])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = std::process::Command::new("xdg-open");
        clear_injected_linux_webkit_env(&mut cmd);
        cmd.arg(&url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
fn desktop_show_in_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    reveal_path_in_file_manager(&target)
}

#[tauri::command]
fn desktop_window_minimize(webview: tauri::Webview) -> Result<(), String> {
    let window = webview.window();
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_window_toggle_maximize(
    webview: tauri::Webview,
) -> Result<DesktopWindowState, String> {
    let window = webview.window();
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    let state = DesktopWindowState {
        is_maximized: window.is_maximized().unwrap_or(false),
        is_fullscreen: window.is_fullscreen().unwrap_or(false),
    };
    emit_window_event(&webview, "desktop:window-state", &state);
    Ok(state)
}

#[tauri::command]
fn desktop_window_close(webview: tauri::Webview) -> Result<(), String> {
    let window = webview.window();
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_window_get_state(webview: tauri::Webview) -> DesktopWindowState {
    let window = webview.window();
    DesktopWindowState {
        is_maximized: window.is_maximized().unwrap_or(false),
        is_fullscreen: window.is_fullscreen().unwrap_or(false),
    }
}

#[tauri::command]
fn desktop_custom_title_bar_get_state(
    state: State<'_, Arc<DesktopSharedState>>,
) -> DesktopCustomTitleBarState {
    let platform = std::env::consts::OS;
    let pref = read_custom_title_bar_preference(&state.paths.custom_title_bar_path);
    resolve_desktop_custom_title_bar_state(platform, pref, state.custom_title_bar_active)
}

#[tauri::command]
fn desktop_custom_title_bar_set_preference(
    state: State<'_, Arc<DesktopSharedState>>,
    enabled: bool,
) -> Result<DesktopCustomTitleBarState, String> {
    write_custom_title_bar_preference(&state.paths.custom_title_bar_path, enabled)
        .map_err(|e| e.to_string())?;
    let platform = std::env::consts::OS;
    Ok(resolve_desktop_custom_title_bar_state(
        platform,
        Some(enabled),
        state.custom_title_bar_active,
    ))
}

#[tauri::command]
fn desktop_custom_title_bar_relaunch(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
) {
    cleanup_all_managed_resources(&state);
    state.backend.kill_sync();
    app.restart();
}

#[tauri::command]
fn desktop_computer_preview_subscribe(state: State<'_, Arc<DesktopSharedState>>) {
    state.cua_host.subscribe_preview();
}

#[tauri::command]
fn desktop_computer_preview_unsubscribe(state: State<'_, Arc<DesktopSharedState>>) {
    state.cua_host.unsubscribe_preview();
}

#[tauri::command]
fn desktop_computer_set_cursor_style(
    state: State<'_, Arc<DesktopSharedState>>,
    style: Option<AgentCursorStylePreference>,
) -> Result<(), String> {
    state.cua_host.set_cursor_style(style)
}

#[tauri::command]
fn desktop_audio_level_set_source(
    state: State<'_, Arc<DesktopSharedState>>,
    source: Option<String>,
    microphone_id: Option<String>,
) -> &'static str {
    state.appsnap.set_audio_source(source, microphone_id)
}

#[tauri::command]
async fn desktop_audio_level_list_microphones(
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<Vec<DesktopAudioInputDevice>, String> {
    let appsnap = Arc::clone(&state.appsnap);
    tokio::task::spawn_blocking(move || appsnap.list_microphones())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_storage_migration_acknowledge(state: State<'_, Arc<DesktopSharedState>>) {
    acknowledge_saint_storage_snapshot(&state.paths.storage_snapshot_path);
}

#[tauri::command]
async fn desktop_server_transcribe_voice(
    state: State<'_, Arc<DesktopSharedState>>,
    input: VoiceTranscriptionInput,
) -> Result<VoiceTranscriptionResult, String> {
    state.backend.transcribe_voice(input).await
}

#[tauri::command]
fn desktop_update_get_state(state: State<'_, Arc<DesktopSharedState>>) -> DesktopUpdateState {
    state.updater.get_state()
}

// Electron Saint checked 15 s after launch and every 4 h, then downloaded in the
// background so the sidebar offers "restart to update" without a manual check.
const AUTO_UPDATE_STARTUP_DELAY: std::time::Duration = std::time::Duration::from_secs(15);
const AUTO_UPDATE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(4 * 60 * 60);
// The updater's HTTP client has no timeout of its own, so a stalled GitHub
// connection used to leave the update in "checking"/"downloading" forever and
// stop the poll loop with it.
const UPDATE_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const UPDATE_DOWNLOAD_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const UPDATE_DOWNLOAD_STALL_POLL: std::time::Duration = std::time::Duration::from_secs(5);

async fn check_for_update_with_timeout(
    updater: &tauri_plugin_updater::Updater,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    match tokio::time::timeout(UPDATE_CHECK_TIMEOUT, updater.check()).await {
        Ok(result) => result.map_err(|err| err.to_string()),
        Err(_) => Err(format!(
            "Timed out after {}s checking for updates.",
            UPDATE_CHECK_TIMEOUT.as_secs()
        )),
    }
}

fn spawn_auto_update_poll(app: tauri::AppHandle, state: Arc<DesktopSharedState>) {
    if !state.updater.get_state().enabled {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_UPDATE_STARTUP_DELAY).await;
        loop {
            if run_update_check(&app, &state).await.status == "available" {
                run_update_download(&app, &state).await;
            }
            tokio::time::sleep(AUTO_UPDATE_POLL_INTERVAL).await;
        }
    });
}

#[tauri::command]
async fn desktop_update_check(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<DesktopUpdateState, String> {
    let next = run_update_check(&app, state.inner()).await;
    // A manual check (sidebar or Settings) must start the download too: the web
    // disables the button while an update is "available", so without this the
    // update sat on "Preparing" until the next 4 h poll.
    if next.status == "available" {
        let app = app.clone();
        let state = Arc::clone(state.inner());
        tauri::async_runtime::spawn(async move {
            run_update_download(&app, &state).await;
        });
    }
    Ok(next)
}

async fn run_update_check(
    app: &tauri::AppHandle,
    state: &Arc<DesktopSharedState>,
) -> DesktopUpdateState {
    use tauri_plugin_updater::UpdaterExt;

    let (accepted, checking) = state.updater.begin_check();
    if !accepted || !checking.enabled {
        return checking;
    }
    emit_app_event(app, "desktop:update-state", &checking);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => {
            let up_to_date = state.updater.mark_up_to_date(now_iso8601());
            emit_app_event(app, "desktop:update-state", &up_to_date);
            return up_to_date;
        }
    };

    let next_state = match check_for_update_with_timeout(&updater).await {
        Ok(Some(update)) => {
            let candidate = update.version.clone();
            let current = state.updater.get_state().current_version;
            if is_update_version_allowed_for_stable(&candidate)
                && is_update_version_newer(&current, &candidate)
            {
                state.updater.mark_available(candidate, now_iso8601())
            } else {
                state.updater.mark_up_to_date(now_iso8601())
            }
        }
        Ok(None) => state.updater.mark_up_to_date(now_iso8601()),
        Err(err) => state.updater.mark_error("check", err),
    };

    emit_app_event(app, "desktop:update-state", &next_state);
    next_state
}

#[tauri::command]
async fn desktop_update_download(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<DesktopUpdateActionResult, String> {
    Ok(run_update_download(&app, state.inner()).await)
}

async fn run_update_download(
    app: &tauri::AppHandle,
    state: &Arc<DesktopSharedState>,
) -> DesktopUpdateActionResult {
    use tauri_plugin_updater::UpdaterExt;

    let (accepted, initial) = state.updater.begin_download();
    if !accepted {
        return DesktopUpdateActionResult {
            accepted: false,
            completed: false,
            state: initial,
        };
    }
    emit_app_event(app, "desktop:update-state", &initial);

    let Ok(updater) = app.updater() else {
        let err_state = state
            .updater
            .mark_error("download", "Updater is not configured.".to_string());
        emit_app_event(app, "desktop:update-state", &err_state);
        return DesktopUpdateActionResult {
            accepted: true,
            completed: false,
            state: err_state,
        };
    };

    match check_for_update_with_timeout(&updater).await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let current = state.updater.get_state().current_version;
            if !is_update_version_allowed_for_stable(&version)
                || !is_update_version_newer(&current, &version)
            {
                let up_to_date = state.updater.mark_up_to_date(now_iso8601());
                emit_app_event(app, "desktop:update-state", &up_to_date);
                return DesktopUpdateActionResult {
                    accepted: false,
                    completed: false,
                    state: up_to_date,
                };
            }
            let state_progress = Arc::clone(state);
            let app_progress = app.clone();
            let mut transferred: u64 = 0;
            let mut last_whole_pct: i64 = -1;
            let started = std::time::Instant::now();
            let last_progress_ms = Arc::new(AtomicU64::new(0));
            let progress_ms = Arc::clone(&last_progress_ms);
            let download = update.download(
                move |chunk_len, total_len| {
                    progress_ms.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                    transferred += chunk_len as u64;
                    if let Some(total) = total_len.filter(|t| *t > 0) {
                        let pct = (transferred as f64 / total as f64) * 100.0;
                        // One event per whole percent instead of one per network chunk.
                        let whole = pct.floor() as i64;
                        if whole != last_whole_pct {
                            last_whole_pct = whole;
                            let next = state_progress.updater.update_download_progress(pct);
                            emit_app_event(&app_progress, "desktop:update-state", &next);
                        }
                    }
                },
                || {},
            );
            let stall_ms = UPDATE_DOWNLOAD_STALL_TIMEOUT.as_millis() as u64;
            let stalled = async {
                loop {
                    tokio::time::sleep(UPDATE_DOWNLOAD_STALL_POLL).await;
                    let now = started.elapsed().as_millis() as u64;
                    if now.saturating_sub(last_progress_ms.load(Ordering::Relaxed)) > stall_ms {
                        break;
                    }
                }
            };
            let download_res: Result<Vec<u8>, String> = tokio::select! {
                res = download => res.map_err(|err| err.to_string()),
                () = stalled => Err(format!(
                    "Update download stalled: no data for {}s.",
                    UPDATE_DOWNLOAD_STALL_TIMEOUT.as_secs()
                )),
            };

            match download_res {
                Ok(bytes) => {
                    state
                        .updater
                        .store_downloaded_payload(version.clone(), bytes);
                    let done = state.updater.mark_downloaded(version);
                    emit_app_event(app, "desktop:update-state", &done);
                    DesktopUpdateActionResult {
                        accepted: true,
                        completed: true,
                        state: done,
                    }
                }
                Err(err) => {
                    let err_state = state.updater.mark_error("download", err);
                    emit_app_event(app, "desktop:update-state", &err_state);
                    DesktopUpdateActionResult {
                        accepted: true,
                        completed: false,
                        state: err_state,
                    }
                }
            }
        }
        Ok(None) => {
            let up_to_date = state.updater.mark_up_to_date(now_iso8601());
            emit_app_event(app, "desktop:update-state", &up_to_date);
            DesktopUpdateActionResult {
                accepted: false,
                completed: false,
                state: up_to_date,
            }
        }
        Err(err) => {
            let err_state = state.updater.mark_error("download", err.to_string());
            emit_app_event(app, "desktop:update-state", &err_state);
            DesktopUpdateActionResult {
                accepted: true,
                completed: false,
                state: err_state,
            }
        }
    }
}

#[tauri::command]
async fn desktop_update_install(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<DesktopUpdateActionResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    let (accepted, installing) = state.updater.begin_install();
    if !accepted {
        return Ok(DesktopUpdateActionResult {
            accepted: false,
            completed: false,
            state: installing,
        });
    }
    emit_window_event(&webview, "desktop:update-state", &installing);

    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = check_for_update_with_timeout(&updater).await {
            let candidate = update.version.clone();
            let current = state.updater.get_state().current_version;
            if is_update_version_allowed_for_stable(&candidate)
                && is_update_version_newer(&current, &candidate)
            {
                // Windows hands off to the NSIS installer and exits inside install(), so
                // the sidecar must stop first or the installer cannot replace it.
                #[cfg(windows)]
                {
                    cleanup_all_managed_resources(&state);
                    state.backend.stop_and_wait().await;
                }
                // The cached payload stays stored until a successful install restarts the app.
                let install_res = if let Some(cached_bytes) =
                    state.updater.take_downloaded_payload(&candidate)
                {
                    update.install(cached_bytes)
                } else {
                    update.download_and_install(|_, _| {}, || {}).await
                };

                if let Err(err) = install_res {
                    // The sidecar is already down on Windows; relaunch to bring it back.
                    #[cfg(windows)]
                    app.request_restart();
                    let err_state = state.updater.mark_error("install", err.to_string());
                    emit_window_event(&webview, "desktop:update-state", &err_state);
                    return Ok(DesktopUpdateActionResult {
                        accepted: true,
                        completed: false,
                        state: err_state,
                    });
                }
                cleanup_all_managed_resources(&state);
                state.backend.stop_and_wait().await;
                app.restart();
            }
        }
    }

    let err_state = state
        .updater
        .mark_error("install", "No downloaded update is ready to install.".to_string());
    emit_window_event(&webview, "desktop:update-state", &err_state);
    Ok(DesktopUpdateActionResult {
        accepted: true,
        completed: false,
        state: err_state,
    })
}

#[tauri::command]
fn desktop_notifications_is_supported() -> bool {
    true
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationShowInput {
    title: String,
    body: Option<String>,
    suppress_when_foreground: Option<bool>,
}

#[tauri::command]
fn desktop_notifications_show(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    input: NotificationShowInput,
) -> Result<bool, String> {
    let window = webview.window();
    use tauri_plugin_notification::NotificationExt;
    if input.title.trim().is_empty() {
        return Ok(false);
    }
    if input.suppress_when_foreground.unwrap_or(false) && window.is_focused().unwrap_or(false) {
        return Ok(false);
    }
    let mut builder = app.notification().builder().title(&input.title);
    if let Some(body) = input.body.as_deref() {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn desktop_appsnap_capture_current_app(
    state: State<'_, Arc<DesktopSharedState>>,
    request_id: String,
) -> Result<serde_json::Value, String> {
    state.appsnap.capture_current_app(&request_id)
}

#[tauri::command]
fn desktop_appsnap_cancel_capture(
    state: State<'_, Arc<DesktopSharedState>>,
    request_id: String,
) {
    state.appsnap.cancel_capture(&request_id);
}

#[tauri::command]
fn desktop_appsnap_get_state(
    state: State<'_, Arc<DesktopSharedState>>,
    _permissions: Option<Vec<String>>,
) -> DesktopAppSnapState {
    state.appsnap.get_state()
}

#[tauri::command]
fn desktop_appsnap_set_enabled(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    enabled: bool,
) -> DesktopAppSnapState {
    let next = state.appsnap.set_enabled(enabled);
    emit_window_event(&webview, "desktop:appsnap-state", &next);
    next
}

#[tauri::command]
fn desktop_appsnap_check_shortcut(
    state: State<'_, Arc<DesktopSharedState>>,
    shortcut: serde_json::Value,
) -> DesktopAppSnapShortcutAvailability {
    state.appsnap.check_shortcut(shortcut)
}

#[tauri::command]
fn desktop_appsnap_set_shortcut(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    shortcut: serde_json::Value,
) -> DesktopAppSnapShortcutUpdateResult {
    let res = state.appsnap.set_shortcut(shortcut);
    emit_window_event(&webview, "desktop:appsnap-state", &res.state);
    res
}

#[tauri::command]
fn desktop_appsnap_request_permissions(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    permissions: Option<Vec<String>>,
) -> DesktopAppSnapState {
    let next = state.appsnap.request_permissions(permissions);
    emit_window_event(&webview, "desktop:appsnap-state", &next);
    next
}

#[tauri::command]
fn desktop_appsnap_start_permission_setup(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    permissions: Vec<String>,
) -> Result<DesktopAppSnapState, String> {
    let next = state.appsnap.start_permission_setup(permissions)?;
    emit_window_event(&webview, "desktop:appsnap-permission-guide-state", &"visible");
    emit_window_event(&webview, "desktop:appsnap-state", &next);
    Ok(next)
}

#[tauri::command]
fn desktop_appsnap_list_pending_captures(
    state: State<'_, Arc<DesktopSharedState>>,
) -> Vec<serde_json::Value> {
    state.appsnap.list_pending_captures()
}

#[tauri::command]
fn desktop_appsnap_acknowledge_capture(
    state: State<'_, Arc<DesktopSharedState>>,
    capture_id: String,
) {
    state.appsnap.acknowledge_capture(&capture_id);
}

#[tauri::command]
async fn desktop_appsnap_list_windows(
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<Vec<serde_json::Value>, String> {
    let appsnap = Arc::clone(&state.appsnap);
    tokio::task::spawn_blocking(move || appsnap.list_windows())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_appsnap_capture_window(
    state: State<'_, Arc<DesktopSharedState>>,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.appsnap.capture_window(&input)
}

#[tauri::command]
fn desktop_appsnap_open_permission_settings(pane: String) -> bool {
    let Some(url) = crate::appsnap::AppSnapHost::parse_settings_pane(&pane) else {
        return false;
    };
    if !cfg!(target_os = "macos") {
        let _ = url;
        return false;
    }
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .is_ok()
}

#[tauri::command]
fn desktop_appsnap_restart_app(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
) {
    cleanup_all_managed_resources(&state);
    state.backend.kill_sync();
    app.restart();
}

#[tauri::command]
fn desktop_appsnap_show_permission_guide(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    pane: String,
) {
    if let Some(guide_state) = state.appsnap.show_permission_guide(&pane) {
        emit_window_event(&webview, "desktop:appsnap-permission-guide-state", &guide_state);
    }
}

#[tauri::command]
fn desktop_appsnap_hide_permission_guide(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
) {
    let guide_state = state.appsnap.hide_permission_guide();
    emit_window_event(&webview, "desktop:appsnap-permission-guide-state", &guide_state);
}

#[tauri::command]
async fn desktop_remote_ssh_get_state(
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<DesktopRemoteSshState, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.get_state())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_remote_ssh_connect(
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<DesktopRemoteSshHostState, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.connect(host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn desktop_remote_ssh_reconnect(
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<DesktopRemoteSshHostState, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.reconnect(host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn desktop_remote_ssh_disconnect(
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
) -> Result<(), String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.disconnect(&host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn desktop_remote_ssh_stop_server(
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<(), String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.stop_server(host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn desktop_remote_ssh_forget(state: State<'_, Arc<DesktopSharedState>>, host: String) {
    state.remote_ssh.forget_host(&host);
}

#[tauri::command]
async fn desktop_remote_ssh_test_host(
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<DesktopRemoteSshTestResult, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.test_host(host))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn desktop_remote_ssh_update_host(
    state: State<'_, Arc<DesktopSharedState>>,
    input: DesktopRemoteSshUpdateHostInput,
) -> Result<DesktopRemoteSshState, String> {
    state.remote_ssh.update_host(input)
}

#[tauri::command]
fn desktop_remote_ssh_ws_url(
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
) -> Option<String> {
    state.remote_ssh.ws_url_for_host(&host)
}

#[tauri::command]
async fn desktop_remote_ssh_forward_port(
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
    remote_port: u16,
) -> Result<String, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    tokio::task::spawn_blocking(move || remote_ssh.forward_port(&host, remote_port))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn desktop_remote_ssh_download_files(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    input: DesktopWorkspaceDownloadInput,
) -> Result<DesktopWorkspaceDownloadResult, String> {
    use crate::remote_ssh::DownloadDestination;
    use tauri_plugin_dialog::DialogExt;
    let requests = state.remote_ssh.download_requests(&input)?;
    let canceled = DesktopWorkspaceDownloadResult {
        canceled: true,
        saved: Vec::new(),
        failures: Vec::new(),
    };
    if requests.is_empty() {
        return Ok(DesktopWorkspaceDownloadResult {
            canceled: false,
            ..canceled
        });
    }
    let downloads = dirs::download_dir();
    let destination = if let [(_, file_name)] = requests.as_slice() {
        let mut dialog = app.dialog().file().set_file_name(file_name);
        if let Some(dir) = downloads.as_ref() {
            dialog = dialog.set_directory(dir);
        }
        match dialog.blocking_save_file().and_then(|f| f.into_path().ok()) {
            Some(path) => DownloadDestination::File(path),
            None => return Ok(canceled),
        }
    } else {
        let mut dialog = app
            .dialog()
            .file()
            .set_title(format!("Download {} files", requests.len()));
        if let Some(dir) = downloads.as_ref() {
            dialog = dialog.set_directory(dir);
        }
        match dialog.blocking_pick_folder().and_then(|f| f.into_path().ok()) {
            Some(path) => DownloadDestination::Directory(path),
            None => return Ok(canceled),
        }
    };
    Ok(crate::remote_ssh::RemoteSshManager::save_downloads(requests, destination).await)
}

#[tauri::command]
async fn desktop_lan_relay_get_state(
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<DesktopLanRelayState, String> {
    let lan_relay = Arc::clone(&state.lan_relay);
    tokio::task::spawn_blocking(move || lan_relay.get_state())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_lan_relay_set_enabled(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: DesktopLanRelaySetEnabledInput,
) -> Result<DesktopLanRelayState, String> {
    let next = state
        .lan_relay
        .set_enabled(input.enabled, input.port, input.bind_address)
        .await;
    emit_window_event(&webview, "desktop:lan-relay-state", &next);
    Ok(next)
}

#[tauri::command]
fn desktop_lan_relay_rotate_pairing_token(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
) -> DesktopLanRelayState {
    let next = state.lan_relay.rotate_pairing_token();
    emit_window_event(&webview, "desktop:lan-relay-state", &next);
    next
}

#[tauri::command]
fn desktop_lan_relay_revoke_session(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: DesktopLanRelayRevokeSessionInput,
) -> DesktopLanRelayState {
    let next = state.lan_relay.revoke_session(&input.session_id);
    emit_window_event(&webview, "desktop:lan-relay-state", &next);
    next
}

#[tauri::command]
fn desktop_lan_relay_revoke_all_sessions(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
) -> DesktopLanRelayState {
    let next = state.lan_relay.revoke_all_sessions();
    emit_window_event(&webview, "desktop:lan-relay-state", &next);
    next
}

#[tauri::command]
fn desktop_browser_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserOpenInput,
) -> ThreadBrowserState {
    let next = state.browser.open(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    state.browser.sync_native_webviews(&app);
    next
}

#[tauri::command]
fn desktop_browser_close(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserThreadInput,
) -> ThreadBrowserState {
    for tab_id in state.browser.tab_ids_for_thread(&input.thread_id) {
        state.browser.close_native_webview(&app, &tab_id);
    }
    let next = state.browser.close(&input.thread_id);
    emit_window_event(&webview, "desktop:browser-state", &next);
    state.browser.sync_native_webviews(&app);
    next
}

#[tauri::command]
fn desktop_browser_hide(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserThreadInput,
) {
    state.browser.hide(&input.thread_id);
    state.browser.sync_native_webviews(&app);
}

#[tauri::command]
fn desktop_browser_get_state(
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserThreadInput,
) -> ThreadBrowserState {
    state.browser.get_state(&input.thread_id)
}

#[tauri::command]
fn desktop_browser_set_bounds(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserSetPanelBoundsInput,
) {
    state.browser.set_panel_bounds(input);
    state.browser.sync_native_webviews(&app);
}

#[tauri::command]
fn desktop_browser_attach_webview(
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserAttachWebviewInput,
) -> ThreadBrowserState {
    state.browser.get_state(&input.thread_id)
}

#[tauri::command]
fn desktop_browser_detach_webview(_input: BrowserAttachWebviewInput) {}

#[tauri::command]
async fn desktop_browser_request_copy_link(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> Result<(), String> {
    if let Some(url) = state.browser.tab_url(&input.thread_id, &input.tab_id) {
        if url != "about:blank" && !url.is_empty() {
            #[cfg(target_os = "linux")]
            let wrote_via_gtk = write_linux_gtk_clipboard_text(&app, url.clone()).await;
            #[cfg(not(target_os = "linux"))]
            let wrote_via_gtk = false;
            if !wrote_via_gtk {
                let url_for_clipboard = url.clone();
                let app_for_clipboard = app.clone();
                let _ = tokio::time::timeout(
                    CLIPBOARD_IO_TIMEOUT,
                    tauri::async_runtime::spawn_blocking(move || {
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        let _ = app_for_clipboard.clipboard().write_text(&url_for_clipboard);
                    }),
                )
                .await;
            }
            emit_window_event(
                &webview,
                "desktop:browser-copy-link",
                &serde_json::json!({
                    "threadId": input.thread_id,
                    "url": url,
                }),
            );
        }
    }
    Ok(())
}

#[tauri::command]
fn desktop_browser_copy_screenshot_to_clipboard(_input: BrowserTabInput) {}

#[tauri::command]
fn desktop_browser_capture_screenshot(
    _input: BrowserTabInput,
) -> Result<BrowserCaptureScreenshotResult, String> {
    // 1x1 valid PNG fallback when offscreen native capture is not active
    use base64::Engine as _;
    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
        .unwrap_or_default();
    Ok(BrowserCaptureScreenshotResult {
        name: "browser-screenshot.png".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: png_bytes.len(),
        bytes: png_bytes,
    })
}

#[tauri::command]
fn desktop_browser_capture_preview(_input: BrowserTabInput) -> Option<String> {
    None
}

#[tauri::command]
fn desktop_browser_navigate(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserNavigateInput,
) -> ThreadBrowserState {
    let explicit_tab_id = input.tab_id.clone();
    let next = state.browser.navigate(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    let target_tab_id = explicit_tab_id.or_else(|| next.active_tab_id.clone());
    if let Some(tab_id) = target_tab_id.as_deref() {
        if let Some(url) = state.browser.tab_url(&next.thread_id, tab_id) {
            state.browser.navigate_native_webview(&app, tab_id, &url);
        }
    }
    next
}

#[tauri::command]
fn desktop_browser_reload(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> ThreadBrowserState {
    state.browser.reload_native_webview(&app, &input.tab_id);
    state.browser.get_state(&input.thread_id)
}

#[tauri::command]
fn desktop_browser_go_back(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> ThreadBrowserState {
    let tab_id = input.tab_id.clone();
    let thread_id = input.thread_id.clone();
    let next = state.browser.go_back(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    if let Some(url) = state.browser.tab_url(&thread_id, &tab_id) {
        state.browser.navigate_native_webview(&app, &tab_id, &url);
    }
    next
}

#[tauri::command]
fn desktop_browser_go_forward(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> ThreadBrowserState {
    let tab_id = input.tab_id.clone();
    let thread_id = input.thread_id.clone();
    let next = state.browser.go_forward(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    if let Some(url) = state.browser.tab_url(&thread_id, &tab_id) {
        state.browser.navigate_native_webview(&app, &tab_id, &url);
    }
    next
}

#[tauri::command]
fn desktop_browser_new_tab(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserNewTabInput,
) -> ThreadBrowserState {
    let next = state.browser.new_tab(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    state.browser.sync_native_webviews(&app);
    next
}

#[tauri::command]
fn desktop_browser_close_tab(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> ThreadBrowserState {
    state.browser.close_native_webview(&app, &input.tab_id);
    let next = state.browser.close_tab(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    state.browser.sync_native_webviews(&app);
    next
}

#[tauri::command]
fn desktop_browser_select_tab(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) -> ThreadBrowserState {
    let next = state.browser.select_tab(input);
    emit_window_event(&webview, "desktop:browser-state", &next);
    state.browser.sync_native_webviews(&app);
    next
}

#[tauri::command]
fn desktop_browser_open_devtools(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) {
    state.browser.open_devtools_native_webview(&app, &input.tab_id);
}

#[tauri::command]
fn desktop_browser_annotations_start(
    state: State<'_, Arc<DesktopSharedState>>,
    input: serde_json::Value,
) -> serde_json::Value {
    let thread_id = input
        .get("threadId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tab_id = input
        .get("tabId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let browser_state = state.browser.get_state(&thread_id);
    let tab = browser_state.tabs.iter().find(|t| t.id == tab_id);
    let source_url = tab
        .map(|t| t.url.clone())
        .unwrap_or_else(|| "about:blank".to_string());
    let page_title = tab.map(|t| t.title.clone()).unwrap_or_default();
    let session_id = uuid::Uuid::new_v4().to_string();
    let key = format!(".saint-annotations-{session_id}.html");
    serde_json::json!({
        "sessionId": session_id,
        "threadId": thread_id,
        "tabId": tab_id,
        "document": {
            "token": uuid::Uuid::new_v4().to_string(),
            "key": key,
            "url": source_url,
        },
        "source": {
            "url": source_url,
            "pageTitle": page_title,
        },
    })
}

#[tauri::command]
fn desktop_browser_annotations_cancel(_input: serde_json::Value) {}

#[tauri::command]
fn desktop_browser_annotations_sync_markers(_input: serde_json::Value) {}

fn build_initialization_script(state: &DesktopSharedState) -> String {
    let snapshot = read_saint_storage_snapshot(&state.paths.storage_snapshot_path);
    let boot_json = serde_json::json!({
        "wsUrl": state.current_ws_url(),
        "zoomFactor": 1.0,
        "windowTranslucency": resolve_window_translucency(),
        "remoteSshEnabled": true,
        "storageMigrationSnapshot": snapshot,
    });
    let compiled_bridge = include_str!("../dist-bridge/preloadBridge.iife.js");
    format!("window.__SAINT_TAURI_BOOT__ = {boot_json};\n{compiled_bridge}")
}

pub fn run() {
    // Must run before GTK/WebKitGTK initialization and before spawning background threads.
    #[cfg(target_os = "linux")]
    configure_linux_webkit_env();
    // The window class must match StartupWMClass in the launcher that
    // scripts/linux/install-saint.sh writes, or the dock shows a separate "saint-desktop" icon.
    #[cfg(target_os = "linux")]
    gtk::glib::set_prgname(Some("saint"));
    let paths = SaintPaths::resolve();
    let _ = paths.ensure_directories();

    let platform = std::env::consts::OS;
    let custom_title_bar_pref = read_custom_title_bar_preference(&paths.custom_title_bar_path);
    let custom_title_bar_active = supports_custom_title_bar(platform)
        && custom_title_bar_pref.unwrap_or_else(|| default_custom_title_bar_preference(platform));

    let shared_state = DesktopSharedState::new(paths, custom_title_bar_active);

    let state_for_menu = Arc::clone(&shared_state);
    let state_for_exit = Arc::clone(&shared_state);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Arc::clone(&shared_state))
        .on_menu_event(move |app_handle, event| {
            let id_str = event.id().as_ref();
            if let Some(rest) = id_str.strip_prefix("ctx:") {
                if let Some((request_id, item_id)) = rest.split_once(':') {
                    if let Ok(mut guard) = state_for_menu.active_context_menu.lock() {
                        if guard
                            .as_ref()
                            .map(|(active_id, _)| active_id == request_id)
                            .unwrap_or(false)
                        {
                            if let Some((_, tx)) = guard.take() {
                                let _ = tx.send(Some(item_id.to_string()));
                            }
                        }
                    }
                }
                return;
            }

            if let Some(action) = id_str.strip_prefix("menu:") {
                emit_app_event(app_handle, "desktop:menu-action", &action);
            }
        })
        .setup(move |app| {
            let state = Arc::clone(&shared_state);
            let app_handle = app.handle().clone();

            spawn_auto_update_poll(app_handle.clone(), Arc::clone(&state));

            // Push every remote SSH state change (connect progress, auto-connect,
            // background reconnects, LAN relay actions) to all open desktop windows,
            // deduplicating identical serialized snapshots so the webview does not re-render
            // redundantly during connects.
            {
                let state_for_ssh = Arc::clone(&state);
                let handle_for_ssh = app_handle.clone();
                let mut rx = state.remote_ssh.subscribe_state_changes();
                tauri::async_runtime::spawn(async move {
                    let mut last_emitted_json: Option<String> = None;
                    loop {
                        match rx.recv().await {
                            Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                // Drain bursts queued while the previous snapshot was being built.
                                while matches!(
                                    rx.try_recv(),
                                    Ok(())
                                        | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(
                                            _,
                                        ))
                                ) {}
                                let remote_ssh = Arc::clone(&state_for_ssh.remote_ssh);
                                let Ok(snapshot) =
                                    tokio::task::spawn_blocking(move || remote_ssh.get_state())
                                        .await
                                else {
                                    continue;
                                };
                                let serialized = serde_json::to_string(&snapshot).ok();
                                if serialized.is_some() && serialized == last_emitted_json {
                                    continue;
                                }
                                last_emitted_json = serialized;
                                emit_app_event(
                                    &handle_for_ssh,
                                    "desktop:remote-ssh-state",
                                    &snapshot,
                                );
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });
            }

            // Start the local RPC pipe server (`SAINT_BROWSER_HOST_PIPE_PATH`) so `apps/server`
            // can invoke `browser_*` tools against the desktop browser manager.
            state.browser.start_rpc_pipe_server(app_handle.clone());

            // Start the Computer-Use host socket (`SAINT_CUA_HOST_SOCKET`) sharing the
            // per-session capability token with `apps/server` and attach the app handle
            // for live `computerPreview.frame` events.
            state.cua_host.attach_app_handle(app_handle.clone());
            state
                .cua_host
                .start_host_socket_server(state.browser.capability().to_string());

            // Start the `saint-server` sidecar in the background and update the window
            // once its HTTP/WS endpoint is ready.
            let state_for_server = Arc::clone(&state);
            let handle_for_server = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let bridge = SidecarRuntimeBridgeConfig {
                    browser_pipe_path: Some(state_for_server.browser.pipe_path().to_string()),
                    browser_capability: Some(state_for_server.browser.capability().to_string()),
                    cua_host_socket: Some(state_for_server.cua_host.socket_path().to_string()),
                    pty_bridge_port: Some(state_for_server.pty_host.bridge_port()),
                    pty_bridge_token: Some(state_for_server.pty_host.bridge_token().to_string()),
                };
                for attempt in 1..=BACKEND_MAX_CONSECUTIVE_START_FAILURES {
                    if state_for_server.backend.is_shutting_down() {
                        break;
                    }
                    match state_for_server
                        .backend
                        .start_and_wait_ready(bridge.clone())
                        .await
                    {
                        Ok(ws_url) => {
                            if !state_for_server.backend.is_shutting_down() {
                                state_for_server.set_ws_url(Some(ws_url.clone()));
                                emit_app_event(&handle_for_server, "desktop:ws-url-changed", &ws_url);
                            }
                            break;
                        }
                        Err(err) => {
                            if state_for_server.backend.is_shutting_down()
                                || state_for_server.backend.is_child_running()
                            {
                                break;
                            }
                            eprintln!(
                                "[saint-desktop-rust] Failed to start saint-server sidecar (attempt {attempt}/{BACKEND_MAX_CONSECUTIVE_START_FAILURES}): {err}"
                            );
                            if attempt < BACKEND_MAX_CONSECUTIVE_START_FAILURES {
                                tokio::time::sleep(std::time::Duration::from_secs(u64::from(
                                    attempt,
                                )))
                                .await;
                            }
                        }
                    }
                }
            });

            let saved_window = if state.paths.is_isolated_dev_instance {
                None
            } else {
                read_desktop_window_state(&state.paths.window_state_path)
            };
            crate::electron_storage::import_electron_local_storage(&state.paths);
            let init_script = build_initialization_script(&state);

            let mut win_builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(APP_DISPLAY_NAME)
                    .min_inner_size(860.0, 600.0)
                    .decorations(!state.custom_title_bar_active)
                    .visible(true)
                    .focused(true)
                    // WebKitGTK gives the page no files for an OS drop, so the native handler takes
                    // it and the bridge replays it as DOM drag events (see `forward_file_drag`).
                    // A drop WebKit still handles must not open the file in place of the app.
                    .on_navigation(|url| url.scheme() != "file")
                    .initialization_script(&init_script);

            #[cfg(target_os = "macos")]
            {
                win_builder = win_builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    .transparent(true);
            }
            #[cfg(target_os = "linux")]
            if resolve_window_translucency().is_some() {
                win_builder = win_builder.transparent(true);
            }

            if let Some(ref persisted) = saved_window {
                let work_areas: Vec<DesktopWindowBounds> = app
                    .available_monitors()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| {
                        let pos = m.position();
                        let size = m.size();
                        physical_to_logical_bounds(
                            pos.x,
                            pos.y,
                            size.width,
                            size.height,
                            m.scale_factor(),
                        )
                    })
                    .collect();
                // Same minimum as the window builder's min_inner_size above (logical DIPs).
                let safe_bounds =
                    resolve_visible_window_bounds(persisted.bounds, &work_areas, 860, 600);
                win_builder = win_builder
                    .inner_size(safe_bounds.width as f64, safe_bounds.height as f64)
                    .position(safe_bounds.x as f64, safe_bounds.y as f64)
                    .maximized(persisted.is_maximized);
            } else {
                win_builder = win_builder.inner_size(1360.0, 860.0).center();
            }

            // GTK draws the title bar itself on Wayland and reads its buttons from
            // gtk-decoration-layout, whose built-in default is "menu:close". Without a desktop
            // settings daemon that default wins and the window has no minimize/maximize buttons.
            #[cfg(target_os = "linux")]
            if let Some(settings) = gtk::Settings::default() {
                use gtk::prelude::GtkSettingsExt;
                let layout = settings.gtk_decoration_layout().map(|s| s.to_string());
                if !layout.as_deref().is_some_and(|l| l.contains("minimize")) {
                    settings.set_gtk_decoration_layout(Some(":minimize,maximize,close"));
                }
            }
            let window = win_builder.build()?;
            #[cfg(target_os = "linux")]
            install_linux_web_process_recovery(&window, Arc::clone(&state));
            let initial_accelerators = state
                .menu_accelerators
                .read()
                .map(|guard| guard.clone())
                .unwrap_or_default();
            install_app_menu(&app_handle, &initial_accelerators);
            let _ = window.show();
            let _ = window.set_focus();
            eprintln!(
                "[saint-desktop-rust] Main window opened (wsUrl={:?})",
                state.current_ws_url()
            );

            let window_state_path = state.paths.window_state_path.clone();
            let window_for_events = window.clone();
            let state_for_window = Arc::clone(&state);
            let app_for_window = app_handle.clone();
            let last_normal_bounds = Arc::new(std::sync::Mutex::new(
                saved_window.as_ref().map(|w| w.bounds.clone()),
            ));
            let last_normal_for_events = Arc::clone(&last_normal_bounds);
            // A webview window reports OS file drags as webview events, not window events.
            let app_for_drag = app_handle.clone();
            window.on_webview_event(move |event| {
                if let tauri::WebviewEvent::DragDrop(drag) = event {
                    forward_file_drag(&app_for_drag, drag);
                }
            });
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if let Ok(mut guard) = state_for_window.active_context_menu.lock() {
                        if let Some((_, tx)) = guard.take() {
                            let _ = tx.send(None);
                        }
                    }
                    if !state_for_window.quit_allowed.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let request_id = uuid::Uuid::new_v4().to_string();
                        if let Ok(mut guard) = state_for_window.pending_quit_request_id.lock() {
                            *guard = Some(request_id.clone());
                        }
                        if let Ok(mut guard) = state_for_window.awaiting_quit_ready_id.lock() {
                            *guard = Some(request_id.clone());
                        }
                        emit_window_event(
                            window_for_events.as_ref(),
                            "desktop:quit-confirmation-request",
                            &DesktopQuitConfirmationRequest {
                                request_id: request_id.clone(),
                                // The window is open, so the renderer shows its own dialog.
                                presentation: "in-app".to_string(),
                            },
                        );
                        let state_timeout = Arc::clone(&state_for_window);
                        let app_timeout = app_for_window.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                            // Only force-close if the renderer never acknowledged `Ready` within 3s.
                            let still_awaiting_ready = state_timeout
                                .awaiting_quit_ready_id
                                .lock()
                                .ok()
                                .and_then(|g| g.clone())
                                .map(|id| id == request_id)
                                .unwrap_or(false);
                            if still_awaiting_ready {
                                if let Ok(mut guard) = state_timeout.awaiting_quit_ready_id.lock() {
                                    if guard.as_deref() == Some(request_id.as_str()) {
                                        *guard = None;
                                    }
                                }
                                if let Ok(mut guard) = state_timeout.pending_quit_request_id.lock()
                                {
                                    if guard.as_deref() == Some(request_id.as_str()) {
                                        *guard = None;
                                    }
                                }
                                state_timeout.quit_allowed.store(true, Ordering::SeqCst);
                                if let Some(win) = app_timeout.get_webview_window("main") {
                                    let _ = win.close();
                                } else {
                                    app_timeout.exit(0);
                                }
                            }
                        });
                    }
                }
                if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)) {
                    let win_state = DesktopWindowState {
                        is_maximized: window_for_events.is_maximized().unwrap_or(false),
                        is_fullscreen: window_for_events.is_fullscreen().unwrap_or(false),
                    };
                    emit_window_event(window_for_events.as_ref(), "desktop:window-state", &win_state);
                }
                if matches!(
                    event,
                    tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::CloseRequested { .. }
                ) {
                    let is_maximized = window_for_events.is_maximized().unwrap_or(false);
                    let is_minimized = window_for_events.is_minimized().unwrap_or(false);
                    let is_fullscreen = window_for_events.is_fullscreen().unwrap_or(false);
                    if !is_maximized && !is_minimized && !is_fullscreen {
                        if let (Ok(pos), Ok(size)) = (
                            window_for_events.outer_position(),
                            window_for_events.inner_size(),
                        ) {
                            if size.width > 0 && size.height > 0 {
                                let scale = window_for_events.scale_factor().unwrap_or(1.0);
                                if let Ok(mut guard) = last_normal_for_events.lock() {
                                    *guard = Some(physical_to_logical_bounds(
                                        pos.x,
                                        pos.y,
                                        size.width,
                                        size.height,
                                        scale,
                                    ));
                                }
                            }
                        }
                    }
                    if !is_minimized {
                        let bounds_to_save = last_normal_for_events
                            .lock()
                            .ok()
                            .and_then(|g| g.clone());
                        if let Some(bounds) = bounds_to_save {
                            let persisted = PersistedDesktopWindowState {
                                version: 1,
                                bounds,
                                is_maximized,
                            };
                            let _ = write_desktop_window_state(&window_state_path, &persisted);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_pick_folder,
            desktop_save_file,
            desktop_confirm,
            desktop_set_theme,
            desktop_set_window_material,
            desktop_context_menu,
            desktop_clipboard_write_image,
            desktop_clipboard_read_image_png,
            desktop_read_dropped_file,
            desktop_set_menu_shortcuts,
            desktop_quit_confirmation_response,
            desktop_open_external,
            desktop_show_in_folder,
            desktop_window_minimize,
            desktop_window_toggle_maximize,
            desktop_window_close,
            desktop_window_get_state,
            desktop_custom_title_bar_get_state,
            desktop_custom_title_bar_set_preference,
            desktop_custom_title_bar_relaunch,
            desktop_computer_preview_subscribe,
            desktop_computer_preview_unsubscribe,
            desktop_computer_set_cursor_style,
            desktop_audio_level_set_source,
            desktop_audio_level_list_microphones,
            desktop_storage_migration_acknowledge,
            desktop_server_transcribe_voice,
            desktop_update_get_state,
            desktop_update_check,
            desktop_update_download,
            desktop_update_install,
            desktop_notifications_is_supported,
            desktop_notifications_show,
            desktop_appsnap_capture_current_app,
            desktop_appsnap_cancel_capture,
            desktop_appsnap_get_state,
            desktop_appsnap_set_enabled,
            desktop_appsnap_check_shortcut,
            desktop_appsnap_set_shortcut,
            desktop_appsnap_request_permissions,
            desktop_appsnap_start_permission_setup,
            desktop_appsnap_list_pending_captures,
            desktop_appsnap_acknowledge_capture,
            desktop_appsnap_list_windows,
            desktop_appsnap_capture_window,
            desktop_appsnap_open_permission_settings,
            desktop_appsnap_restart_app,
            desktop_appsnap_show_permission_guide,
            desktop_appsnap_hide_permission_guide,
            desktop_remote_ssh_get_state,
            desktop_remote_ssh_connect,
            desktop_remote_ssh_reconnect,
            desktop_remote_ssh_disconnect,
            desktop_remote_ssh_stop_server,
            desktop_remote_ssh_forget,
            desktop_remote_ssh_test_host,
            desktop_remote_ssh_update_host,
            desktop_remote_ssh_ws_url,
            desktop_remote_ssh_forward_port,
            desktop_remote_ssh_download_files,
            desktop_lan_relay_get_state,
            desktop_lan_relay_set_enabled,
            desktop_lan_relay_rotate_pairing_token,
            desktop_lan_relay_revoke_session,
            desktop_lan_relay_revoke_all_sessions,
            desktop_browser_open,
            desktop_browser_close,
            desktop_browser_hide,
            desktop_browser_get_state,
            desktop_browser_set_bounds,
            desktop_browser_attach_webview,
            desktop_browser_detach_webview,
            desktop_browser_request_copy_link,
            desktop_browser_copy_screenshot_to_clipboard,
            desktop_browser_capture_screenshot,
            desktop_browser_capture_preview,
            desktop_browser_navigate,
            desktop_browser_reload,
            desktop_browser_go_back,
            desktop_browser_go_forward,
            desktop_browser_new_tab,
            desktop_browser_close_tab,
            desktop_browser_select_tab,
            desktop_browser_open_devtools,
            desktop_browser_annotations_start,
            desktop_browser_annotations_cancel,
            desktop_browser_annotations_sync_markers,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Saint Rust desktop shell");

    let exit_teardown_ran = AtomicBool::new(false);
    app.run(move |app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) && !exit_teardown_ran.swap(true, Ordering::SeqCst)
        {
            for window in app_handle.webview_windows().values() {
                let _ = window.hide();
            }
            cleanup_all_managed_resources(&state_for_exit);
            tauri::async_runtime::block_on(state_for_exit.backend.stop_and_wait());
        }
    });
}

#[cfg(test)]
mod clipboard_tests {
    use super::{
        linux_atom_names_have_any_image, linux_clipboard_preferred_image_mime,
        wayland_clipboard_mime_list_has_any_image, GtkClipboardImageOutcome,
    };

    #[test]
    fn wayland_mime_list_skips_text_and_uri_links() {
        let link_mimes = "text/plain;charset=utf-8\ntext/uri-list\ntext/html\nUTF8_STRING\n";
        assert!(!wayland_clipboard_mime_list_has_any_image(link_mimes));
        assert_eq!(linux_clipboard_preferred_image_mime(link_mimes), None);
    }

    #[test]
    fn wayland_mime_list_detects_png_and_other_images() {
        let png_mimes = "image/jpeg\nimage/png\ntext/html\n";
        assert!(wayland_clipboard_mime_list_has_any_image(png_mimes));
        assert_eq!(
            linux_clipboard_preferred_image_mime(png_mimes).as_deref(),
            Some("image/png")
        );

        let jpeg_mimes = "IMAGE/JPEG\n";
        assert!(wayland_clipboard_mime_list_has_any_image(jpeg_mimes));
        assert_eq!(
            linux_clipboard_preferred_image_mime(jpeg_mimes).as_deref(),
            Some("IMAGE/JPEG")
        );
    }

    #[test]
    fn gtk_target_atoms_distinguish_links_from_images() {
        let github_link_targets = [
            "TIMESTAMP",
            "TARGETS",
            "UTF8_STRING",
            "text/plain;charset=utf-8",
            "text/html",
            "text/uri-list",
        ];
        assert!(!linux_atom_names_have_any_image(github_link_targets));

        let image_targets = ["TARGETS", "text/html", "image/png"];
        assert!(linux_atom_names_have_any_image(image_targets));
        assert_ne!(
            GtkClipboardImageOutcome::NoImage,
            GtkClipboardImageOutcome::UnavailableOrTimedOut
        );
    }
}

#[cfg(test)]
mod linux_webkit_stability_tests {
    use super::{
        resolve_linux_webkit_a11y_bus_address, resolve_linux_webkit_dmabuf_renderer_env,
        WebProcessRecoveryLimiter, WebProcessTerminationKind,
        LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS, LINUX_DISABLED_WEBKIT_DMABUF_RENDERER,
        WEB_PROCESS_RECOVERY_MAX_ATTEMPTS, WEB_PROCESS_RECOVERY_WINDOW,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn linux_webkit_a11y_guard_disables_by_default_and_respects_overrides() {
        assert_eq!(
            resolve_linux_webkit_a11y_bus_address(None, None),
            Some(LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS)
        );
        assert_eq!(
            resolve_linux_webkit_a11y_bus_address(Some("   "), None),
            Some(LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS)
        );
        assert_eq!(
            resolve_linux_webkit_a11y_bus_address(
                Some("unix:path=/run/user/1000/at-spi/bus_0"),
                None
            ),
            None
        );
        assert_eq!(resolve_linux_webkit_a11y_bus_address(None, Some("1")), None);
        assert_eq!(resolve_linux_webkit_a11y_bus_address(None, Some("true")), None);
        assert_eq!(resolve_linux_webkit_a11y_bus_address(None, Some("YES")), None);
        assert_eq!(
            resolve_linux_webkit_a11y_bus_address(None, Some("0")),
            Some(LINUX_DISABLED_WEBKIT_A11Y_BUS_ADDRESS)
        );
    }

    #[test]
    fn linux_webkit_dmabuf_guard_disables_by_default_and_respects_overrides() {
        assert_eq!(
            resolve_linux_webkit_dmabuf_renderer_env(None, None),
            Some(LINUX_DISABLED_WEBKIT_DMABUF_RENDERER)
        );
        assert_eq!(
            resolve_linux_webkit_dmabuf_renderer_env(Some("  "), None),
            Some(LINUX_DISABLED_WEBKIT_DMABUF_RENDERER)
        );
        assert_eq!(resolve_linux_webkit_dmabuf_renderer_env(Some("0"), None), None);
        assert_eq!(resolve_linux_webkit_dmabuf_renderer_env(Some("1"), None), None);
        assert_eq!(resolve_linux_webkit_dmabuf_renderer_env(None, Some("1")), None);
        assert_eq!(resolve_linux_webkit_dmabuf_renderer_env(None, Some("true")), None);
        assert_eq!(resolve_linux_webkit_dmabuf_renderer_env(None, Some("YES")), None);
        assert_eq!(
            resolve_linux_webkit_dmabuf_renderer_env(None, Some("0")),
            Some(LINUX_DISABLED_WEBKIT_DMABUF_RENDERER)
        );
    }

    #[test]
    fn web_process_recovery_limiter_bounds_retries_and_skips_api_termination() {
        let mut limiter = WebProcessRecoveryLimiter::default();
        let t0 = Instant::now();

        assert_eq!(
            limiter.try_record_recovery(t0, WebProcessTerminationKind::TerminatedByApi),
            None
        );
        assert_eq!(
            limiter.try_record_recovery(t0, WebProcessTerminationKind::Unknown(99)),
            None
        );

        for attempt in 1..=WEB_PROCESS_RECOVERY_MAX_ATTEMPTS {
            assert_eq!(
                limiter.try_record_recovery(
                    t0 + Duration::from_secs(attempt as u64),
                    WebProcessTerminationKind::Crashed,
                ),
                Some(attempt)
            );
        }

        // Next crash within the same window must trip the circuit-breaker.
        assert_eq!(
            limiter.try_record_recovery(
                t0 + Duration::from_secs(10),
                WebProcessTerminationKind::ExceededMemoryLimit,
            ),
            None
        );

        // Once the window expires, recovery is permitted again.
        assert_eq!(
            limiter.try_record_recovery(
                t0 + WEB_PROCESS_RECOVERY_WINDOW + Duration::from_secs(5),
                WebProcessTerminationKind::Crashed,
            ),
            Some(1)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn extracts_gvalue_enum_codes_for_webkit_termination_reason() {
        use gtk::glib::ToValue;

        let crashed = gtk::Orientation::Horizontal.to_value();
        let exceeded = gtk::Orientation::Vertical.to_value();
        assert_eq!(super::extract_gvalue_enum_code(&crashed), Some(0));
        assert_eq!(super::extract_gvalue_enum_code(&exceeded), Some(1));
        assert_eq!(
            WebProcessTerminationKind::from_webkit_enum_value(
                super::extract_gvalue_enum_code(&crashed).unwrap()
            ),
            WebProcessTerminationKind::Crashed
        );
    }
}
