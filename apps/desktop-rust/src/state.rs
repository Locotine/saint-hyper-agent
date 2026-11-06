// FILE: state.rs
// Purpose: Resolves `~/.saint` (`SAINT_HOME`) paths and holds shared Rust Desktop state.
// Layer: Desktop core state (Stable-only per migration specification).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::oneshot;

use crate::appsnap::AppSnapHost;
use crate::backend::BackendSupervisor;
use crate::browser::BrowserManager;
use crate::cua_host::CuaDriverHost;
use crate::lan_relay::LanRelayManager;
use crate::pty_host::PtyHostManager;
use crate::remote_ssh::RemoteSshManager;
use crate::updater::UpdaterCoordinator;
use crate::window_state::{AgentCursorStylePreference, DesktopMenuAccelerators};

pub const APP_DISPLAY_NAME: &str = "Saint";
pub const APP_BUNDLE_ID: &str = "com.locotine.saint";
pub const DEFAULT_HOME_DIR_NAME: &str = ".saint";
pub const DESKTOP_SCHEME: &str = "saint";
pub const LOCAL_HTML_PREVIEW_SCHEME: &str = "saint-html-preview";

#[derive(Debug, Clone)]
pub struct SaintPaths {
    pub base_dir: PathBuf,
    pub is_isolated_dev_instance: bool,
    pub state_dir: PathBuf,
    pub log_dir: PathBuf,
    pub window_state_path: PathBuf,
    pub custom_title_bar_path: PathBuf,
    pub agent_cursor_preference_path: PathBuf,
    pub storage_snapshot_path: PathBuf,
    pub remote_ssh_hosts_path: PathBuf,
    pub appsnap_captures_dir: PathBuf,
}

fn is_pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| text.contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

fn is_saint_home_locked_by_live_process(base_dir: &Path) -> bool {
    let sub_dir = if cfg!(debug_assertions) {
        "dev"
    } else {
        "userdata"
    };
    let owner_path = base_dir
        .join(sub_dir)
        .join("state.sqlite.lifecycle-lock")
        .join("owner.json");
    let Ok(raw) = std::fs::read_to_string(owner_path) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(pid) = parsed.get("pid").and_then(|v| v.as_u64()) else {
        return false;
    };
    let pid_u32 = pid as u32;
    pid_u32 != std::process::id() && is_pid_alive(pid_u32)
}

fn seed_dev_state_from_userdata(base_dir: &Path) {
    let src_userdata = base_dir.join("userdata");
    let dst_dev = base_dir.join("dev");
    let _ = std::fs::create_dir_all(&dst_dev);
    for file_name in ["settings.json", "keybindings.json"] {
        let src = src_userdata.join(file_name);
        let dst = dst_dev.join(file_name);
        if src.is_file() && !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

fn seed_isolated_dev_userdata(source_base: &Path, target_base: &Path) {
    let src_userdata = source_base.join("userdata");
    for sub in ["userdata", "dev"] {
        let dst_dir = target_base.join(sub);
        let _ = std::fs::create_dir_all(&dst_dir);
        for file_name in [
            "settings.json",
            "keybindings.json",
            "desktop-custom-title-bar.json",
            "agent-cursor-colors.json",
            "remote-ssh-hosts.json",
        ] {
            let src = src_userdata.join(file_name);
            let dst = dst_dir.join(file_name);
            if src.is_file() && !dst.exists() {
                let _ = std::fs::copy(&src, &dst);
            }
        }
    }
}

impl SaintPaths {
    /// Resolves `~/.saint` (or `SAINT_HOME` when set), preserving 100% compatibility
    /// with existing Electron user data, SQLite databases, and window state files.
    /// In debug builds only, if another Saint instance holds the SQLite lifecycle lock on
    /// `~/.saint`, isolates into `~/.saint-rust-dev` so side-by-side testing works cleanly.
    pub fn resolve() -> Self {
        let explicit_home = std::env::var("SAINT_HOME")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);

        let default_home = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(DEFAULT_HOME_DIR_NAME);

        let primary_dir = explicit_home.clone().unwrap_or_else(|| default_home.clone());

        if cfg!(debug_assertions) {
            seed_dev_state_from_userdata(&primary_dir);
        }

        // Dev-only: a release build must never silently move a user to another
        // home (and an empty database) because some process holds the lock.
        if cfg!(debug_assertions)
            && explicit_home.is_none()
            && is_saint_home_locked_by_live_process(&primary_dir)
        {
            let isolated_dir = dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".saint-rust-dev");
            seed_isolated_dev_userdata(&primary_dir, &isolated_dir);
            let mut paths = Self::from_base_dir(isolated_dir);
            paths.is_isolated_dev_instance = true;
            return paths;
        }

        Self::from_base_dir(primary_dir)
    }

    pub fn from_base_dir(base_dir: PathBuf) -> Self {
        let state_dir = base_dir.join("userdata");
        let log_dir = state_dir.join("logs");
        let window_state_path = state_dir.join("desktop-window-state.json");
        let custom_title_bar_path = state_dir.join("desktop-custom-title-bar.json");
        let agent_cursor_preference_path = state_dir.join("agent-cursor-colors.json");
        let storage_snapshot_path = state_dir.join("saint-storage-origin-v1.json");
        let remote_ssh_hosts_path = state_dir.join("remote-ssh-hosts.json");
        let appsnap_captures_dir = state_dir.join("appsnap-captures");

        Self {
            base_dir,
            is_isolated_dev_instance: false,
            state_dir,
            log_dir,
            window_state_path,
            custom_title_bar_path,
            agent_cursor_preference_path,
            storage_snapshot_path,
            remote_ssh_hosts_path,
            appsnap_captures_dir,
        }
    }

    pub fn ensure_directories(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.state_dir)?;
        std::fs::create_dir_all(&self.log_dir)?;
        std::fs::create_dir_all(&self.appsnap_captures_dir)?;
        Ok(())
    }

    pub fn log_file_path(&self) -> PathBuf {
        self.log_dir.join("desktop-main.log")
    }
}

pub struct DesktopSharedState {
    pub paths: SaintPaths,
    pub ws_url: RwLock<Option<String>>,
    pub auth_token: RwLock<Option<String>>,
    pub zoom_factor: RwLock<f64>,
    pub custom_title_bar_active: bool,
    pub agent_cursor_style: RwLock<Option<AgentCursorStylePreference>>,
    pub menu_accelerators: RwLock<DesktopMenuAccelerators>,
    pub active_context_menu: Mutex<Option<(String, oneshot::Sender<Option<String>>)>>,
    pub quit_allowed: AtomicBool,
    pub pending_quit_request_id: Mutex<Option<String>>,
    pub backend: Arc<BackendSupervisor>,
    pub pty_host: Arc<PtyHostManager>,
    pub browser: Arc<BrowserManager>,
    pub cua_host: Arc<CuaDriverHost>,
    pub appsnap: Arc<AppSnapHost>,
    pub remote_ssh: Arc<RemoteSshManager>,
    pub lan_relay: Arc<LanRelayManager>,
    pub updater: Arc<UpdaterCoordinator>,
}

impl DesktopSharedState {
    pub fn new(paths: SaintPaths, custom_title_bar_active: bool) -> Arc<Self> {
        let initial_cursor = crate::window_state::read_agent_cursor_preference(
            &paths.agent_cursor_preference_path,
        );
        let browser = Arc::new(BrowserManager::new());
        let cua_host = Arc::new(CuaDriverHost::new(paths.clone()));
        let appsnap = Arc::new(AppSnapHost::new(paths.clone()));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths.clone()));
        let pty_host = Arc::new(PtyHostManager::new());
        let updater = Arc::new(UpdaterCoordinator::new());
        let backend = Arc::new(BackendSupervisor::new(paths.clone()));
        let lan_relay = Arc::new(LanRelayManager::new(Arc::clone(&backend)));

        let initial_ws_url = std::env::var("SAINT_DESKTOP_WS_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| backend.current_ws_url());

        Arc::new(Self {
            paths,
            ws_url: RwLock::new(initial_ws_url),
            auth_token: RwLock::new(Some(backend.auth_token().to_string())),
            zoom_factor: RwLock::new(1.0),
            custom_title_bar_active,
            agent_cursor_style: RwLock::new(initial_cursor),
            menu_accelerators: RwLock::new(DesktopMenuAccelerators::default()),
            active_context_menu: Mutex::new(None),
            quit_allowed: AtomicBool::new(false),
            pending_quit_request_id: Mutex::new(None),
            backend,
            pty_host,
            browser,
            cua_host,
            appsnap,
            remote_ssh,
            lan_relay,
            updater,
        })
    }

    pub fn current_ws_url(&self) -> Option<String> {
        self.ws_url.read().ok().and_then(|g| g.clone())
    }

    pub fn set_ws_url(&self, next: Option<String>) {
        if let Ok(mut guard) = self.ws_url.write() {
            *guard = next;
        }
    }

    pub fn current_zoom_factor(&self) -> f64 {
        self.zoom_factor.read().map(|g| *g).unwrap_or(1.0)
    }

    pub fn set_zoom_factor(&self, factor: f64) -> f64 {
        let clamped = factor.clamp(0.5, 3.0);
        if let Ok(mut guard) = self.zoom_factor.write() {
            *guard = clamped;
        }
        clamped
    }
}

pub fn is_trusted_external_url(raw: &str) -> bool {
    match url::Url::parse(raw.trim()) {
        Ok(parsed) => matches!(parsed.scheme(), "http" | "https" | "mailto"),
        Err(_) => false,
    }
}

pub fn reveal_path_in_file_manager(target: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let parent = target.parent().unwrap_or(target);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
