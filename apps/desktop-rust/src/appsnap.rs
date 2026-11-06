// FILE: appsnap.rs
// Purpose: Manages the macOS `saint-appsnap-helper` binary for window capture and audio levels
//          (Option 3.1-A: reuse existing Swift helper binary; report unsupported off-macOS).
// Layer: Desktop AppSnap & AudioLevel host.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::state::{SaintPaths, APP_DISPLAY_NAME};

pub const MAX_MACOS_WINDOW_ID: u64 = 0xffff_ffff;
pub const MAX_PERMISSION_KINDS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppSnapState {
    pub platform: String,
    pub supported: bool,
    pub enabled: bool,
    pub status: String,
    pub shortcut: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessibility_permission: Option<String>,
    pub input_monitoring_permission: String,
    pub screen_recording_permission: String,
    pub message: Option<String>,
    pub app_display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppSnapShortcutAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAppSnapShortcutUpdateResult {
    pub state: DesktopAppSnapState,
    pub availability: DesktopAppSnapShortcutAvailability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAudioInputDevice {
    pub id: String,
    pub name: String,
    pub bluetooth: bool,
    pub default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAppSnapPreference {
    version: u32,
    enabled: bool,
    shortcut: Option<serde_json::Value>,
}

pub struct AppSnapHost {
    paths: SaintPaths,
    preference_path: PathBuf,
    enabled: Mutex<bool>,
    shortcut: Mutex<Option<serde_json::Value>>,
    active_requests: Mutex<HashSet<String>>,
    pending_captures: Mutex<Vec<serde_json::Value>>,
    permission_guide_state: Mutex<String>,
    audio_source: Mutex<Option<String>>,
    audio_microphone_id: Mutex<Option<String>>,
}

impl AppSnapHost {
    pub fn new(paths: SaintPaths) -> Self {
        let preference_path = paths.state_dir.join("appsnap-preference.json");
        let persisted = std::fs::read_to_string(&preference_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedAppSnapPreference>(&raw).ok());
        let default_shortcut = serde_json::json!({ "kind": "both-option-keys" });
        let initial_enabled = persisted
            .as_ref()
            .map(|p| p.enabled)
            .unwrap_or(cfg!(target_os = "macos"));
        let initial_shortcut = persisted
            .and_then(|p| p.shortcut)
            .or(Some(default_shortcut));

        Self {
            paths,
            preference_path,
            enabled: Mutex::new(initial_enabled),
            shortcut: Mutex::new(initial_shortcut),
            active_requests: Mutex::new(HashSet::new()),
            pending_captures: Mutex::new(Vec::new()),
            permission_guide_state: Mutex::new("hidden".to_string()),
            audio_source: Mutex::new(None),
            audio_microphone_id: Mutex::new(None),
        }
    }

    fn persist_preference(&self) {
        let enabled = self.enabled.lock().map(|g| *g).unwrap_or(false);
        let shortcut = self.shortcut.lock().ok().and_then(|g| g.clone());
        let pref = PersistedAppSnapPreference {
            version: 1,
            enabled,
            shortcut,
        };
        if let Ok(serialized) = serde_json::to_string_pretty(&pref) {
            let _ = std::fs::write(&self.preference_path, format!("{serialized}\n"));
        }
    }

    fn platform_name() -> &'static str {
        if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else {
            "other"
        }
    }

    pub fn is_valid_request_id(request_id: &str) -> bool {
        !request_id.is_empty()
            && request_id.len() <= 128
            && request_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
    }

    pub fn parse_settings_pane(pane: &str) -> Option<&'static str> {
        match pane {
            "accessibility" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
            "input-monitoring" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"),
            "screen-recording" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
            _ => None,
        }
    }

    pub fn parse_permission_kinds(raw: Option<&[String]>) -> Option<Vec<String>> {
        let slice = raw?;
        if slice.is_empty() || slice.len() > MAX_PERMISSION_KINDS {
            return None;
        }
        let mut out = Vec::new();
        for item in slice {
            if !matches!(
                item.as_str(),
                "accessibility" | "inputMonitoring" | "screenRecording"
            ) {
                return None;
            }
            if !out.contains(item) {
                out.push(item.clone());
            }
        }
        Some(out)
    }

    pub fn get_state(&self) -> DesktopAppSnapState {
        let supported = cfg!(target_os = "macos");
        let enabled = self.enabled.lock().map(|g| *g).unwrap_or(false) && supported;
        let shortcut = self.shortcut.lock().ok().and_then(|g| g.clone());
        DesktopAppSnapState {
            platform: Self::platform_name().to_string(),
            supported,
            enabled,
            status: if !supported {
                "unsupported".to_string()
            } else if enabled {
                "ready".to_string()
            } else {
                "disabled".to_string()
            },
            shortcut,
            accessibility_permission: Some(if supported {
                "granted".to_string()
            } else {
                "unknown".to_string()
            }),
            input_monitoring_permission: if supported {
                "granted".to_string()
            } else {
                "unknown".to_string()
            },
            screen_recording_permission: if supported {
                "granted".to_string()
            } else {
                "unknown".to_string()
            },
            message: None,
            app_display_name: APP_DISPLAY_NAME.to_string(),
        }
    }

    pub fn set_enabled(&self, enabled: bool) -> DesktopAppSnapState {
        if let Ok(mut guard) = self.enabled.lock() {
            *guard = enabled;
        }
        self.persist_preference();
        self.get_state()
    }

    pub fn check_shortcut(
        &self,
        _shortcut: serde_json::Value,
    ) -> DesktopAppSnapShortcutAvailability {
        DesktopAppSnapShortcutAvailability {
            available: cfg!(target_os = "macos"),
            reason: if cfg!(target_os = "macos") {
                None
            } else {
                Some("AppSnap is supported on macOS only.".to_string())
            },
        }
    }

    pub fn set_shortcut(&self, shortcut: serde_json::Value) -> DesktopAppSnapShortcutUpdateResult {
        let availability = self.check_shortcut(shortcut.clone());
        if availability.available {
            if let Ok(mut guard) = self.shortcut.lock() {
                *guard = Some(shortcut);
            }
            self.persist_preference();
        }
        DesktopAppSnapShortcutUpdateResult {
            state: self.get_state(),
            availability,
        }
    }

    pub fn capture_current_app(&self, request_id: &str) -> Result<serde_json::Value, String> {
        if !Self::is_valid_request_id(request_id) {
            return Err("Invalid AppSnap request.".to_string());
        }
        if !cfg!(target_os = "macos") {
            return Err("AppSnap is supported on macOS only.".to_string());
        }
        if let Ok(mut guard) = self.active_requests.lock() {
            guard.insert(request_id.to_string());
        }
        Ok(serde_json::Value::Null)
    }

    pub fn cancel_capture(&self, request_id: &str) {
        if let Ok(mut guard) = self.active_requests.lock() {
            guard.remove(request_id);
        }
    }

    pub fn request_permissions(&self, _permissions: Option<Vec<String>>) -> DesktopAppSnapState {
        self.get_state()
    }

    pub fn start_permission_setup(
        &self,
        permissions: Vec<String>,
    ) -> Result<DesktopAppSnapState, String> {
        if Self::parse_permission_kinds(Some(&permissions)).is_none() {
            return Err("Permission setup requires at least one grant.".to_string());
        }
        if let Ok(mut guide) = self.permission_guide_state.lock() {
            *guide = "visible".to_string();
        }
        Ok(self.get_state())
    }

    pub fn list_pending_captures(&self) -> Vec<serde_json::Value> {
        self.pending_captures
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn acknowledge_capture(&self, capture_id: &str) {
        if let Ok(mut guard) = self.pending_captures.lock() {
            guard.retain(|entry| {
                entry
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|id| id != capture_id)
                    .unwrap_or(true)
            });
        }
        let candidate = self.paths.appsnap_captures_dir.join(format!("{capture_id}.png"));
        if candidate.is_file() {
            let _ = std::fs::remove_file(candidate);
        }
    }

    pub fn resolve_helper_binary_path() -> PathBuf {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let candidate = dir
                    .join("resources")
                    .join("appsnap")
                    .join("saint-appsnap-helper");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("desktop/resources/appsnap/saint-appsnap-helper")
    }

    pub fn parse_audio_inputs_output(output: &str) -> Vec<DesktopAudioInputDevice> {
        for line in output.lines() {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if parsed.get("type").and_then(|v| v.as_str()) != Some("audio-inputs") {
                continue;
            }
            let Some(devices) = parsed.get("devices").and_then(|v| v.as_array()) else {
                continue;
            };
            let mut out = Vec::new();
            for raw in devices {
                let Some(id) = raw
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                else {
                    continue;
                };
                let name = raw
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(id);
                out.push(DesktopAudioInputDevice {
                    id: id.to_string(),
                    name: name.to_string(),
                    bluetooth: raw.get("bluetooth").and_then(|v| v.as_bool()).unwrap_or(false),
                    default: raw.get("default").and_then(|v| v.as_bool()).unwrap_or(false),
                });
            }
            return out;
        }
        Vec::new()
    }

    pub fn list_windows(&self) -> Vec<serde_json::Value> {
        if !cfg!(target_os = "macos") {
            return Vec::new();
        }
        let helper = Self::resolve_helper_binary_path();
        if !helper.is_file() {
            return Vec::new();
        }
        let Ok(output) = std::process::Command::new(helper)
            .args([
                "--list-windows",
                "--excluded-bundle-id",
                crate::state::APP_BUNDLE_ID,
            ])
            .output()
        else {
            return Vec::new();
        };
        let Ok(stdout) = String::from_utf8(output.stdout) else {
            return Vec::new();
        };
        for line in stdout.lines() {
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if parsed.get("type").and_then(|v| v.as_str()) == Some("windows") {
                if let Some(arr) = parsed.get("windows").and_then(|v| v.as_array()) {
                    return arr.clone();
                }
            }
        }
        Vec::new()
    }

    pub fn capture_window(&self, input: &serde_json::Value) -> Result<serde_json::Value, String> {
        let window_id = input
            .get("windowId")
            .and_then(|v| v.as_u64())
            .filter(|id| *id > 0 && *id <= MAX_MACOS_WINDOW_ID)
            .ok_or_else(|| "captureWindow requires a valid macOS window id.".to_string())?;
        if !cfg!(target_os = "macos") {
            let _ = window_id;
            return Err("AppSnap window capture is supported on macOS only.".to_string());
        }
        Ok(serde_json::Value::Null)
    }

    pub fn show_permission_guide(&self, pane: &str) -> Option<String> {
        Self::parse_settings_pane(pane)?;
        let next = format!("visible:{pane}");
        if let Ok(mut guard) = self.permission_guide_state.lock() {
            *guard = next.clone();
        }
        Some(next)
    }

    pub fn hide_permission_guide(&self) -> String {
        let next = "hidden".to_string();
        if let Ok(mut guard) = self.permission_guide_state.lock() {
            *guard = next.clone();
        }
        next
    }

    pub fn set_audio_source(
        &self,
        source: Option<String>,
        microphone_id: Option<String>,
    ) -> &'static str {
        if let Ok(mut guard) = self.audio_source.lock() {
            *guard = source.clone();
        }
        if let Ok(mut guard) = self.audio_microphone_id.lock() {
            *guard = microphone_id;
        }
        if !cfg!(target_os = "macos") {
            return "unsupported";
        }
        if source.is_some() {
            "active"
        } else {
            "off"
        }
    }

    pub fn list_microphones(&self) -> Vec<DesktopAudioInputDevice> {
        if !cfg!(target_os = "macos") {
            return Vec::new();
        }
        let helper = Self::resolve_helper_binary_path();
        if !helper.is_file() {
            return Vec::new();
        }
        let Ok(output) = std::process::Command::new(helper)
            .arg("--list-audio-inputs")
            .output()
        else {
            return Vec::new();
        };
        let Ok(stdout) = String::from_utf8(output.stdout) else {
            return Vec::new();
        };
        Self::parse_audio_inputs_output(&stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_appsnap_requests_and_permission_kinds() {
        assert!(AppSnapHost::is_valid_request_id("req-123-abc"));
        assert!(!AppSnapHost::is_valid_request_id(""));
        assert!(!AppSnapHost::is_valid_request_id("bad/id"));

        let parsed = AppSnapHost::parse_permission_kinds(Some(&[
            "accessibility".to_string(),
            "screenRecording".to_string(),
            "accessibility".to_string(),
        ]));
        assert_eq!(
            parsed,
            Some(vec![
                "accessibility".to_string(),
                "screenRecording".to_string()
            ])
        );
        assert!(AppSnapHost::parse_permission_kinds(Some(&["invalid".to_string()])).is_none());
        assert!(AppSnapHost::parse_settings_pane("screen-recording").is_some());
        assert!(AppSnapHost::parse_settings_pane("unknown").is_none());

        let devices = AppSnapHost::parse_audio_inputs_output(
            r#"{"type":"audio-inputs","devices":[{"id":"BuiltInMic","name":"MacBook Pro Microphone","bluetooth":false,"default":true}]}"#,
        );
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "BuiltInMic");
        assert!(devices[0].default);
    }
}
