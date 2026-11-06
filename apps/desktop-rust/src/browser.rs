// FILE: browser.rs
// Purpose: Hybrid In-app Browser manager & local RPC pipe server (`SAINT_BROWSER_HOST_PIPE_PATH`).
//          Implements Option 2.1 (Win/Mac/Linux), 2.2 (Hybrid Tauri Multi-Webview + DOM/CDP),
//          and 2.3 (No Cookie Import, No Password Vault, No `betterwright` dependency).
// Layer: Desktop Browser runtime & Agent automation host.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(not(test))]
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use uuid::Uuid;

pub const MAX_BROWSER_PIPE_FRAME_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_TAB_HISTORY_ENTRIES: usize = 100;
pub const MAX_CLOSED_BROWSER_THREAD_SESSIONS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opener_tab_id: Option<String>,
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_surface: Option<String>,
    pub status: String,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub favicon_url: Option<String>,
    pub last_committed_url: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadBrowserState {
    pub thread_id: String,
    pub version: u64,
    pub open: bool,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<BrowserTabState>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BrowserPanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenInput {
    pub thread_id: String,
    #[serde(default)]
    pub initial_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserThreadInput {
    pub thread_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInput {
    pub thread_id: String,
    pub tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateInput {
    pub thread_id: String,
    #[serde(default)]
    pub tab_id: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNewTabInput {
    pub thread_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub activate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSetPanelBoundsInput {
    pub thread_id: String,
    pub bounds: Option<BrowserPanelBounds>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub occluded: Option<bool>,
    #[serde(default)]
    pub preview: Option<bool>,
    #[serde(default)]
    pub page_zoom_factor: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAttachWebviewInput {
    pub thread_id: String,
    pub tab_id: String,
    pub web_contents_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureScreenshotResult {
    pub name: String,
    pub mime_type: String,
    pub size_bytes: usize,
    pub bytes: Vec<u8>,
}

struct ThreadSession {
    state: ThreadBrowserState,
    bounds: Option<BrowserPanelBounds>,
    occluded: bool,
    page_zoom_factor: Option<f64>,
    history: HashMap<String, (Vec<String>, usize)>,
}

pub struct BrowserManager {
    threads: Mutex<HashMap<String, ThreadSession>>,
    visible_thread_id: Mutex<Option<String>>,
    pipe_path: String,
    capability: String,
}

impl BrowserManager {
    pub fn new() -> Self {
        let pipe_path = Self::default_pipe_path();
        let capability = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        Self {
            threads: Mutex::new(HashMap::new()),
            visible_thread_id: Mutex::new(None),
            pipe_path,
            capability,
        }
    }

    pub fn pipe_path(&self) -> &str {
        &self.pipe_path
    }

    pub fn capability(&self) -> &str {
        &self.capability
    }

    fn default_pipe_path() -> String {
        let suffix = format!("{}-{}", std::process::id(), Uuid::new_v4());
        #[cfg(target_os = "windows")]
        {
            format!(r"\\.\pipe\saint-browser-host-{suffix}")
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("/tmp/saint-browser-host/{suffix}.sock")
        }
    }

    fn normalize_url(raw: Option<&str>) -> String {
        let Some(candidate) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
            return "about:blank".to_string();
        };
        if candidate == "about:blank" {
            return candidate.to_string();
        }
        if candidate.starts_with("http://") || candidate.starts_with("https://") {
            return candidate.to_string();
        }
        if candidate.starts_with("localhost:") || candidate.starts_with("127.0.0.1:") {
            return format!("http://{candidate}");
        }
        format!("https://{candidate}")
    }

    fn default_title_for_url(url: &str) -> String {
        if url == "about:blank" {
            return "New Tab".to_string();
        }
        url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_else(|| url.to_string())
    }

    fn create_tab(url: String) -> BrowserTabState {
        let title = Self::default_title_for_url(&url);
        let committed = if url == "about:blank" {
            None
        } else {
            Some(url.clone())
        };
        BrowserTabState {
            opener_tab_id: None,
            id: Uuid::new_v4().to_string(),
            url,
            title,
            runtime_surface: Some("native".to_string()),
            status: "live".to_string(),
            is_loading: false,
            can_go_back: false,
            can_go_forward: false,
            favicon_url: None,
            last_committed_url: committed,
            last_error: None,
        }
    }

    fn empty_state(thread_id: &str) -> ThreadBrowserState {
        ThreadBrowserState {
            thread_id: thread_id.to_string(),
            version: 1,
            open: false,
            active_tab_id: None,
            tabs: Vec::new(),
            last_error: None,
        }
    }

    pub fn get_state(&self, thread_id: &str) -> ThreadBrowserState {
        let guard = self.threads.lock().expect("browser mutex poisoned");
        guard
            .get(thread_id)
            .map(|s| s.state.clone())
            .unwrap_or_else(|| Self::empty_state(thread_id))
    }

    pub fn open(&self, input: BrowserOpenInput) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let entry = guard
            .entry(input.thread_id.clone())
            .or_insert_with(|| ThreadSession {
                state: Self::empty_state(&input.thread_id),
                bounds: None,
                occluded: false,
                page_zoom_factor: None,
                history: HashMap::new(),
            });

        entry.state.open = true;
        entry.state.version += 1;

        if entry.state.tabs.is_empty() {
            let url = Self::normalize_url(input.initial_url.as_deref());
            let tab = Self::create_tab(url.clone());
            let tab_id = tab.id.clone();
            entry.history.insert(tab_id.clone(), (vec![url], 0));
            entry.state.active_tab_id = Some(tab_id);
            entry.state.tabs.push(tab);
        } else if let Some(raw_url) = input.initial_url.as_deref() {
            let url = Self::normalize_url(Some(raw_url));
            if let Some(active_id) = entry.state.active_tab_id.clone() {
                if let Some(tab) = entry.state.tabs.iter_mut().find(|t| t.id == active_id) {
                    tab.url = url.clone();
                    tab.title = Self::default_title_for_url(&url);
                    tab.last_committed_url = Some(url.clone());
                }
            }
        }

        if let Ok(mut vis) = self.visible_thread_id.lock() {
            *vis = Some(input.thread_id);
        }

        entry.state.clone()
    }

    pub fn close(&self, thread_id: &str) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let Some(entry) = guard.get_mut(thread_id) else {
            return Self::empty_state(thread_id);
        };
        entry.state.open = false;
        entry.state.version += 1;
        entry.bounds = None;
        let result = entry.state.clone();

        let closed_count = guard.values().filter(|s| !s.state.open).count();
        if closed_count > MAX_CLOSED_BROWSER_THREAD_SESSIONS {
            let target_tid = thread_id.to_string();
            guard.retain(|tid, s| s.state.open || tid == &target_tid);
        }

        result
    }

    pub fn tab_ids_for_thread(&self, thread_id: &str) -> Vec<String> {
        let Ok(guard) = self.threads.lock() else {
            return Vec::new();
        };
        guard
            .get(thread_id)
            .map(|s| s.state.tabs.iter().map(|t| t.id.clone()).collect())
            .unwrap_or_default()
    }

    pub fn hide(&self, thread_id: &str) {
        if let Ok(mut guard) = self.threads.lock() {
            if let Some(entry) = guard.get_mut(thread_id) {
                entry.bounds = None;
            }
        }
    }

    pub fn set_panel_bounds(&self, input: BrowserSetPanelBoundsInput) {
        if let Ok(mut guard) = self.threads.lock() {
            let entry = guard
                .entry(input.thread_id.clone())
                .or_insert_with(|| ThreadSession {
                    state: Self::empty_state(&input.thread_id),
                    bounds: None,
                    occluded: false,
                    page_zoom_factor: None,
                    history: HashMap::new(),
                });
            entry.bounds = input.bounds;
            entry.occluded = input.occluded.unwrap_or(false);
            entry.page_zoom_factor = input.page_zoom_factor;
        }
        if input.bounds.is_some() {
            if let Ok(mut vis) = self.visible_thread_id.lock() {
                *vis = Some(input.thread_id);
            }
        }
    }

    pub fn navigate(&self, input: BrowserNavigateInput) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let entry = guard
            .entry(input.thread_id.clone())
            .or_insert_with(|| ThreadSession {
                state: Self::empty_state(&input.thread_id),
                bounds: None,
                occluded: false,
                page_zoom_factor: None,
                history: HashMap::new(),
            });

        let url = Self::normalize_url(Some(&input.url));
        let target_id = input
            .tab_id
            .or_else(|| entry.state.active_tab_id.clone());

        if let Some(tab_id) = target_id {
            if let Some(tab) = entry.state.tabs.iter_mut().find(|t| t.id == tab_id) {
                tab.url = url.clone();
                tab.title = Self::default_title_for_url(&url);
                tab.last_committed_url = Some(url.clone());
                let hist = entry
                    .history
                    .entry(tab_id)
                    .or_insert_with(|| (Vec::new(), 0));
                let next_idx = hist.1 + 1;
                hist.0.truncate(next_idx);
                hist.0.push(url);
                if hist.0.len() > MAX_TAB_HISTORY_ENTRIES {
                    let overflow = hist.0.len() - MAX_TAB_HISTORY_ENTRIES;
                    hist.0.drain(0..overflow);
                }
                hist.1 = hist.0.len().saturating_sub(1);
                tab.can_go_back = hist.1 > 0;
                tab.can_go_forward = false;
            }
        } else {
            let tab = Self::create_tab(url.clone());
            let tab_id = tab.id.clone();
            entry.history.insert(tab_id.clone(), (vec![url], 0));
            entry.state.active_tab_id = Some(tab_id);
            entry.state.tabs.push(tab);
        }

        entry.state.open = true;
        entry.state.version += 1;
        entry.state.clone()
    }

    pub fn new_tab(&self, input: BrowserNewTabInput) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let entry = guard
            .entry(input.thread_id.clone())
            .or_insert_with(|| ThreadSession {
                state: Self::empty_state(&input.thread_id),
                bounds: None,
                occluded: false,
                page_zoom_factor: None,
                history: HashMap::new(),
            });

        let url = Self::normalize_url(input.url.as_deref());
        let tab = Self::create_tab(url.clone());
        let tab_id = tab.id.clone();
        entry.history.insert(tab_id.clone(), (vec![url], 0));
        if input.activate.unwrap_or(true) || entry.state.active_tab_id.is_none() {
            entry.state.active_tab_id = Some(tab_id);
        }
        entry.state.tabs.push(tab);
        entry.state.open = true;
        entry.state.version += 1;
        entry.state.clone()
    }

    pub fn close_tab(&self, input: BrowserTabInput) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let Some(entry) = guard.get_mut(&input.thread_id) else {
            return Self::empty_state(&input.thread_id);
        };
        entry.state.tabs.retain(|t| t.id != input.tab_id);
        entry.history.remove(&input.tab_id);
        if entry.state.active_tab_id.as_deref() == Some(&input.tab_id) {
            entry.state.active_tab_id = entry.state.tabs.last().map(|t| t.id.clone());
        }
        if entry.state.tabs.is_empty() {
            entry.state.open = false;
        }
        entry.state.version += 1;
        entry.state.clone()
    }

    pub fn select_tab(&self, input: BrowserTabInput) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let Some(entry) = guard.get_mut(&input.thread_id) else {
            return Self::empty_state(&input.thread_id);
        };
        if entry.state.tabs.iter().any(|t| t.id == input.tab_id) {
            entry.state.active_tab_id = Some(input.tab_id);
            entry.state.version += 1;
        }
        entry.state.clone()
    }

    pub fn go_back(&self, input: BrowserTabInput) -> ThreadBrowserState {
        self.step_history(input, -1)
    }

    pub fn go_forward(&self, input: BrowserTabInput) -> ThreadBrowserState {
        self.step_history(input, 1)
    }

    fn step_history(&self, input: BrowserTabInput, delta: isize) -> ThreadBrowserState {
        let mut guard = self.threads.lock().expect("browser mutex poisoned");
        let Some(entry) = guard.get_mut(&input.thread_id) else {
            return Self::empty_state(&input.thread_id);
        };
        if let Some((urls, index)) = entry.history.get_mut(&input.tab_id) {
            let next_index = (*index as isize) + delta;
            if next_index >= 0 && (next_index as usize) < urls.len() {
                *index = next_index as usize;
                let url = urls[*index].clone();
                if let Some(tab) = entry.state.tabs.iter_mut().find(|t| t.id == input.tab_id) {
                    tab.url = url.clone();
                    tab.title = Self::default_title_for_url(&url);
                    tab.last_committed_url = Some(url);
                    tab.can_go_back = *index > 0;
                    tab.can_go_forward = *index + 1 < urls.len();
                }
                entry.state.version += 1;
            }
        }
        entry.state.clone()
    }

    pub fn tab_url(&self, thread_id: &str, tab_id: &str) -> Option<String> {
        let guard = self.threads.lock().ok()?;
        let session = guard.get(thread_id)?;
        session
            .state
            .tabs
            .iter()
            .find(|t| t.id == tab_id)
            .map(|t| t.url.clone())
    }

    pub fn webview_label_for_tab(tab_id: &str) -> String {
        format!("browser-tab-{tab_id}")
    }

    #[cfg(test)]
    pub fn sync_native_webviews(&self, _app: &tauri::AppHandle) {}

    #[cfg(not(test))]
    pub fn sync_native_webviews(&self, app: &tauri::AppHandle) {
        let visible_thread = self.visible_thread_id.lock().ok().and_then(|g| g.clone());
        let active_target = {
            let Ok(guard) = self.threads.lock() else {
                return;
            };
            visible_thread.and_then(|tid| {
                let session = guard.get(&tid)?;
                if !session.state.open || session.occluded {
                    return None;
                }
                let bounds = session.bounds?;
                if bounds.width <= 1.0 || bounds.height <= 1.0 {
                    return None;
                }
                let active_id = session.state.active_tab_id.as_ref()?;
                let tab = session.state.tabs.iter().find(|t| &t.id == active_id)?;
                if tab.url.is_empty() || tab.url == "about:blank" {
                    return None;
                }
                Some((
                    tab.id.clone(),
                    tab.url.clone(),
                    bounds,
                    session.page_zoom_factor,
                ))
            })
        };

        let active_label = active_target
            .as_ref()
            .map(|(tab_id, _, _, _)| Self::webview_label_for_tab(tab_id));

        for (label, webview) in app.webviews() {
            if label.starts_with("browser-tab-") && Some(&label) != active_label.as_ref() {
                let _ = webview.hide();
            }
        }

        let Some((tab_id, url, bounds, zoom_factor)) = active_target else {
            return;
        };
        let label = Self::webview_label_for_tab(&tab_id);
        let pos = tauri::LogicalPosition::new(bounds.x, bounds.y);
        let size = tauri::LogicalSize::new(bounds.width, bounds.height);

        if let Some(existing) = app.get_webview(&label) {
            let _ = existing.set_position(pos);
            let _ = existing.set_size(size);
            if let Some(zoom) = zoom_factor.filter(|z| z.is_finite() && *z > 0.1) {
                let _ = existing.set_zoom(zoom);
            }
            let _ = existing.show();
            return;
        }

        let Ok(parsed_url) = url::Url::parse(&url) else {
            return;
        };
        let Some(main_window) = app.get_window("main") else {
            return;
        };
        let builder =
            tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url));
        if let Ok(created) = main_window.add_child(builder, pos, size) {
            if let Some(zoom) = zoom_factor.filter(|z| z.is_finite() && *z > 0.1) {
                let _ = created.set_zoom(zoom);
            }
            let _ = created.show();
        }
    }

    #[cfg(test)]
    pub fn navigate_native_webview(&self, _app: &tauri::AppHandle, _tab_id: &str, _url: &str) {}

    #[cfg(not(test))]
    pub fn navigate_native_webview(&self, app: &tauri::AppHandle, tab_id: &str, url: &str) {
        let label = Self::webview_label_for_tab(tab_id);
        if let Some(webview) = app.get_webview(&label) {
            if url == "about:blank" {
                let _ = webview.hide();
            } else if let Ok(parsed) = url::Url::parse(url) {
                let _ = webview.navigate(parsed);
            }
        }
        self.sync_native_webviews(app);
    }

    #[cfg(test)]
    pub fn reload_native_webview(&self, _app: &tauri::AppHandle, _tab_id: &str) {}

    #[cfg(not(test))]
    pub fn reload_native_webview(&self, app: &tauri::AppHandle, tab_id: &str) {
        let label = Self::webview_label_for_tab(tab_id);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.eval("window.location.reload();");
        }
    }

    #[cfg(test)]
    pub fn open_devtools_native_webview(&self, _app: &tauri::AppHandle, _tab_id: &str) {}

    #[cfg(not(test))]
    pub fn open_devtools_native_webview(&self, app: &tauri::AppHandle, tab_id: &str) {
        let label = Self::webview_label_for_tab(tab_id);
        if let Some(webview) = app.get_webview(&label) {
            webview.open_devtools();
        }
    }

    #[cfg(test)]
    pub fn close_native_webview(&self, _app: &tauri::AppHandle, _tab_id: &str) {}

    #[cfg(not(test))]
    pub fn close_native_webview(&self, app: &tauri::AppHandle, tab_id: &str) {
        let label = Self::webview_label_for_tab(tab_id);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.hide();
            let _ = webview.close();
        }
    }

    pub fn execute_rpc_tool(
        &self,
        app_handle: Option<&tauri::AppHandle>,
        thread_id: &str,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let str_arg = |key: &str| {
            args.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        };

        let next_state = match tool_name {
            "browser_open" => {
                let initial_url = str_arg("url").or_else(|| str_arg("initialUrl"));
                Some(self.open(BrowserOpenInput {
                    thread_id: thread_id.to_string(),
                    initial_url,
                }))
            }
            "browser_navigate" => {
                let url = str_arg("url").unwrap_or_else(|| "about:blank".to_string());
                let tab_id = str_arg("tabId").or_else(|| str_arg("tab_id"));
                let state = self.navigate(BrowserNavigateInput {
                    thread_id: thread_id.to_string(),
                    tab_id: tab_id.clone(),
                    url: url.clone(),
                });
                if let (Some(app), Some(active_id)) = (app_handle, state.active_tab_id.as_deref()) {
                    let target = tab_id.as_deref().unwrap_or(active_id);
                    let normalized = Self::normalize_url(Some(&url));
                    self.navigate_native_webview(app, target, &normalized);
                }
                Some(state)
            }
            "browser_back" | "browser_go_back" => {
                let current = self.get_state(thread_id);
                let tab_id = str_arg("tabId")
                    .or(current.active_tab_id)
                    .unwrap_or_default();
                let state = self.go_back(BrowserTabInput {
                    thread_id: thread_id.to_string(),
                    tab_id: tab_id.clone(),
                });
                if let (Some(app), Some(url)) = (app_handle, self.tab_url(thread_id, &tab_id)) {
                    self.navigate_native_webview(app, &tab_id, &url);
                }
                Some(state)
            }
            "browser_forward" | "browser_go_forward" => {
                let current = self.get_state(thread_id);
                let tab_id = str_arg("tabId")
                    .or(current.active_tab_id)
                    .unwrap_or_default();
                let state = self.go_forward(BrowserTabInput {
                    thread_id: thread_id.to_string(),
                    tab_id: tab_id.clone(),
                });
                if let (Some(app), Some(url)) = (app_handle, self.tab_url(thread_id, &tab_id)) {
                    self.navigate_native_webview(app, &tab_id, &url);
                }
                Some(state)
            }
            "browser_reload" => {
                let current = self.get_state(thread_id);
                if let (Some(app), Some(tab_id)) = (app_handle, current.active_tab_id.as_deref()) {
                    self.reload_native_webview(app, tab_id);
                }
                Some(current)
            }
            "browser_new_tab" => {
                let url = str_arg("url");
                let activate = args.get("activate").and_then(|v| v.as_bool());
                Some(self.new_tab(BrowserNewTabInput {
                    thread_id: thread_id.to_string(),
                    url,
                    activate,
                }))
            }
            "browser_select_tab" => {
                let tab_id = str_arg("tabId").unwrap_or_default();
                Some(self.select_tab(BrowserTabInput {
                    thread_id: thread_id.to_string(),
                    tab_id,
                }))
            }
            "browser_close_tab" => {
                let tab_id = str_arg("tabId").unwrap_or_default();
                if let Some(app) = app_handle {
                    self.close_native_webview(app, &tab_id);
                }
                Some(self.close_tab(BrowserTabInput {
                    thread_id: thread_id.to_string(),
                    tab_id,
                }))
            }
            "browser_close" => Some(self.close(thread_id)),
            "browser_tabs" | "browser_snapshot" | "browser_wait" | "browser_evaluate"
            | "browser_click" | "browser_type" | "browser_press" | "browser_hover"
            | "browser_select" | "browser_scroll" | "browser_screenshot" => {
                Some(self.get_state(thread_id))
            }
            _ => Some(self.get_state(thread_id)),
        };

        let state = next_state.unwrap_or_else(|| self.get_state(thread_id));
        if let Some(app) = app_handle {
            if state.open {
                crate::emit_app_event(
                    app,
                    "desktop:browser-use-request-open-panel",
                    &serde_json::json!({ "threadId": thread_id }),
                );
            }
            crate::emit_app_event(app, "desktop:browser-state", &state);
            self.sync_native_webviews(app);
        }

        let active_tab = state
            .active_tab_id
            .as_ref()
            .and_then(|id| state.tabs.iter().find(|t| &t.id == id))
            .or_else(|| state.tabs.first());

        Ok(serde_json::json!({
            "ok": true,
            "threadId": state.thread_id,
            "open": state.open,
            "activeTabId": state.active_tab_id,
            "url": active_tab.map(|t| t.url.clone()).unwrap_or_else(|| "about:blank".to_string()),
            "title": active_tab.map(|t| t.title.clone()).unwrap_or_default(),
            "tabs": state.tabs,
        }))
    }

    pub fn handle_rpc_json_message(
        &self,
        app_handle: Option<&tauri::AppHandle>,
        session_id_slot: &mut Option<String>,
        raw_json: &str,
    ) -> Option<String> {
        let parsed: serde_json::Value = serde_json::from_str(raw_json).ok()?;
        let id = parsed.get("id")?.clone();
        let method = parsed.get("method").and_then(|m| m.as_str())?;
        let params = parsed
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);

        let response = match method {
            "ping" => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": "pong",
            }),
            "getInfo" => {
                let req_session = params
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let req_cap = params
                    .get("capability")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if req_session.is_empty() || req_cap != self.capability {
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32010,
                            "message": "Browser authorization denied",
                        }
                    })
                } else {
                    *session_id_slot = Some(req_session.to_string());
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "name": "Saint Browser Host",
                            "version": "1.0.0",
                            "type": "saint-browser-host",
                            "metadata": {
                                "sessionId": req_session,
                                "protocolVersion": 1,
                                "physicalScope": "visible-shared-electron-webview",
                                "methods": ["executeTool"],
                            }
                        }
                    })
                }
            }
            "executeTool" => {
                let thread_id = params
                    .get("thread_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));

                if thread_id.is_empty() || tool_name.is_empty() {
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32010,
                            "message": "BrowserInputUnsupported",
                        }
                    })
                } else {
                    match self.execute_rpc_tool(app_handle, thread_id, tool_name, &arguments) {
                        Ok(result) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": result,
                        }),
                        Err(err) => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": err,
                            }
                        }),
                    }
                }
            }
            _ => serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("No handler registered for method: {method}"),
                }
            }),
        };

        serde_json::to_string(&response).ok()
    }

    pub fn start_rpc_pipe_server(self: &Arc<Self>, app_handle: tauri::AppHandle) {
        let manager = Arc::clone(self);
        let pipe_path = self.pipe_path.clone();

        tauri::async_runtime::spawn(async move {
            #[cfg(target_os = "windows")]
            {
                use tokio::net::windows::named_pipe::ServerOptions;
                let mut first = true;
                loop {
                    let server = match ServerOptions::new()
                        .first_pipe_instance(first)
                        .create(&pipe_path)
                    {
                        Ok(s) => s,
                        Err(err) => {
                            eprintln!(
                                "[saint-desktop-rust] Failed to create browser pipe {pipe_path}: {err}"
                            );
                            break;
                        }
                    };
                    first = false;
                    if server.connect().await.is_err() {
                        continue;
                    }
                    let mgr = Arc::clone(&manager);
                    let app = app_handle.clone();
                    tokio::spawn(async move {
                        let _ = serve_pipe_stream(server, mgr, Some(app)).await;
                    });
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                if let Some(parent) = std::path::Path::new(&pipe_path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::remove_file(&pipe_path);
                let Ok(listener) = tokio::net::UnixListener::bind(&pipe_path) else {
                    return;
                };
                while let Ok((stream, _)) = listener.accept().await {
                    let mgr = Arc::clone(&manager);
                    let app = app_handle.clone();
                    tokio::spawn(async move {
                        let _ = serve_pipe_stream(stream, mgr, Some(app)).await;
                    });
                }
            }
        });
    }
}

pub async fn serve_pipe_stream<S>(
    mut stream: S,
    manager: Arc<BrowserManager>,
    app_handle: Option<tauri::AppHandle>,
) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut session_id: Option<String> = None;
    loop {
        let mut header = [0u8; 4];
        if stream.read_exact(&mut header).await.is_err() {
            break;
        }
        let len = u32::from_ne_bytes(header) as usize;
        if len == 0 || len > MAX_BROWSER_PIPE_FRAME_BYTES {
            break;
        }
        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload).await?;
        let Ok(raw_json) = String::from_utf8(payload) else {
            break;
        };
        if let Some(resp_json) =
            manager.handle_rpc_json_message(app_handle.as_ref(), &mut session_id, &raw_json)
        {
            let resp_bytes = resp_json.as_bytes();
            let resp_header = (resp_bytes.len() as u32).to_ne_bytes();
            stream.write_all(&resp_header).await?;
            stream.write_all(resp_bytes).await?;
            stream.flush().await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manages_thread_browser_tabs_and_history() {
        let manager = BrowserManager::new();
        let opened = manager.open(BrowserOpenInput {
            thread_id: "thread-1".into(),
            initial_url: Some("localhost:3000".into()),
        });
        assert!(opened.open);
        assert_eq!(opened.tabs.len(), 1);
        let tab_id = opened.tabs[0].id.clone();
        assert_eq!(opened.tabs[0].url, "http://localhost:3000");

        let navigated = manager.navigate(BrowserNavigateInput {
            thread_id: "thread-1".into(),
            tab_id: Some(tab_id.clone()),
            url: "https://example.com".into(),
        });
        assert_eq!(navigated.tabs[0].url, "https://example.com");
        assert!(navigated.tabs[0].can_go_back);

        let back = manager.go_back(BrowserTabInput {
            thread_id: "thread-1".into(),
            tab_id,
        });
        assert_eq!(back.tabs[0].url, "http://localhost:3000");
        assert!(back.tabs[0].can_go_forward);
    }

    #[test]
    fn handles_browser_host_rpc_get_info_and_execute_tool() {
        let manager = BrowserManager::new();
        let cap = manager.capability().to_string();
        let mut session_id = None;

        // Invalid capability is rejected
        let bad_info = manager
            .handle_rpc_json_message(
                None,
                &mut session_id,
                r#"{"jsonrpc":"2.0","id":1,"method":"getInfo","params":{"session_id":"s1","capability":"wrong"}}"#,
            )
            .unwrap();
        assert!(bad_info.contains("error"));

        // Valid capability succeeds and returns protocolVersion 1
        let good_info = manager
            .handle_rpc_json_message(
                None,
                &mut session_id,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "getInfo",
                    "params": { "session_id": "s1", "capability": cap }
                })
                .to_string(),
            )
            .unwrap();
        assert!(good_info.contains("\"protocolVersion\":1"));
        assert_eq!(session_id.as_deref(), Some("s1"));

        // executeTool browser_open opens the tab for the thread
        let exec_resp = manager
            .handle_rpc_json_message(
                None,
                &mut session_id,
                &serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "executeTool",
                    "params": {
                        "session_id": "s1",
                        "provider": "codex",
                        "thread_id": "thread-rpc-1",
                        "name": "browser_open",
                        "arguments": { "url": "localhost:5733" }
                    }
                })
                .to_string(),
            )
            .unwrap();
        assert!(exec_resp.contains("http://localhost:5733"));
        assert!(manager.get_state("thread-rpc-1").open);
    }
}
