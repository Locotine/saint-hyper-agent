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
use std::sync::atomic::{AtomicBool, Ordering};
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
    read_custom_title_bar_preference, read_desktop_window_state, read_saint_storage_snapshot,
    resolve_desktop_custom_title_bar_state, resolve_reported_menu_accelerators,
    resolve_visible_window_bounds, resolve_window_translucency, supports_custom_title_bar,
    write_custom_title_bar_preference, write_desktop_window_state, AgentCursorStylePreference,
    ContextMenuPosition, DesktopContextMenuItem, DesktopCustomTitleBarState, DesktopMenuShortcuts,
    DesktopQuitConfirmationRequest, DesktopQuitConfirmationResponse, DesktopWindowBounds,
    DesktopWindowMaterial, DesktopWindowState, PersistedDesktopWindowState,
    ResolvedContextMenuNode,
};

fn cleanup_all_managed_resources(state: &DesktopSharedState) {
    state.backend.begin_shutdown();
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
    // `on_menu_event` either during or immediately after returning.
    match tokio::time::timeout(std::time::Duration::from_millis(200), rx).await {
        Ok(Ok(selected)) => Ok(selected),
        _ => {
            if let Ok(mut guard) = state.active_context_menu.lock() {
                if guard.as_ref().map(|(id, _)| id == &request_id).unwrap_or(false) {
                    guard.take();
                }
            }
            Ok(None)
        }
    }
}

// WebKitGTK hands the page no files for a pasted screenshot, so the composer asks for the
// clipboard image here when a paste carries neither files nor text.
#[tauri::command]
fn desktop_clipboard_read_image_png(app: tauri::AppHandle) -> Option<String> {
    use base64::Engine as _;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let encode = |png: Vec<u8>| {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    };
    // GNOME Wayland has no data-control protocol, so arboard cannot read the clipboard
    // there; wl-paste can.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        if let Ok(out) = std::process::Command::new("wl-paste")
            .args(["--no-newline", "--type", "image/png"])
            .output()
        {
            if out.status.success() && out.stdout.starts_with(b"\x89PNG") {
                return Some(encode(out.stdout));
            }
        }
    }
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
}

#[tauri::command]
fn desktop_clipboard_write_image(app: tauri::AppHandle, data_url: String) -> bool {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let Some(png_bytes) = decode_clipboard_png_data_url(&data_url) else {
        return false;
    };
    let Ok(image) = tauri::image::Image::from_bytes(&png_bytes) else {
        return false;
    };
    app.clipboard().write_image(&image).is_ok()
}

#[tauri::command]
fn desktop_set_menu_shortcuts(
    state: State<'_, Arc<DesktopSharedState>>,
    shortcuts: DesktopMenuShortcuts,
) {
    let resolved = resolve_reported_menu_accelerators(&shortcuts, std::env::consts::OS);
    if let Ok(mut guard) = state.menu_accelerators.write() {
        *guard = resolved;
    }
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

const OFFICE_WIDGET_LABEL: &str = "office-widget";
const OFFICE_WIDGET_WIDTH: f64 = 360.0;
const OFFICE_WIDGET_HEIGHT: f64 = 240.0;
const OFFICE_WIDGET_MARGIN: f64 = 16.0;

/// Opens the floating office in the top-right corner, or closes it when it is open.
/// Async so window creation does not run on (and deadlock) the main thread on Windows.
#[tauri::command]
async fn desktop_office_widget_toggle(
    app: tauri::AppHandle,
    state: State<'_, Arc<DesktopSharedState>>,
) -> Result<bool, String> {
    if let Some(widget) = app.get_webview_window(OFFICE_WIDGET_LABEL) {
        widget.close().map_err(|e| e.to_string())?;
        return Ok(false);
    }
    // The widget loads the same bundle; the hash route picks the office-only view.
    let init_script = format!(
        "{}\nif (!window.location.hash.startsWith('#/office-widget')) window.location.hash = '#/office-widget';",
        build_initialization_script(&state)
    );
    let mut builder = WebviewWindowBuilder::new(
        &app,
        OFFICE_WIDGET_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(format!("{APP_DISPLAY_NAME} Office"))
    .inner_size(OFFICE_WIDGET_WIDTH, OFFICE_WIDGET_HEIGHT)
    .min_inner_size(240.0, 160.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .initialization_script(&init_script);
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        builder = builder.position(
            origin.x + size.width - OFFICE_WIDGET_WIDTH - OFFICE_WIDGET_MARGIN,
            origin.y + OFFICE_WIDGET_MARGIN,
        );
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
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
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
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
    Ok(run_update_check(&app, state.inner()).await)
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

    let next_state = match updater.check().await {
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
        Err(err) => state.updater.mark_error("check", err.to_string()),
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

    match updater.check().await {
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
            let download_res = update
                .download(
                    move |chunk_len, total_len| {
                        transferred += chunk_len as u64;
                        if let Some(total) = total_len.filter(|t| *t > 0) {
                            let pct = (transferred as f64 / total as f64) * 100.0;
                            let next = state_progress.updater.update_download_progress(pct);
                            emit_app_event(&app_progress, "desktop:update-state", &next);
                        }
                    },
                    || {},
                )
                .await;

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
        if let Ok(Some(update)) = updater.check().await {
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
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<DesktopRemoteSshHostState, String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    let (host_state, full_state) = tokio::task::spawn_blocking(move || {
        let hs = remote_ssh.connect(host)?;
        let fs = remote_ssh.get_state();
        Ok::<_, String>((hs, fs))
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_window_event(&webview, "desktop:remote-ssh-state", &full_state);
    Ok(host_state)
}

#[tauri::command]
async fn desktop_remote_ssh_disconnect(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
) -> Result<(), String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    let full_state = tokio::task::spawn_blocking(move || {
        remote_ssh.disconnect(&host)?;
        Ok::<_, String>(remote_ssh.get_state())
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_window_event(&webview, "desktop:remote-ssh-state", &full_state);
    Ok(())
}

#[tauri::command]
async fn desktop_remote_ssh_stop_server(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    host: DesktopRemoteSshSavedHost,
) -> Result<(), String> {
    let remote_ssh = Arc::clone(&state.remote_ssh);
    let full_state = tokio::task::spawn_blocking(move || {
        remote_ssh.stop_server(host)?;
        Ok::<_, String>(remote_ssh.get_state())
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_window_event(&webview, "desktop:remote-ssh-state", &full_state);
    Ok(())
}

#[tauri::command]
fn desktop_remote_ssh_forget(
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
) {
    state.remote_ssh.forget_host(&host);
    let full_state = state.remote_ssh.get_state();
    emit_window_event(&webview, "desktop:remote-ssh-state", &full_state);
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
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: DesktopRemoteSshUpdateHostInput,
) -> Result<DesktopRemoteSshState, String> {
    let full_state = state.remote_ssh.update_host(input)?;
    emit_window_event(&webview, "desktop:remote-ssh-state", &full_state);
    Ok(full_state)
}

#[tauri::command]
fn desktop_remote_ssh_ws_url(
    state: State<'_, Arc<DesktopSharedState>>,
    host: String,
) -> Option<String> {
    state.remote_ssh.ws_url_for_host(&host)
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
fn desktop_browser_request_copy_link(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: State<'_, Arc<DesktopSharedState>>,
    input: BrowserTabInput,
) {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    if let Some(url) = state.browser.tab_url(&input.thread_id, &input.tab_id) {
        if url != "about:blank" && !url.is_empty() {
            let _ = app.clipboard().write_text(&url);
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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

            // Start the local RPC pipe server (`SAINT_BROWSER_HOST_PIPE_PATH`) so `apps/server`
            // can invoke `browser_*` tools against the desktop browser manager.
            state.browser.start_rpc_pipe_server(app_handle.clone());

            // Start the Computer-Use host socket (`SAINT_CUA_HOST_SOCKET`) sharing the
            // per-session capability token with `apps/server`.
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
                    .initialization_script(&init_script);

            if let Some(ref persisted) = saved_window {
                let work_areas: Vec<DesktopWindowBounds> = app
                    .available_monitors()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| {
                        let pos = m.position();
                        let size = m.size();
                        DesktopWindowBounds {
                            x: pos.x,
                            y: pos.y,
                            width: size.width as i32,
                            height: size.height as i32,
                        }
                    })
                    .collect();
                // Same minimum as the window builder's min_inner_size above.
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
            window.on_window_event(move |event| {
                // The floating office never outlives the app window it mirrors.
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    if let Some(widget) = app_for_window.get_webview_window(OFFICE_WIDGET_LABEL) {
                        let _ = widget.close();
                    }
                }
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !state_for_window.quit_allowed.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let request_id = uuid::Uuid::new_v4().to_string();
                        if let Ok(mut guard) = state_for_window.pending_quit_request_id.lock() {
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
                            let still_pending = state_timeout
                                .pending_quit_request_id
                                .lock()
                                .ok()
                                .and_then(|g| g.clone())
                                .map(|id| id == request_id)
                                .unwrap_or(false);
                            if still_pending {
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
                                if let Ok(mut guard) = last_normal_for_events.lock() {
                                    *guard = Some(DesktopWindowBounds {
                                        x: pos.x,
                                        y: pos.y,
                                        width: size.width as i32,
                                        height: size.height as i32,
                                    });
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
            desktop_set_menu_shortcuts,
            desktop_quit_confirmation_response,
            desktop_open_external,
            desktop_office_widget_toggle,
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
            desktop_remote_ssh_disconnect,
            desktop_remote_ssh_stop_server,
            desktop_remote_ssh_forget,
            desktop_remote_ssh_test_host,
            desktop_remote_ssh_update_host,
            desktop_remote_ssh_ws_url,
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
