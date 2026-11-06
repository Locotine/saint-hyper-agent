// FILE: updater.rs
// Purpose: Stable-only desktop update state coordinator wrapping `tauri-plugin-updater`
//          (Option 3.2-A: Saint Beta removed; only production Stable channel remains).
// Layer: Desktop Auto-Updater state machine.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub const SAINT_RELEASES_URL: &str = "https://github.com/Locotine/saint-hyper-agent/releases";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateState {
    pub enabled: bool,
    pub status: String,
    pub current_version: String,
    pub host_arch: String,
    pub app_arch: String,
    pub running_under_arm64_translation: bool,
    pub available_version: Option<String>,
    pub downloaded_version: Option<String>,
    pub download_percent: Option<f64>,
    pub checked_at: Option<String>,
    pub message: Option<String>,
    pub error_context: Option<String>,
    pub can_retry: bool,
    pub install_failure_count: u32,
    pub flavor: String,
    pub release_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateActionResult {
    pub accepted: bool,
    pub completed: bool,
    pub state: DesktopUpdateState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedSemver {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<String>,
}

fn parse_semver(version: &str) -> Option<ParsedSemver> {
    let trimmed = version.trim().trim_start_matches('v');
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core, prerelease) = match without_build.split_once('-') {
        Some((c, pre)) if !pre.is_empty() => (c, Some(pre.to_string())),
        Some(_) => return None,
        None => (without_build, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedSemver {
        major,
        minor,
        patch,
        prerelease,
    })
}

pub fn is_update_version_allowed_for_stable(candidate_version: &str) -> bool {
    parse_semver(candidate_version)
        .map(|v| v.prerelease.is_none())
        .unwrap_or(false)
}

pub fn is_update_version_newer(current_version: &str, candidate_version: &str) -> bool {
    let (Some(curr), Some(cand)) = (parse_semver(current_version), parse_semver(candidate_version))
    else {
        return candidate_version.trim() != current_version.trim();
    };
    if cand.major != curr.major {
        return cand.major > curr.major;
    }
    if cand.minor != curr.minor {
        return cand.minor > curr.minor;
    }
    if cand.patch != curr.patch {
        return cand.patch > curr.patch;
    }
    curr.prerelease.is_some() && cand.prerelease.is_none()
}

pub fn now_iso8601() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Calculate UTC calendar components from Unix epoch seconds (Howard Hinnant's algorithm)
    let days = (secs / 86_400) as i64;
    let rem_secs = secs % 86_400;
    let hours = rem_secs / 3600;
    let minutes = (rem_secs % 3600) / 60;
    let seconds = rem_secs % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    format!("{year:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn detect_rosetta_translation() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .args(["-n", "sysctl.proc_translated"])
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|s| s.trim() == "1")
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub struct UpdaterCoordinator {
    state: Mutex<DesktopUpdateState>,
}

impl UpdaterCoordinator {
    pub fn new() -> Self {
        let app_arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else if cfg!(target_arch = "x86_64") {
            "x64"
        } else {
            "other"
        };
        let running_under_arm64_translation = detect_rosetta_translation();
        let host_arch = if running_under_arm64_translation {
            "arm64"
        } else {
            app_arch
        };

        let disabled_by_env = std::env::var("SAINT_DISABLE_AUTO_UPDATE")
            .ok()
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let enabled = !cfg!(debug_assertions) && !disabled_by_env;
        let disabled_reason = if disabled_by_env {
            Some(
                "Automatic updates are disabled by the SAINT_DISABLE_AUTO_UPDATE setting."
                    .to_string(),
            )
        } else if cfg!(debug_assertions) {
            Some("Automatic updates are only available in packaged production builds.".to_string())
        } else {
            None
        };

        let initial = DesktopUpdateState {
            enabled,
            status: if enabled {
                "idle".to_string()
            } else {
                "disabled".to_string()
            },
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            host_arch: host_arch.to_string(),
            app_arch: app_arch.to_string(),
            running_under_arm64_translation,
            available_version: None,
            downloaded_version: None,
            download_percent: None,
            checked_at: None,
            message: disabled_reason,
            error_context: None,
            can_retry: false,
            install_failure_count: 0,
            flavor: "production".to_string(),
            release_url: Some(SAINT_RELEASES_URL.to_string()),
        };

        Self {
            state: Mutex::new(initial),
        }
    }

    pub fn get_state(&self) -> DesktopUpdateState {
        self.state.lock().expect("updater mutex poisoned").clone()
    }

    pub fn begin_check(&self) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        if !guard.enabled {
            return guard.clone();
        }
        guard.status = "checking".to_string();
        guard.message = None;
        guard.error_context = None;
        guard.can_retry = false;
        guard.clone()
    }

    pub fn mark_up_to_date(&self, timestamp_iso: String) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        guard.status = "up-to-date".to_string();
        guard.checked_at = Some(timestamp_iso);
        guard.available_version = None;
        guard.message = None;
        guard.error_context = None;
        guard.can_retry = false;
        guard.clone()
    }

    pub fn mark_available(&self, version: String, timestamp_iso: String) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        guard.status = "available".to_string();
        guard.available_version = Some(version);
        guard.checked_at = Some(timestamp_iso);
        guard.message = None;
        guard.error_context = None;
        guard.can_retry = false;
        guard.clone()
    }

    pub fn begin_download(&self) -> (bool, DesktopUpdateState) {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        if !guard.enabled || guard.available_version.is_none() {
            return (false, guard.clone());
        }
        guard.status = "downloading".to_string();
        guard.download_percent = Some(0.0);
        guard.message = None;
        guard.error_context = None;
        guard.can_retry = false;
        (true, guard.clone())
    }

    pub fn update_download_progress(&self, percent: f64) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        guard.status = "downloading".to_string();
        guard.download_percent = Some(percent.clamp(0.0, 100.0));
        guard.clone()
    }

    pub fn mark_downloaded(&self, version: String) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        guard.status = "downloaded".to_string();
        guard.downloaded_version = Some(version);
        guard.download_percent = Some(100.0);
        guard.message = None;
        guard.error_context = None;
        guard.can_retry = false;
        guard.clone()
    }

    pub fn begin_install(&self) -> (bool, DesktopUpdateState) {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        if !guard.enabled || guard.downloaded_version.is_none() {
            return (false, guard.clone());
        }
        guard.status = "installing".to_string();
        guard.message = None;
        guard.error_context = None;
        (true, guard.clone())
    }

    pub fn mark_error(&self, context: &str, message: String) -> DesktopUpdateState {
        let mut guard = self.state.lock().expect("updater mutex poisoned");
        if context == "install" {
            guard.install_failure_count += 1;
        }
        guard.status = if context == "download" && guard.available_version.is_some() {
            "available".to_string()
        } else {
            "error".to_string()
        };
        guard.error_context = Some(context.to_string());
        guard.message = Some(message);
        guard.can_retry = guard.available_version.is_some() || context == "check";
        guard.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_stable_versions_and_updater_transitions() {
        assert!(is_update_version_allowed_for_stable("1.2.0"));
        assert!(!is_update_version_allowed_for_stable("1.2.0-beta.1"));
        assert!(is_update_version_newer("1.1.17", "1.1.18"));
        assert!(!is_update_version_newer("1.1.17", "1.1.17"));
        assert!(is_update_version_newer("1.2.0-beta.1", "1.2.0"));

        let coord = UpdaterCoordinator::new();
        let avail = coord.mark_available("1.2.0".to_string(), "2026-11-06T00:00:00Z".to_string());
        assert_eq!(avail.status, "available");
        assert_eq!(avail.available_version.as_deref(), Some("1.2.0"));

        let downloaded = coord.mark_downloaded("1.2.0".to_string());
        assert_eq!(downloaded.status, "downloaded");
        assert_eq!(downloaded.download_percent, Some(100.0));
    }
}
