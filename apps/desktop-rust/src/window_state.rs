// FILE: window_state.rs
// Purpose: Persists and restores window bounds, custom titlebar preference,
//          agent cursor style, storage migration snapshot, and window material.
// Layer: Desktop state persistence & native window appearance.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

pub const DESKTOP_WINDOW_BLUR_RADIUS_MIN: u32 = 1;
pub const DESKTOP_WINDOW_BLUR_RADIUS_MAX: u32 = 64;
pub const SAINT_STORAGE_SNAPSHOT_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES: usize = 2_048;
pub const SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDesktopWindowState {
    pub version: u8,
    pub bounds: DesktopWindowBounds,
    pub is_maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowState {
    pub is_maximized: bool,
    pub is_fullscreen: bool,
}

pub fn read_desktop_window_state(path: &Path) -> Option<PersistedDesktopWindowState> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: PersistedDesktopWindowState = serde_json::from_str(&raw).ok()?;
    if parsed.version != 1 || parsed.bounds.width <= 0 || parsed.bounds.height <= 0 {
        return None;
    }
    Some(parsed)
}

pub fn write_desktop_window_state(
    path: &Path,
    state: &PersistedDesktopWindowState,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(state)?;
    std::fs::write(path, format!("{serialized}\n"))
}

fn intersection_area(left: DesktopWindowBounds, right: DesktopWindowBounds) -> i64 {
    let width = ((left.x + left.width).min(right.x + right.width) - left.x.max(right.x)).max(0);
    let height = ((left.y + left.height).min(right.y + right.height) - left.y.max(right.y)).max(0);
    i64::from(width) * i64::from(height)
}

pub fn resolve_visible_window_bounds(
    saved_bounds: DesktopWindowBounds,
    display_work_areas: &[DesktopWindowBounds],
    minimum_width: i32,
    minimum_height: i32,
) -> DesktopWindowBounds {
    let valid_areas: Vec<DesktopWindowBounds> = display_work_areas
        .iter()
        .copied()
        .filter(|area| area.width > 0 && area.height > 0)
        .collect();
    let Some(first_work_area) = valid_areas.first().copied() else {
        return saved_bounds;
    };

    let mut target_work_area = first_work_area;
    let mut largest_intersection = intersection_area(saved_bounds, target_work_area);
    for &work_area in &valid_areas[1..] {
        let area = intersection_area(saved_bounds, work_area);
        if area > largest_intersection {
            target_work_area = work_area;
            largest_intersection = area;
        }
    }

    let width = target_work_area
        .width
        .min(minimum_width.max(saved_bounds.width));
    let height = target_work_area
        .height
        .min(minimum_height.max(saved_bounds.height));
    let centered_x =
        target_work_area.x + ((target_work_area.width - width) as f64 / 2.0).round() as i32;
    let centered_y =
        target_work_area.y + ((target_work_area.height - height) as f64 / 2.0).round() as i32;

    let x = if largest_intersection == 0 {
        centered_x
    } else {
        saved_bounds.x.clamp(
            target_work_area.x,
            (target_work_area.x + target_work_area.width - width).max(target_work_area.x),
        )
    };
    let y = if largest_intersection == 0 {
        centered_y
    } else {
        saved_bounds.y.clamp(
            target_work_area.y,
            (target_work_area.y + target_work_area.height - height).max(target_work_area.y),
        )
    };

    DesktopWindowBounds {
        x,
        y,
        width,
        height,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedCustomTitleBarPreference {
    pub version: u8,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCustomTitleBarState {
    pub supported: bool,
    pub preference: bool,
    pub active: bool,
    pub restart_required: bool,
}

pub fn supports_custom_title_bar(platform: &str) -> bool {
    matches!(platform, "windows" | "win32" | "linux")
}

pub fn default_custom_title_bar_preference(platform: &str) -> bool {
    matches!(platform, "windows" | "win32")
}

pub fn read_custom_title_bar_preference(path: &Path) -> Option<bool> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: PersistedCustomTitleBarPreference = serde_json::from_str(&raw).ok()?;
    if parsed.version != 1 {
        return None;
    }
    Some(parsed.enabled)
}

pub fn write_custom_title_bar_preference(path: &Path, enabled: bool) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = PersistedCustomTitleBarPreference {
        version: 1,
        enabled,
    };
    let serialized = serde_json::to_string_pretty(&payload)?;
    std::fs::write(path, format!("{serialized}\n"))
}

pub fn resolve_desktop_custom_title_bar_state(
    platform: &str,
    preference: Option<bool>,
    active: bool,
) -> DesktopCustomTitleBarState {
    let supported = supports_custom_title_bar(platform);
    let resolved_pref = if supported {
        preference.unwrap_or_else(|| default_custom_title_bar_preference(platform))
    } else {
        false
    };
    let resolved_active = if supported { active } else { false };
    DesktopCustomTitleBarState {
        supported,
        preference: resolved_pref,
        active: resolved_active,
        restart_required: supported && resolved_pref != resolved_active,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCursorStylePreference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rim: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedAgentCursorPreference {
    pub version: u8,
    pub style: Option<AgentCursorStylePreference>,
}

fn normalize_hex_channel(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_ascii_lowercase();
    if candidate.len() == 7
        && candidate.starts_with('#')
        && candidate[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Some(candidate)
    } else {
        None
    }
}

pub fn normalize_agent_cursor_style(
    input: Option<AgentCursorStylePreference>,
) -> Option<AgentCursorStylePreference> {
    let style = input?;
    let fill = normalize_hex_channel(style.fill.as_deref());
    let rim = normalize_hex_channel(style.rim.as_deref());
    let shadow = normalize_hex_channel(style.shadow.as_deref());
    if fill.is_none() && rim.is_none() && shadow.is_none() {
        return None;
    }
    Some(AgentCursorStylePreference { fill, rim, shadow })
}

pub fn write_agent_cursor_preference(
    path: &Path,
    style: Option<AgentCursorStylePreference>,
) -> std::io::Result<()> {
    let normalized = normalize_agent_cursor_style(style);
    let Some(valid_style) = normalized else {
        let _ = std::fs::remove_file(path);
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = PersistedAgentCursorPreference {
        version: 1,
        style: Some(valid_style),
    };
    let serialized = serde_json::to_string_pretty(&payload)?;
    std::fs::write(path, format!("{serialized}\n"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaintStorageSnapshot {
    pub version: u8,
    pub exported_at: String,
    pub entries: BTreeMap<String, String>,
}

pub fn is_saint_storage_key(key: &str) -> bool {
    key.starts_with("saint:") || key.starts_with("saint.")
}

pub fn read_saint_storage_snapshot(path: &Path) -> Option<SaintStorageSnapshot> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() as usize > SAINT_STORAGE_SNAPSHOT_MAX_BYTES {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    if raw.len() > SAINT_STORAGE_SNAPSHOT_MAX_BYTES {
        return None;
    }
    let snapshot: SaintStorageSnapshot = serde_json::from_str(&raw).ok()?;
    if snapshot.version != 1
        || snapshot.exported_at.trim().is_empty()
        || snapshot.entries.len() > SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES
    {
        return None;
    }
    for (k, v) in &snapshot.entries {
        if k.is_empty()
            || k.len() > SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH
            || !is_saint_storage_key(k)
            || v.len() > SAINT_STORAGE_SNAPSHOT_MAX_BYTES
        {
            return None;
        }
    }
    Some(snapshot)
}

pub fn acknowledge_saint_storage_snapshot(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowMaterial {
    pub material: WindowMaterialKind,
    pub blur_radius: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMaterialKind {
    Opaque,
    Translucent,
}

pub fn resolve_window_translucency() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        return Some("native");
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_ok() {
            return Some("compositor");
        }
        return None;
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

pub fn apply_window_material(
    window: &tauri::WebviewWindow,
    input: DesktopWindowMaterial,
) -> bool {
    let _clamped_radius = input
        .blur_radius
        .clamp(DESKTOP_WINDOW_BLUR_RADIUS_MIN, DESKTOP_WINDOW_BLUR_RADIUS_MAX);

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial};
        match input.material {
            WindowMaterialKind::Translucent => apply_vibrancy(
                window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                Some(_clamped_radius as f64),
            )
            .is_ok(),
            WindowMaterialKind::Opaque => clear_vibrancy(window).is_ok(),
        }
    }
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_mica, clear_mica};
        match input.material {
            WindowMaterialKind::Translucent => apply_mica(window, None).is_ok(),
            WindowMaterialKind::Opaque => clear_mica(window).is_ok(),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        false
    }
}

pub const CONTEXT_MENU_MAX_DEPTH: usize = 3;
pub const MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH: usize = 32 * 1024 * 1024;
pub const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContextMenuItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub separator_before: bool,
    #[serde(default)]
    pub destructive: bool,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub icon_data_url: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<DesktopContextMenuItem>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ContextMenuPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedContextMenuNode {
    Separator,
    Leaf {
        id: String,
        label: String,
    },
    Submenu {
        label: String,
        children: Vec<ResolvedContextMenuNode>,
    },
}

pub fn build_context_menu_nodes(
    items: &[DesktopContextMenuItem],
    depth: usize,
) -> Vec<ResolvedContextMenuNode> {
    let mut nodes = Vec::new();
    let mut has_inserted_destructive_separator = false;

    for item in items {
        if item.id.is_empty() || item.label.is_empty() {
            continue;
        }
        let has_children = item.children.is_some();
        let submenu_children = match (&item.children, depth < CONTEXT_MENU_MAX_DEPTH) {
            (Some(children), true) => build_context_menu_nodes(children, depth + 1),
            _ => Vec::new(),
        };
        if has_children && submenu_children.is_empty() {
            continue;
        }

        let should_insert_separator = item.separator_before
            || (item.destructive && !has_inserted_destructive_separator);
        if should_insert_separator && !nodes.is_empty() {
            nodes.push(ResolvedContextMenuNode::Separator);
        }
        if item.destructive {
            has_inserted_destructive_separator = true;
        }

        if has_children {
            nodes.push(ResolvedContextMenuNode::Submenu {
                label: item.label.clone(),
                children: submenu_children,
            });
        } else {
            nodes.push(ResolvedContextMenuNode::Leaf {
                id: item.id.clone(),
                label: item.label.clone(),
            });
        }
    }

    nodes
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMenuShortcut {
    pub key: String,
    pub meta_key: bool,
    pub ctrl_key: bool,
    pub shift_key: bool,
    pub alt_key: bool,
    pub mod_key: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopMenuShortcuts {
    #[serde(rename = "terminal.new")]
    pub terminal_new: Option<DesktopMenuShortcut>,
    #[serde(rename = "sidebar.toggle")]
    pub sidebar_toggle: Option<DesktopMenuShortcut>,
    #[serde(rename = "browser.toggle")]
    pub browser_toggle: Option<DesktopMenuShortcut>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopMenuAccelerators {
    pub terminal_new: Option<String>,
    pub sidebar_toggle: Option<String>,
    pub browser_toggle: Option<String>,
}

impl Default for DesktopMenuAccelerators {
    fn default() -> Self {
        Self {
            terminal_new: Some("CmdOrCtrl+T".to_string()),
            sidebar_toggle: Some("CmdOrCtrl+B".to_string()),
            browser_toggle: Some("CmdOrCtrl+Shift+B".to_string()),
        }
    }
}

fn is_function_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix('f') else {
        return false;
    };
    matches!(rest.parse::<u8>(), Ok(1..=24))
}

fn accelerator_key(key: &str) -> Option<String> {
    match key {
        " " => return Some("Space".to_string()),
        "+" => return Some("Plus".to_string()),
        "escape" => return Some("Escape".to_string()),
        "enter" => return Some("Enter".to_string()),
        "tab" => return Some("Tab".to_string()),
        "backspace" => return Some("Backspace".to_string()),
        "delete" => return Some("Delete".to_string()),
        "insert" => return Some("Insert".to_string()),
        "home" => return Some("Home".to_string()),
        "end" => return Some("End".to_string()),
        "pageup" => return Some("PageUp".to_string()),
        "pagedown" => return Some("PageDown".to_string()),
        "arrowup" => return Some("Up".to_string()),
        "arrowdown" => return Some("Down".to_string()),
        "arrowleft" => return Some("Left".to_string()),
        "arrowright" => return Some("Right".to_string()),
        _ => {}
    }
    if (key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase()) || is_function_key(key) {
        return Some(key.to_ascii_uppercase());
    }
    if key.len() == 1 {
        let ch = key.chars().next()?;
        if ch.is_ascii_digit() || "`~!@#$%^&*()-_=[]{}\\|;:'\",.<>/?".contains(ch) {
            return Some(key.to_string());
        }
    }
    None
}

pub fn keybinding_shortcut_to_accelerator(
    shortcut: &DesktopMenuShortcut,
    platform: &str,
) -> Option<String> {
    if shortcut.key.is_empty() || shortcut.key.len() > 64 {
        return None;
    }
    let key = accelerator_key(&shortcut.key)?;
    let has_command_modifier =
        shortcut.mod_key || shortcut.meta_key || shortcut.ctrl_key || shortcut.alt_key;
    if !has_command_modifier && !is_function_key(&shortcut.key) {
        return None;
    }

    let is_mac = matches!(platform, "macos" | "darwin");
    let mut parts = Vec::new();
    if shortcut.mod_key {
        parts.push("CmdOrCtrl".to_string());
    }
    if shortcut.ctrl_key && (is_mac || !shortcut.mod_key) {
        parts.push("Ctrl".to_string());
    }
    if shortcut.alt_key {
        parts.push("Alt".to_string());
    }
    if shortcut.shift_key {
        parts.push("Shift".to_string());
    }
    if shortcut.meta_key && !(is_mac && shortcut.mod_key) {
        parts.push(if is_mac { "Cmd" } else { "Super" }.to_string());
    }
    parts.push(key);
    Some(parts.join("+"))
}

pub fn resolve_reported_menu_accelerators(
    shortcuts: &DesktopMenuShortcuts,
    platform: &str,
) -> DesktopMenuAccelerators {
    DesktopMenuAccelerators {
        terminal_new: shortcuts
            .terminal_new
            .as_ref()
            .and_then(|s| keybinding_shortcut_to_accelerator(s, platform)),
        sidebar_toggle: shortcuts
            .sidebar_toggle
            .as_ref()
            .and_then(|s| keybinding_shortcut_to_accelerator(s, platform)),
        browser_toggle: shortcuts
            .browser_toggle
            .as_ref()
            .and_then(|s| keybinding_shortcut_to_accelerator(s, platform)),
    }
}

pub fn decode_clipboard_png_data_url(raw_data_url: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    if raw_data_url.len() > MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH {
        return None;
    }
    let trimmed = raw_data_url.trim();
    let encoded = trimmed.strip_prefix(PNG_DATA_URL_PREFIX)?;
    if encoded.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    // Verify PNG signature (89 50 4E 47 0D 0A 1A 0A)
    if bytes.len() < 8 || bytes[..8] != [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return None;
    }
    Some(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQuitConfirmationChat {
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopQuitConfirmationRequest {
    pub request_id: String,
    pub presentation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum DesktopQuitConfirmationResponse {
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        request_id: String,
        running_count: i64,
        #[serde(default)]
        chats: Vec<DesktopQuitConfirmationChat>,
    },
    #[serde(rename = "decision", rename_all = "camelCase")]
    Decision {
        request_id: String,
        allow: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_visible_window_bounds_within_work_area() {
        let saved = DesktopWindowBounds {
            x: -5000,
            y: -5000,
            width: 1200,
            height: 800,
        };
        let work_areas = vec![DesktopWindowBounds {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }];
        let resolved = resolve_visible_window_bounds(saved, &work_areas, 800, 600);
        assert_eq!(resolved.width, 1200);
        assert_eq!(resolved.height, 800);
        assert_eq!(resolved.x, 360);
        assert_eq!(resolved.y, 140);
    }

    #[test]
    fn normalizes_agent_cursor_colors() {
        let valid = normalize_agent_cursor_style(Some(AgentCursorStylePreference {
            fill: Some(" #AABBCC ".into()),
            rim: Some("invalid".into()),
            shadow: None,
        }));
        assert_eq!(
            valid,
            Some(AgentCursorStylePreference {
                fill: Some("#aabbcc".into()),
                rim: None,
                shadow: None,
            })
        );
        assert_eq!(
            normalize_agent_cursor_style(Some(AgentCursorStylePreference {
                fill: Some("not-a-color".into()),
                rim: None,
                shadow: None,
            })),
            None
        );
    }

    #[test]
    fn builds_context_menu_nodes_with_separators_and_max_depth() {
        let items = vec![
            DesktopContextMenuItem {
                id: "rename".into(),
                label: "Rename".into(),
                separator_before: false,
                destructive: false,
                icon: None,
                icon_data_url: None,
                children: None,
            },
            DesktopContextMenuItem {
                id: "empty-group".into(),
                label: "Empty".into(),
                separator_before: false,
                destructive: false,
                icon: None,
                icon_data_url: None,
                children: Some(vec![]),
            },
            DesktopContextMenuItem {
                id: "delete".into(),
                label: "Delete".into(),
                separator_before: false,
                destructive: true,
                icon: None,
                icon_data_url: None,
                children: None,
            },
        ];

        let nodes = build_context_menu_nodes(&items, 1);
        assert_eq!(
            nodes,
            vec![
                ResolvedContextMenuNode::Leaf {
                    id: "rename".into(),
                    label: "Rename".into(),
                },
                ResolvedContextMenuNode::Separator,
                ResolvedContextMenuNode::Leaf {
                    id: "delete".into(),
                    label: "Delete".into(),
                },
            ]
        );
    }

    #[test]
    fn resolves_menu_accelerators_and_decodes_png_data_url() {
        let shortcuts = DesktopMenuShortcuts {
            terminal_new: Some(DesktopMenuShortcut {
                key: "t".into(),
                meta_key: false,
                ctrl_key: false,
                shift_key: false,
                alt_key: false,
                mod_key: true,
            }),
            sidebar_toggle: None,
            browser_toggle: Some(DesktopMenuShortcut {
                key: "b".into(),
                meta_key: false,
                ctrl_key: false,
                shift_key: true,
                alt_key: false,
                mod_key: true,
            }),
        };
        let resolved = resolve_reported_menu_accelerators(&shortcuts, "windows");
        assert_eq!(resolved.terminal_new.as_deref(), Some("CmdOrCtrl+T"));
        assert_eq!(resolved.sidebar_toggle, None);
        assert_eq!(resolved.browser_toggle.as_deref(), Some("CmdOrCtrl+Shift+B"));

        // 1x1 transparent PNG
        let valid_png_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
        assert!(decode_clipboard_png_data_url(valid_png_url).is_some());
        assert!(decode_clipboard_png_data_url("data:image/jpeg;base64,abc").is_none());
    }
}
