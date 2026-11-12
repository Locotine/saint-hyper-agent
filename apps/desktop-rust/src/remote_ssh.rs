// FILE: remote_ssh.rs
// Purpose: Manages Remote SSH hosts, `~/.ssh/config` host discovery, the remote Saint server
//          install/start/stop (scripts in `remote_ssh_scripts.rs`) and SSH tunnels
//          (Option 3.3-A).
// Layer: Desktop Remote SSH subsystem.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::remote_ssh_scripts as scripts;
use crate::state::SaintPaths;

pub const DEFAULT_REMOTE_ROOT: &str = ".saint-remote";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshSavedHost {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshTestResult {
    pub host: String,
    pub reachable: bool,
    pub authenticated: bool,
    pub server_running: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshUpdateHostInput {
    #[serde(default)]
    pub previous_host: Option<String>,
    pub target: DesktopRemoteSshSavedHost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshHostState {
    pub host: String,
    pub host_key: Option<String>,
    pub epoch: u64,
    pub remote_root: String,
    pub phase: String,
    pub message: Option<String>,
    pub local_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshState {
    pub config_hosts: Vec<String>,
    pub saved_hosts: Vec<DesktopRemoteSshSavedHost>,
    pub hosts: Vec<DesktopRemoteSshHostState>,
    pub default_remote_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceDownloadItem {
    pub cwd: String,
    pub path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceDownloadInput {
    pub host: String,
    pub items: Vec<DesktopWorkspaceDownloadItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceSavedFile {
    pub file_name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceFailedFile {
    pub file_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWorkspaceDownloadResult {
    pub canceled: bool,
    pub saved: Vec<DesktopWorkspaceSavedFile>,
    pub failures: Vec<DesktopWorkspaceFailedFile>,
}

/// Where workspace downloads go: a file chosen in a Save dialog (already confirmed to replace),
/// or a folder where a taken name gets " (1)" instead of being replaced.
pub enum DownloadDestination {
    File(PathBuf),
    Directory(PathBuf),
}

#[derive(Debug, Serialize, Deserialize)]
struct PersistedSavedHostsEnvelope {
    version: u32,
    hosts: Vec<DesktopRemoteSshSavedHost>,
}

/// Non-interactive ssh: never prompt for a password or host key inside the app.
const SSH_BASE_OPTIONS: [&str; 8] = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
enum SshInput {
    Text(String),
    File(PathBuf),
}

struct SshRun {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// The remote server a host's tunnel forwards to, kept across reconnects.
struct Session {
    token: String,
    local_port: u16,
    remote_port: u16,
}

/// Waits between tries to bring a dropped tunnel back; the schedule ends in an error.
const RECONNECT_BACKOFF: [u64; 5] = [1, 2, 5, 15, 30];
/// How long a shared ssh connection outlives its last script run.
const CONTROL_PERSIST_SECONDS: u32 = 120;
/// sun_path is 104 bytes on macOS; `%C` expands to 40 hex digits.
const MAX_CONTROL_PATH_LENGTH: usize = 100;
const MIGRATE_TIMEOUT: Duration = Duration::from_secs(90);

pub struct RemoteSshManager {
    paths: SaintPaths,
    saved_hosts: Mutex<Vec<DesktopRemoteSshSavedHost>>,
    live_hosts: Mutex<Vec<DesktopRemoteSshHostState>>,
    tunnels: Mutex<HashMap<String, Child>>,
    sessions: Mutex<HashMap<String, Session>>,
    // ponytail: one connect at a time across hosts; per-host locks if parallel connects matter.
    connect_lock: Mutex<()>,
    client_id: String,
    /// This desktop's own folder from before the default was shared (`<store>/clients/<id>`),
    /// when it had connected before. A host where it still holds data keeps using it.
    legacy_root: Option<String>,
    /// The folder a host without its own uses, settled once per host.
    default_roots: Mutex<HashMap<String, String>>,
    reconnecting: Mutex<BTreeSet<String>>,
}

impl RemoteSshManager {
    pub fn new(paths: SaintPaths) -> Self {
        let initial_saved = Self::read_saved_hosts(&paths.remote_ssh_hosts_path);
        let (client_id, existed) =
            Self::ensure_client_id(&paths.state_dir.join("remote-ssh-client-id"));
        let legacy_root = existed.then(|| format!("{DEFAULT_REMOTE_ROOT}/clients/{client_id}"));
        Self {
            paths,
            saved_hosts: Mutex::new(initial_saved),
            live_hosts: Mutex::new(Vec::new()),
            tunnels: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            connect_lock: Mutex::new(()),
            client_id,
            legacy_root,
            default_roots: Mutex::new(HashMap::new()),
            reconnecting: Mutex::new(BTreeSet::new()),
        }
    }

    fn is_client_id(value: &str) -> bool {
        let Some((name, hex)) = value.rsplit_once('-') else {
            return false;
        };
        let first_ok = name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        first_ok
            && name.len() <= 41
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
            && hex.len() == 8
            && hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
    }

    /// This desktop's name on remote hosts (`<user>-<8 hex>`), shared with the Electron build's
    /// file so threads created there stay visible. One remote server partitions data by it.
    /// Returns the id and whether it was saved before this run.
    fn ensure_client_id(path: &Path) -> (String, bool) {
        if let Ok(saved) = std::fs::read_to_string(path) {
            if Self::is_client_id(saved.trim()) {
                return (saved.trim().to_string(), true);
            }
        }
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default()
            .to_lowercase();
        let mut name = String::new();
        for c in user.chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                name.push(c);
            } else if !name.ends_with('-') {
                name.push('-');
            }
        }
        let name: String = name
            .trim_start_matches(['-', '_'])
            .trim_end_matches('-')
            .chars()
            .take(32)
            .collect();
        let name = if name.is_empty() {
            "user".to_string()
        } else {
            name
        };
        let id = format!("{name}-{}", &Uuid::new_v4().simple().to_string()[..8]);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, &id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        (id, false)
    }

    pub fn is_valid_ssh_user(value: &str) -> bool {
        let trimmed = value.trim();
        !trimmed.is_empty()
            && trimmed.len() <= 64
            && !trimmed.starts_with('-')
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    }

    pub fn is_valid_ssh_target(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.len() > 253 || trimmed.starts_with('-') {
            return false;
        }
        let host_part = if let Some((user_part, rest_host)) = trimmed.split_once('@') {
            if !Self::is_valid_ssh_user(user_part) || rest_host.contains('@') {
                return false;
            }
            rest_host
        } else {
            trimmed
        };
        if host_part.is_empty() || host_part.starts_with('-') {
            return false;
        }
        if host_part.starts_with('[') && host_part.ends_with(']') {
            let inner = &host_part[1..host_part.len() - 1];
            return !inner.is_empty()
                && inner
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
        }
        let mut chars = host_part.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !(first.is_ascii_alphanumeric() || first == '_') {
            return false;
        }
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '%' | ':' | '-'))
    }

    pub fn normalize_remote_root(value: &str) -> Option<String> {
        let trimmed = value.trim().trim_start_matches("~/").trim_end_matches('/');
        if trimmed.is_empty() {
            return None;
        }
        if !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        {
            return None;
        }
        for segment in trimmed.split('/') {
            if segment.is_empty() || segment == "." || segment == ".." {
                return None;
            }
        }
        Some(trimmed.to_string())
    }

    pub fn remote_root_process_pattern(remote_root: &str) -> String {
        let mut chars = remote_root.chars();
        match chars.next() {
            Some(first) => format!("[{first}]{}", chars.as_str()),
            None => String::new(),
        }
    }

    fn generate_host_key() -> String {
        Uuid::new_v4().simple().to_string()[..8].to_string()
    }

    fn read_saved_hosts(path: &Path) -> Vec<DesktopRemoteSshSavedHost> {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        if let Ok(envelope) = serde_json::from_str::<PersistedSavedHostsEnvelope>(&raw) {
            return envelope.hosts;
        }
        serde_json::from_str::<Vec<DesktopRemoteSshSavedHost>>(&raw).unwrap_or_default()
    }

    fn persist_saved_hosts(&self, hosts: &[DesktopRemoteSshSavedHost]) {
        let envelope = PersistedSavedHostsEnvelope {
            version: 1,
            hosts: hosts.to_vec(),
        };
        if let Ok(serialized) = serde_json::to_string_pretty(&envelope) {
            let _ = std::fs::write(&self.paths.remote_ssh_hosts_path, format!("{serialized}\n"));
        }
    }

    pub fn parse_ssh_config_hosts(raw: &str) -> Vec<String> {
        let mut hosts = BTreeSet::new();
        for line in raw.lines() {
            let trimmed = line.split('#').next().unwrap_or("").trim();
            if trimmed.len() > 5 && trimmed[..5].eq_ignore_ascii_case("host ") {
                for alias in trimmed[5..].split_whitespace() {
                    if !alias.contains('*')
                        && !alias.contains('?')
                        && !alias.starts_with('!')
                        && Self::is_valid_ssh_target(alias)
                    {
                        hosts.insert(alias.to_string());
                    }
                }
            }
        }
        hosts.into_iter().collect()
    }

    fn discover_ssh_config_hosts() -> Vec<String> {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        let config_path = home.join(".ssh").join("config");
        std::fs::read_to_string(config_path)
            .ok()
            .map(|raw| Self::parse_ssh_config_hosts(&raw))
            .unwrap_or_default()
    }

    fn kill_and_reap(mut child: Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Drops exited tunnels; a connected host whose tunnel exited turns `reconnecting` and is
    /// returned so the monitor can bring it back.
    fn reconcile_tunnels(&self) -> Vec<String> {
        let mut dead_hosts = Vec::new();
        if let Ok(mut tunnels) = self.tunnels.lock() {
            tunnels.retain(|host, child| match child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    dead_hosts.push(host.clone());
                    false
                }
                Ok(None) => true,
            });
        }
        if !dead_hosts.is_empty() {
            if let Ok(mut live) = self.live_hosts.lock() {
                for entry in live.iter_mut() {
                    if dead_hosts.contains(&entry.host) && entry.phase == "connected" {
                        eprintln!("[remote-ssh] {} tunnel closed, reconnecting", entry.host);
                        entry.phase = "reconnecting".to_string();
                        entry.local_port = None;
                        entry.message = None;
                    }
                }
                dead_hosts.retain(|h| {
                    live.iter()
                        .any(|e| &e.host == h && e.phase == "reconnecting")
                });
            }
        }
        dead_hosts
    }

    pub fn get_state(&self) -> DesktopRemoteSshState {
        self.reconcile_tunnels();
        let saved = self
            .saved_hosts
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let hosts = self
            .live_hosts
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        DesktopRemoteSshState {
            config_hosts: Self::discover_ssh_config_hosts(),
            saved_hosts: saved,
            hosts,
            default_remote_root: DEFAULT_REMOTE_ROOT.to_string(),
        }
    }

    fn reserve_local_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .and_then(|l| l.local_addr())
            .map(|a| a.port())
            .unwrap_or(42890)
    }

    fn sanitize_optional_field(raw: Option<&str>) -> Option<String> {
        let trimmed = raw?.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('-')
            || trimmed.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
        {
            return None;
        }
        Some(trimmed.to_string())
    }

    fn sanitize_ssh_user(raw: Option<&str>) -> Option<String> {
        let trimmed = raw?.trim();
        if !Self::is_valid_ssh_user(trimmed) {
            return None;
        }
        Some(trimmed.to_string())
    }

    pub fn ssh_connection_option_args(entry: &DesktopRemoteSshSavedHost) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(port) = entry.port.filter(|p| *p > 0) {
            args.push("-p".to_string());
            args.push(port.to_string());
        }
        if let Some(user) = Self::sanitize_ssh_user(entry.user.as_deref()) {
            if !entry.host.contains('@') {
                args.push("-l".to_string());
                args.push(user);
            }
        }
        if let Some(identity_file) = Self::sanitize_optional_field(entry.identity_file.as_deref()) {
            args.push("-i".to_string());
            args.push(identity_file);
        }
        args
    }

    pub fn parse_test_host_output(
        host: &str,
        exit_success: bool,
        stdout: &str,
        stderr: &str,
    ) -> DesktopRemoteSshTestResult {
        if exit_success && stdout.contains("SAINT_SSH_OK") {
            let server_running = stdout.contains("SAINT_SERVER_RUNNING");
            let message = if server_running {
                "SSH reachable · authenticated · Saint server is running.".to_string()
            } else {
                "SSH reachable · authenticated · Saint server is stopped.".to_string()
            };
            return DesktopRemoteSshTestResult {
                host: host.to_string(),
                reachable: true,
                authenticated: true,
                server_running,
                message,
            };
        }
        let detail = stderr.trim();
        let lower = detail.to_ascii_lowercase();
        let auth_failure = lower.contains("permission denied")
            || lower.contains("publickey")
            || lower.contains("authentication failed");
        let message = if detail.is_empty() {
            format!("Could not reach {host} over SSH.")
        } else {
            detail.lines().last().unwrap_or(detail).to_string()
        };
        DesktopRemoteSshTestResult {
            host: host.to_string(),
            reachable: auth_failure,
            authenticated: false,
            server_running: false,
            message,
        }
    }

    fn upsert_saved_entry(
        &self,
        previous_host: Option<&str>,
        input: DesktopRemoteSshSavedHost,
        promote_to_front: bool,
    ) -> Result<DesktopRemoteSshSavedHost, String> {
        let host = input.host.trim().to_string();
        if !Self::is_valid_ssh_target(&host) {
            return Err("Enter an SSH host such as `devbox` or `user@example.com`.".to_string());
        }
        let normalized_root = match input.remote_root.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(Self::normalize_remote_root(raw).ok_or_else(|| {
                "The remote folder must be a relative path inside the home folder.".to_string()
            })?),
        };
        let prev = previous_host
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&host);

        let mut saved_guard = self.saved_hosts.lock().map_err(|e| e.to_string())?;
        let existing = saved_guard
            .iter()
            .find(|h| h.host == prev || h.host == host)
            .cloned();
        let existing_key = input
            .host_key
            .clone()
            .or_else(|| existing.as_ref().and_then(|h| h.host_key.clone()))
            .unwrap_or_else(Self::generate_host_key);

        let entry = DesktopRemoteSshSavedHost {
            host: host.clone(),
            remote_root: normalized_root,
            host_key: Some(existing_key),
            auto_connect: if promote_to_front {
                None
            } else {
                input
                    .auto_connect
                    .or_else(|| existing.as_ref().and_then(|h| h.auto_connect))
            },
            label: Self::sanitize_optional_field(input.label.as_deref())
                .or_else(|| existing.as_ref().and_then(|h| h.label.clone())),
            user: Self::sanitize_ssh_user(input.user.as_deref())
                .or_else(|| existing.as_ref().and_then(|h| h.user.clone())),
            port: input
                .port
                .filter(|p| *p > 0)
                .or_else(|| existing.as_ref().and_then(|h| h.port)),
            identity_file: Self::sanitize_optional_field(input.identity_file.as_deref())
                .or_else(|| existing.as_ref().and_then(|h| h.identity_file.clone())),
        };

        if promote_to_front {
            saved_guard.retain(|h| h.host != prev && h.host != host);
            saved_guard.insert(0, entry.clone());
        } else if let Some(pos) = saved_guard
            .iter()
            .position(|h| h.host == prev || h.host == host)
        {
            saved_guard[pos] = entry.clone();
            let mut idx = 0;
            saved_guard.retain(|h| {
                let keep = idx == pos || (h.host != prev && h.host != host);
                idx += 1;
                keep
            });
        } else {
            saved_guard.insert(0, entry.clone());
        }
        self.persist_saved_hosts(&saved_guard);
        Ok(entry)
    }

    pub fn update_host(
        &self,
        input: DesktopRemoteSshUpdateHostInput,
    ) -> Result<DesktopRemoteSshState, String> {
        let host = input.target.host.trim().to_string();
        if !Self::is_valid_ssh_target(&host) {
            return Err("Enter an SSH host such as `devbox` or `user@example.com`.".to_string());
        }
        let normalized_root = match input.target.remote_root.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(Self::normalize_remote_root(raw).ok_or_else(|| {
                "The remote folder must be a relative path inside the home folder.".to_string()
            })?),
        };
        let prev = input
            .previous_host
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&host);

        {
            let mut saved_guard = self.saved_hosts.lock().map_err(|e| e.to_string())?;
            let existing = saved_guard
                .iter()
                .find(|h| h.host == prev || h.host == host)
                .cloned();
            let host_key = input
                .target
                .host_key
                .clone()
                .or_else(|| existing.as_ref().and_then(|h| h.host_key.clone()))
                .unwrap_or_else(Self::generate_host_key);

            let entry = DesktopRemoteSshSavedHost {
                host: host.clone(),
                remote_root: normalized_root.clone(),
                host_key: Some(host_key),
                auto_connect: input
                    .target
                    .auto_connect
                    .or_else(|| existing.as_ref().and_then(|h| h.auto_connect)),
                label: Self::sanitize_optional_field(input.target.label.as_deref()),
                user: Self::sanitize_ssh_user(input.target.user.as_deref()),
                port: input.target.port.filter(|p| *p > 0),
                identity_file: Self::sanitize_optional_field(input.target.identity_file.as_deref()),
            };

            if let Some(pos) = saved_guard
                .iter()
                .position(|h| h.host == prev || h.host == host)
            {
                saved_guard[pos] = entry;
                let mut idx = 0;
                saved_guard.retain(|h| {
                    let keep = idx == pos || (h.host != prev && h.host != host);
                    idx += 1;
                    keep
                });
            } else {
                saved_guard.insert(0, entry);
            }
            self.persist_saved_hosts(&saved_guard);
        }

        if prev != host {
            let replaced = self.tunnels.lock().ok().and_then(|mut tunnels| {
                let child = tunnels.remove(prev)?;
                tunnels.insert(host.clone(), child)
            });
            if let Some(existing) = replaced {
                Self::kill_and_reap(existing);
            }
            if let Ok(mut live_guard) = self.live_hosts.lock() {
                if let Some(live) = live_guard.iter_mut().find(|h| h.host == prev) {
                    live.host = host.clone();
                    if let Some(root) = normalized_root {
                        live.remote_root = root;
                    }
                }
            }
        }

        Ok(self.get_state())
    }

    pub fn test_host(
        &self,
        input: DesktopRemoteSshSavedHost,
    ) -> Result<DesktopRemoteSshTestResult, String> {
        let host = input.host.trim().to_string();
        if !Self::is_valid_ssh_target(&host) {
            return Err("Enter an SSH host such as `devbox` or `user@example.com`.".to_string());
        }
        let remote_root = input
            .remote_root
            .as_deref()
            .and_then(Self::normalize_remote_root)
            .unwrap_or_else(|| DEFAULT_REMOTE_ROOT.to_string());
        let saved_entry = self
            .saved_hosts
            .lock()
            .ok()
            .and_then(|g| g.iter().find(|h| h.host == host).cloned());
        let merged = DesktopRemoteSshSavedHost {
            host: host.clone(),
            remote_root: Some(remote_root.clone()),
            host_key: input.host_key,
            auto_connect: input.auto_connect,
            label: input.label,
            user: input
                .user
                .or_else(|| saved_entry.as_ref().and_then(|s| s.user.clone())),
            port: input
                .port
                .or_else(|| saved_entry.as_ref().and_then(|s| s.port)),
            identity_file: input
                .identity_file
                .or_else(|| saved_entry.as_ref().and_then(|s| s.identity_file.clone())),
        };
        let extra_args = Self::ssh_connection_option_args(&merged);
        let pattern = Self::remote_root_process_pattern(&remote_root);

        let probe_cmd = format!(
            "printf 'SAINT_SSH_OK\\n'; if pgrep -f '{pattern}' >/dev/null 2>&1; then printf 'SAINT_SERVER_RUNNING\\n'; else printf 'SAINT_SERVER_STOPPED\\n'; fi"
        );
        let mut ssh_cmd = Command::new("ssh");
        ssh_cmd.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ClearAllForwardings=yes",
        ]);
        ssh_cmd.args(&extra_args);
        ssh_cmd.arg("--").arg(&host).arg(&probe_cmd);
        ssh_cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            ssh_cmd.creation_flags(0x0800_0000);
        }

        match ssh_cmd.output() {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                Ok(Self::parse_test_host_output(
                    &host,
                    output.status.success(),
                    &stdout,
                    &stderr,
                ))
            }
            Err(err) => Ok(DesktopRemoteSshTestResult {
                host,
                reachable: false,
                authenticated: false,
                server_running: false,
                message: format!("Failed to invoke ssh: {err}"),
            }),
        }
    }

    /// Installs this build's server on the host when needed, starts it (or reuses the one
    /// running), then forwards a local loopback port to it. Connects run one at a time, so a
    /// second caller waits and then finds the host connected.
    pub fn connect(
        &self,
        input: DesktopRemoteSshSavedHost,
    ) -> Result<DesktopRemoteSshHostState, String> {
        let _serial = self.connect_lock.lock().map_err(|e| e.to_string())?;
        let entry = self.upsert_saved_entry(None, input, true)?;
        let host = entry.host.clone();
        let host_key = entry
            .host_key
            .clone()
            .unwrap_or_else(Self::generate_host_key);
        let remote_root = match entry.remote_root.clone() {
            Some(root) => root,
            None => match self.resolve_default_root(&entry) {
                Ok(root) => root,
                Err(message) => {
                    let root = DEFAULT_REMOTE_ROOT;
                    return Ok(self.set_phase(&host, &host_key, root, "error", Some(message)));
                }
            },
        };

        // The tunnel outlives a server that exited after idling; reconnect when it no longer answers.
        self.reconcile_tunnels();
        let live_port = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.get(&host).map(|s| s.local_port));
        let connected = self.live_hosts.lock().ok().is_some_and(|live| {
            live.iter()
                .any(|h| h.host == host && h.phase == "connected" && h.remote_root == remote_root)
        });
        if connected && live_port.is_some_and(|p| Self::answers_health(p, Duration::from_secs(5))) {
            if let Some(state) = self.host_state(&host) {
                return Ok(state);
            }
        }

        match self.run_connect(&entry, &remote_root, &host_key, false) {
            Ok(state) => Ok(state),
            Err(message) => {
                if let Some(child) = self.tunnels.lock().ok().and_then(|mut t| t.remove(&host)) {
                    Self::kill_and_reap(child);
                }
                eprintln!("[remote-ssh] {host} failed: {message}");
                Ok(self.set_phase(&host, &host_key, &remote_root, "error", Some(message)))
            }
        }
    }

    fn run_connect(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        remote_root: &str,
        host_key: &str,
        // A background reconnect keeps its `reconnecting` phase instead of flashing the steps.
        quiet: bool,
    ) -> Result<DesktopRemoteSshHostState, String> {
        let host = entry.host.as_str();
        let identity = self.install_identity()?;
        let target = scripts::Target {
            remote_root,
            store_root: DEFAULT_REMOTE_ROOT,
            identity: &identity,
        };
        let started_at = Instant::now();
        let step = |phase: &str| {
            eprintln!(
                "[remote-ssh] {host} {phase} +{}ms",
                started_at.elapsed().as_millis()
            );
            if !quiet {
                self.set_phase(host, host_key, remote_root, phase, None);
            }
        };
        if let Some(child) = self.tunnels.lock().ok().and_then(|mut t| t.remove(host)) {
            Self::kill_and_reap(child);
        }

        step("checking");
        self.ensure_control_master(entry);
        let probe_run = self.run_script(entry, &scripts::probe_script(&target)?, PROBE_TIMEOUT)?;
        let probe = scripts::parse_probe(&probe_run.stdout)
            .ok_or_else(|| Self::failure_message("reach the host", &probe_run))?;
        if !scripts::is_node_supported(probe.node_version.as_deref()) {
            return Err(format!(
                "{} is required on {host} {}",
                scripts::NODE_REQUIREMENT,
                probe
                    .node_version
                    .as_deref()
                    .map_or("(node was not found).".to_string(), |v| format!(
                        "(found {v})."
                    )),
            ));
        }
        if let Some(server) = probe
            .server
            .as_ref()
            .filter(|s| scripts::compare_install_versions(&s.version, &identity.version) > 0)
        {
            // Never downgrade a server another desktop of this account runs: both would keep
            // restarting each other's version.
            return Err(format!(
                "{host} already runs Saint {}, newer than this computer's {}. Update Saint on this computer to connect.",
                server.version, identity.version
            ));
        }

        let (remote_port, token) = match probe
            .server
            .clone()
            .filter(|s| s.version == identity.version)
        {
            Some(server) => (server.port, server.token),
            None => {
                if !probe.installed {
                    if !probe.tar {
                        return Err(format!("tar is required on {host} to install Saint."));
                    }
                    let dir = self.install_dir()?;
                    step("uploading");
                    let upload = self.run_ssh(
                        entry,
                        &scripts::upload_command(&target),
                        SshInput::File(dir.join("bundle.tar.gz")),
                        UPLOAD_TIMEOUT,
                    )?;
                    if upload.code != Some(0) {
                        return Err(Self::failure_message("upload the server", &upload));
                    }
                    if !probe.deps_installed {
                        let deps = self.run_ssh(
                            entry,
                            &scripts::deps_upload_command(&target),
                            SshInput::File(dir.join("deps.tar.gz")),
                            UPLOAD_TIMEOUT,
                        )?;
                        if deps.code != Some(0) {
                            return Err(Self::failure_message("upload the dependencies", &deps));
                        }
                    }
                    step("installing");
                    let install = self.run_script(
                        entry,
                        &scripts::install_script(&target)?,
                        INSTALL_TIMEOUT,
                    )?;
                    if !scripts::has_report(&install.stdout, "installed") {
                        return Err(Self::failure_message("install the server", &install));
                    }
                }
                self.install_scanners(entry, &target, &probe);
                step("starting");
                let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let dev_url = cfg!(debug_assertions).then_some("http://localhost:5733");
                let start = self.run_script(
                    entry,
                    &scripts::start_script(&target, &token, dev_url)?,
                    START_TIMEOUT,
                )?;
                let port = scripts::parse_started_port(&start.stdout)
                    .ok_or_else(|| Self::failure_message("start the server", &start))?;
                (port, token)
            }
        };

        step("tunneling");
        // Keep the local port across reconnects so open windows reconnect to the same URL.
        let mut local_port = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.get(host).map(|s| s.local_port))
            .unwrap_or_else(Self::reserve_local_port);
        let child = match self.open_tunnel(entry, local_port, remote_port) {
            Ok(child) => child,
            Err(_) => {
                // The kept port may be taken now; windows re-read the URL on reconnect.
                local_port = Self::reserve_local_port();
                self.open_tunnel(entry, local_port, remote_port)?
            }
        };
        if let Some(prev) = self
            .tunnels
            .lock()
            .ok()
            .and_then(|mut t| t.insert(host.to_string(), child))
        {
            Self::kill_and_reap(prev);
        }
        let token_changed = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            let changed = sessions.get(host).map_or(true, |s| s.token != token);
            sessions.insert(
                host.to_string(),
                Session {
                    token,
                    local_port,
                    remote_port,
                },
            );
            changed
        };
        let mut state = self.set_phase(host, host_key, remote_root, "connected", None);
        if token_changed {
            // A client builds a new transport per epoch; the token is part of its URL.
            if let Ok(mut live) = self.live_hosts.lock() {
                if let Some(h) = live.iter_mut().find(|h| h.host == host) {
                    h.epoch += 1;
                    state = h.clone();
                }
            }
        }
        Ok(state)
    }

    fn host_state(&self, host: &str) -> Option<DesktopRemoteSshHostState> {
        self.live_hosts
            .lock()
            .ok()?
            .iter()
            .find(|h| h.host == host)
            .cloned()
    }

    fn set_phase(
        &self,
        host: &str,
        host_key: &str,
        remote_root: &str,
        phase: &str,
        message: Option<String>,
    ) -> DesktopRemoteSshHostState {
        let local_port = if phase == "connected" {
            self.sessions
                .lock()
                .ok()
                .and_then(|s| s.get(host).map(|s| s.local_port))
        } else {
            None
        };
        let Ok(mut live) = self.live_hosts.lock() else {
            return DesktopRemoteSshHostState {
                host: host.to_string(),
                host_key: Some(host_key.to_string()),
                epoch: 0,
                remote_root: remote_root.to_string(),
                phase: phase.to_string(),
                message,
                local_port,
            };
        };
        let idx = match live.iter().position(|h| h.host == host) {
            Some(i) => i,
            None => {
                live.push(DesktopRemoteSshHostState {
                    host: host.to_string(),
                    host_key: None,
                    epoch: 0,
                    remote_root: String::new(),
                    phase: String::new(),
                    message: None,
                    local_port: None,
                });
                live.len() - 1
            }
        };
        let h = &mut live[idx];
        h.host_key = Some(host_key.to_string());
        h.remote_root = remote_root.to_string();
        h.phase = phase.to_string();
        h.message = message;
        h.local_port = local_port;
        h.clone()
    }

    /// Files `scripts/stage-remote-install.ts` staged: the bundle, the dependency pack and
    /// `identity.json`. Packaged apps carry them as the `remote-install` resource.
    fn install_dir(&self) -> Result<PathBuf, String> {
        let mut candidates: Vec<PathBuf> = std::env::var_os("SAINT_REMOTE_INSTALL_DIR")
            .map(PathBuf::from)
            .into_iter()
            .collect();
        if let Some(exe_dir) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
        {
            candidates.extend([
                exe_dir.join("remote-install"),
                exe_dir.join("resources").join("remote-install"),
                exe_dir.join("..").join("Resources").join("remote-install"),
                exe_dir
                    .join("..")
                    .join("lib")
                    .join("Saint")
                    .join("remote-install"),
            ]);
        }
        if cfg!(debug_assertions) {
            candidates
                .push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/remote-install"));
        }
        candidates
            .into_iter()
            .find(|dir| dir.join("identity.json").is_file())
            .ok_or_else(|| {
                "This Saint build ships no remote server bundle. Run `bun run --cwd apps/desktop-rust build:remote-install`.".to_string()
            })
    }

    fn install_identity(&self) -> Result<scripts::InstallIdentity, String> {
        let path = self.install_dir()?.join("identity.json");
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn failure_message(action: &str, run: &SshRun) -> String {
        let detail = Self::tail(if run.stderr.trim().is_empty() {
            &run.stdout
        } else {
            &run.stderr
        });
        let code = run.code.map_or("signal".to_string(), |c| c.to_string());
        if detail.is_empty() {
            format!("Could not {action} (ssh exit {code}).")
        } else {
            format!("Could not {action} (ssh exit {code}): {detail}")
        }
    }

    fn tail(text: &str) -> String {
        let trimmed = text.trim();
        let chars: Vec<char> = trimmed.chars().collect();
        if chars.len() > 2000 {
            format!(
                "…{}",
                chars[chars.len() - 2000..].iter().collect::<String>()
            )
        } else {
            trimmed.to_string()
        }
    }

    fn ssh_command(entry: &DesktopRemoteSshSavedHost) -> Command {
        let mut cmd = Command::new("ssh");
        cmd.args(SSH_BASE_OPTIONS);
        cmd.args(Self::ssh_connection_option_args(entry));
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd
    }

    fn run_script(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        script: &str,
        timeout: Duration,
    ) -> Result<SshRun, String> {
        self.run_ssh(
            entry,
            scripts::LOGIN_SHELL_COMMAND,
            SshInput::Text(script.to_string()),
            timeout,
        )
    }

    /// Runs one remote command with `input` on its stdin and collects its output. When ssh
    /// refused a key this host's config names as too open, tightens it and runs once more.
    fn run_ssh(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        remote_command: &str,
        input: SshInput,
        timeout: Duration,
    ) -> Result<SshRun, String> {
        let run = self.run_ssh_once(entry, remote_command, &input, timeout)?;
        if Self::fix_key_permissions(entry, &run.stderr) {
            return self.run_ssh_once(entry, remote_command, &input, timeout);
        }
        Ok(run)
    }

    /// ssh refuses a private key others can read ("bad permissions") and then fails every
    /// connect. Only a key this host's own ssh config names is touched: stderr can carry a
    /// server banner, which must not choose the file.
    fn fix_key_permissions(entry: &DesktopRemoteSshSavedHost, stderr: &str) -> bool {
        let Some(key) = stderr
            .split("Load key \"")
            .nth(1)
            .and_then(|rest| rest.split_once("\": bad permissions"))
            .map(|(path, _)| path.to_string())
        else {
            return false;
        };
        let home = dirs::home_dir().unwrap_or_default();
        let resolve = |p: &str| {
            let p = match p.strip_prefix("~/") {
                Some(rest) => home.join(rest),
                None => PathBuf::from(p),
            };
            std::fs::canonicalize(&p).unwrap_or(p)
        };
        let Ok(output) = Self::ssh_command(entry)
            .args(["-G", "--", &entry.host])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            return false;
        };
        let target = resolve(&key);
        let configured = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.trim().strip_prefix("identityfile "))
            .any(|file| resolve(file) == target);
        if !configured {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)) {
                eprintln!("[remote-ssh] could not fix permissions of {key}: {e}");
                return false;
            }
            eprintln!("[remote-ssh] set {key} to owner-only (ssh refused it as too open)");
            true
        }
        #[cfg(not(unix))]
        false
    }

    /// `ControlPath` for shared connections, or None where sharing is off (Windows OpenSSH
    /// has no ControlMaster) or the socket path would be too long.
    fn control_path(&self) -> Option<String> {
        if cfg!(windows) {
            return None;
        }
        let dir = self.paths.state_dir.join("ssh");
        std::fs::create_dir_all(&dir).ok()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let path = format!("{}/%C", dir.to_str()?.trim_end_matches('/'));
        (path.len() - 2 + 40 <= MAX_CONTROL_PATH_LENGTH).then_some(path)
    }

    /// Starts a background master connection the scripts of one connect share (`-f` returns
    /// once authenticated); it exits CONTROL_PERSIST_SECONDS after its last script. A failure
    /// only means each script connects on its own.
    fn ensure_control_master(&self, entry: &DesktopRemoteSshSavedHost) {
        let Some(path) = self.control_path() else {
            return;
        };
        let path_option = format!("ControlPath={path}");
        let detached = |args: &[&str]| -> Option<i32> {
            let mut cmd = Command::new("ssh");
            cmd.args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = cmd.spawn().ok()?;
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(100))
                    }
                    _ => {
                        Self::kill_and_reap(child);
                        return None;
                    }
                }
            }
        };
        let conn = Self::ssh_connection_option_args(entry);
        let conn: Vec<&str> = conn.iter().map(String::as_str).collect();
        let mut check = vec!["-o", &path_option];
        check.extend(&conn);
        check.extend(["-O", "check", "--", &entry.host]);
        if detached(&check) == Some(0) {
            return;
        }
        let persist = format!("ControlPersist={CONTROL_PERSIST_SECONDS}");
        let mut master: Vec<&str> = SSH_BASE_OPTIONS.to_vec();
        master.extend(&conn);
        master.extend([
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            &path_option,
            "-o",
            "ControlMaster=yes",
            "-o",
            &persist,
            "-N",
            "-f",
            "--",
            &entry.host,
        ]);
        let code = detached(&master);
        if code != Some(0) {
            eprintln!(
                "[remote-ssh] no shared connection to {} (exit {code:?})",
                entry.host
            );
        }
    }

    fn run_ssh_once(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        remote_command: &str,
        input: &SshInput,
        timeout: Duration,
    ) -> Result<SshRun, String> {
        let mut cmd = Self::ssh_command(entry);
        // ControlMaster=no uses a live shared connection and connects alone otherwise.
        if let Some(path) = self.control_path() {
            cmd.args([
                "-o".to_string(),
                "ControlMaster=no".to_string(),
                "-o".to_string(),
                format!("ControlPath={path}"),
            ]);
        }
        cmd.args([
            "-o",
            "ClearAllForwardings=yes",
            "--",
            &entry.host,
            remote_command,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The ssh command was not found on this computer.".to_string()
            } else {
                format!("Failed to start ssh: {e}")
            }
        })?;
        let mut stdin = child.stdin.take();
        // A remote that exits early closes stdin; its exit code and stderr report why.
        let input = input.clone();
        let writer = std::thread::spawn(move || {
            let Some(pipe) = stdin.as_mut() else { return };
            let _ = match input {
                SshInput::Text(text) => std::io::Write::write_all(pipe, text.as_bytes()),
                SshInput::File(path) => std::fs::File::open(path)
                    .and_then(|mut file| std::io::copy(&mut file, pipe).map(|_| ())),
            };
        });
        let read = |pipe: Option<Box<dyn std::io::Read + Send>>| {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut p) = pipe {
                    let _ = p.read_to_end(&mut buf);
                }
                String::from_utf8_lossy(&buf).into_owned()
            })
        };
        let stdout = read(
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        );
        let stderr = read(
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        );
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                _ => {
                    // Killing ssh ends the remote shell's stdin; the next install clears what it left.
                    Self::kill_and_reap(child);
                    break None;
                }
            }
        };
        let _ = writer.join();
        let run = SshRun {
            code: status.and_then(|s| s.code()),
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        };
        if status.is_none() {
            return Err(format!(
                "ssh to {} timed out.\n{}",
                entry.host,
                Self::tail(&run.stderr)
            ));
        }
        Ok(run)
    }

    /// Spawns `ssh -N -L` and waits until the remote server answers /health through it.
    /// No ExitOnForwardFailure: a taken port from the user's own ssh config forwards would
    /// kill the tunnel; our own forward is proven by the /health wait.
    fn open_tunnel(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        local_port: u16,
        remote_port: u16,
    ) -> Result<Child, String> {
        let mut cmd = Self::ssh_command(entry);
        cmd.args([
            "-N",
            "-L",
            &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
            "--",
            &entry.host,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|err| format!("Failed to start SSH tunnel: {err}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                let mut stderr = String::new();
                if let Some(mut pipe) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
                }
                let code = status
                    .code()
                    .map_or("signal".to_string(), |c| c.to_string());
                return Err(format!(
                    "SSH tunnel to {} exited (code {code}): {}",
                    entry.host,
                    Self::tail(&stderr)
                ));
            }
            if Self::answers_health(local_port, Duration::from_secs(2)) {
                // Drain stderr so a chatty ssh never blocks on a full pipe.
                if let Some(mut pipe) = child.stderr.take() {
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                    });
                }
                return Ok(child);
            }
            if Instant::now() >= deadline {
                Self::kill_and_reap(child);
                return Err(format!(
                    "The SSH tunnel to {} did not reach the remote server.",
                    entry.host
                ));
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// `GET /health` on a loopback port, without any proxy.
    fn answers_health(port: u16, timeout: Duration) -> bool {
        use std::io::{Read, Write};
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, timeout) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        if stream
            .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .is_err()
        {
            return false;
        }
        let mut head = [0u8; 16];
        let mut read = 0;
        while read < head.len() {
            match stream.read(&mut head[read..]) {
                Ok(0) | Err(_) => break,
                Ok(n) => read += n,
            }
        }
        let line = String::from_utf8_lossy(&head[..read]);
        line.starts_with("HTTP/1.") && line.get(9..10) == Some("2")
    }

    pub fn disconnect(&self, host: &str) -> Result<(), String> {
        let trimmed = host.trim();
        if !Self::is_valid_ssh_target(trimmed) {
            return Err("Unknown SSH host.".to_string());
        }
        let removed_child = self
            .tunnels
            .lock()
            .ok()
            .and_then(|mut tunnels| tunnels.remove(trimmed));
        if let Some(child) = removed_child {
            Self::kill_and_reap(child);
        }
        if let Ok(mut saved) = self.saved_hosts.lock() {
            for entry in saved.iter_mut() {
                if entry.host == trimmed {
                    entry.auto_connect = Some(false);
                }
            }
            self.persist_saved_hosts(&saved);
        }
        if let Ok(mut live) = self.live_hosts.lock() {
            if let Some(entry) = live.iter_mut().find(|h| h.host == trimmed) {
                entry.phase = "idle".to_string();
                entry.local_port = None;
                entry.message = None;
            }
        }
        Ok(())
    }

    pub fn stop_server(&self, input: DesktopRemoteSshSavedHost) -> Result<(), String> {
        let host = input.host.trim().to_string();
        self.disconnect(&host)?;
        let saved_entry = self
            .saved_hosts
            .lock()
            .ok()
            .and_then(|g| g.iter().find(|h| h.host == host).cloned());
        let mut merged = DesktopRemoteSshSavedHost {
            host: host.clone(),
            remote_root: None,
            host_key: input.host_key,
            auto_connect: input.auto_connect,
            label: input.label,
            user: input
                .user
                .or_else(|| saved_entry.as_ref().and_then(|s| s.user.clone())),
            port: input
                .port
                .or_else(|| saved_entry.as_ref().and_then(|s| s.port)),
            identity_file: input
                .identity_file
                .or_else(|| saved_entry.as_ref().and_then(|s| s.identity_file.clone())),
        };
        let remote_root = match input.remote_root.as_deref().filter(|r| !r.is_empty()) {
            Some(raw) => Self::normalize_remote_root(raw).ok_or_else(|| {
                "The remote folder must be a relative path inside the home folder.".to_string()
            })?,
            None => self.resolve_default_root(&merged)?,
        };
        merged.remote_root = Some(remote_root.clone());
        let host_key = merged.host_key.clone().unwrap_or_default();
        self.set_phase(&host, &host_key, &remote_root, "stopping", None);
        let result = self.run_stop(&merged, &remote_root);
        match &result {
            Ok(()) => self.set_phase(&host, &host_key, &remote_root, "idle", None),
            Err(message) => self.set_phase(
                &host,
                &host_key,
                &remote_root,
                "error",
                Some(message.clone()),
            ),
        };
        result
    }

    fn run_stop(
        &self,
        merged: &DesktopRemoteSshSavedHost,
        remote_root: &str,
    ) -> Result<(), String> {
        let host = merged.host.clone();
        let identity = self.install_identity()?;
        let target = scripts::Target {
            remote_root,
            store_root: DEFAULT_REMOTE_ROOT,
            identity: &identity,
        };
        let run = self.run_script(merged, &scripts::stop_script(&target)?, STOP_TIMEOUT)?;
        if !scripts::has_report(&run.stdout, "stopped") {
            return Err(Self::failure_message("stop the remote server", &run));
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&host);
        }
        Ok(())
    }

    /// The folder a host without its own uses: the account-wide default, shared by every
    /// desktop of the remote account. This desktop's older `clients/<id>` folder is moved into
    /// it by the first connect; where that cannot be done it keeps being used. Settled once.
    fn resolve_default_root(&self, entry: &DesktopRemoteSshSavedHost) -> Result<String, String> {
        if let Some(root) = self
            .default_roots
            .lock()
            .ok()
            .and_then(|r| r.get(&entry.host).cloned())
        {
            return Ok(root);
        }
        let mut root = DEFAULT_REMOTE_ROOT.to_string();
        if let Some(legacy) = self.legacy_root.as_deref() {
            let identity = self.install_identity()?;
            let target = scripts::Target {
                remote_root: legacy,
                store_root: DEFAULT_REMOTE_ROOT,
                identity: &identity,
            };
            self.ensure_control_master(entry);
            let run = self.run_script(
                entry,
                &scripts::migrate_root_script(&target)?,
                MIGRATE_TIMEOUT,
            )?;
            if run.code != Some(0) {
                return Err(Self::failure_message("reach the host", &run));
            }
            if scripts::has_report(&run.stdout, "migrated") {
                eprintln!(
                    "[remote-ssh] {} moved {legacy}/home into {root}/home",
                    entry.host
                );
            } else if scripts::has_report(&run.stdout, "legacy") {
                root = legacy.to_string();
            }
        }
        if let Ok(mut roots) = self.default_roots.lock() {
            roots.insert(entry.host.clone(), root.clone());
        }
        Ok(root)
    }

    /// Uploads this host's scanner pack when it lacks this pack version. The scanners are
    /// optional: a failure is logged and the server still starts without them.
    fn install_scanners(
        &self,
        entry: &DesktopRemoteSshSavedHost,
        target: &scripts::Target,
        probe: &scripts::ProbeReport,
    ) {
        if target.identity.scanners_version.is_none() || probe.scanners_installed {
            return;
        }
        let Some(platform) = probe.platform.as_deref() else {
            return;
        };
        let Ok(dir) = self.install_dir() else { return };
        let pack = dir.join(format!("scanner-{platform}.tar.gz"));
        if !pack.is_file() {
            return;
        }
        let result = (|| {
            eprintln!(
                "[remote-ssh] {} uploading the scanner pack ({platform})",
                entry.host
            );
            let upload = self.run_ssh(
                entry,
                &scripts::scanner_upload_command(target, platform)?,
                SshInput::File(pack.clone()),
                UPLOAD_TIMEOUT,
            )?;
            if upload.code != Some(0) {
                return Err(Self::failure_message("upload", &upload));
            }
            let install = self.run_script(
                entry,
                &scripts::scanner_install_script(target, platform)?,
                INSTALL_TIMEOUT,
            )?;
            if !scripts::has_report(&install.stdout, "scanners") {
                return Err(Self::failure_message("install", &install));
            }
            Ok(())
        })();
        if let Err(message) = result {
            eprintln!(
                "[remote-ssh] {} scanner pack skipped: {message}",
                entry.host
            );
        }
    }

    /// Watches tunnels and brings a dropped one back in the background.
    pub fn start_monitor(self: &std::sync::Arc<Self>) {
        let weak = std::sync::Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let Some(manager) = weak.upgrade() else {
                return;
            };
            for host in manager.reconcile_tunnels() {
                let worker = std::sync::Arc::clone(&manager);
                std::thread::spawn(move || worker.run_reconnect(&host));
            }
        });
    }

    fn still_reconnecting(&self, host: &str) -> bool {
        self.host_state(host)
            .is_some_and(|h| h.phase == "reconnecting")
    }

    /// First try re-opens the tunnel to the same remote port and token, keeping the client URL
    /// and epoch. Later tries run a full connect, which reuses a live server or restarts one.
    /// A disconnect (phase leaves `reconnecting`) ends the loop.
    fn run_reconnect(&self, host: &str) {
        let Ok(mut active) = self.reconnecting.lock() else {
            return;
        };
        if !active.insert(host.to_string()) {
            return;
        }
        drop(active);
        let mut last = String::new();
        let mut done = false;
        for (attempt, delay) in RECONNECT_BACKOFF.iter().enumerate() {
            let wake = Instant::now() + Duration::from_secs(*delay);
            while Instant::now() < wake && self.still_reconnecting(host) {
                std::thread::sleep(Duration::from_millis(200));
            }
            let Ok(_serial) = self.connect_lock.lock() else {
                break;
            };
            let (Some(state), Some(entry)) = (
                self.host_state(host).filter(|h| h.phase == "reconnecting"),
                self.saved_hosts
                    .lock()
                    .ok()
                    .and_then(|s| s.iter().find(|h| h.host == host).cloned()),
            ) else {
                done = true;
                break;
            };
            let host_key = state.host_key.clone().unwrap_or_default();
            let session = self
                .sessions
                .lock()
                .ok()
                .and_then(|s| s.get(host).map(|s| (s.local_port, s.remote_port)));
            let result = match session {
                Some((local, remote)) if attempt == 0 => {
                    self.open_tunnel(&entry, local, remote).map(|child| {
                        if let Some(prev) = self
                            .tunnels
                            .lock()
                            .ok()
                            .and_then(|mut t| t.insert(host.to_string(), child))
                        {
                            Self::kill_and_reap(prev);
                        }
                        self.set_phase(host, &host_key, &state.remote_root, "connected", None)
                    })
                }
                _ => self.run_connect(&entry, &state.remote_root, &host_key, true),
            };
            match result {
                Ok(_) => {
                    done = true;
                    break;
                }
                Err(message) => {
                    eprintln!(
                        "[remote-ssh] {host} reconnect {} failed: {message}",
                        attempt + 1
                    );
                    last = message;
                }
            }
        }
        if !done {
            if let Some(state) = self.host_state(host).filter(|h| h.phase == "reconnecting") {
                self.set_phase(
                    host,
                    &state.host_key.unwrap_or_default(),
                    &state.remote_root,
                    "error",
                    Some(format!("Lost the SSH tunnel to {host}: {last}")),
                );
            }
        }
        if let Ok(mut active) = self.reconnecting.lock() {
            active.remove(host);
        }
    }

    /// Reconnects every saved host the user did not disconnect, once per app run. A failure
    /// shows on that host's row; it never blocks the others.
    pub fn auto_connect_saved_hosts(self: &std::sync::Arc<Self>) {
        let targets: Vec<DesktopRemoteSshSavedHost> = self
            .saved_hosts
            .lock()
            .map(|s| {
                s.iter()
                    .filter(|h| h.auto_connect != Some(false))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for entry in targets {
            let manager = std::sync::Arc::clone(self);
            std::thread::spawn(move || {
                let _ = manager.connect(entry);
            });
        }
    }

    pub fn forget_host(&self, host: &str) {
        let trimmed = host.trim();
        let removed_child = self
            .tunnels
            .lock()
            .ok()
            .and_then(|mut tunnels| tunnels.remove(trimmed));
        if let Some(child) = removed_child {
            Self::kill_and_reap(child);
        }
        if let Ok(mut saved) = self.saved_hosts.lock() {
            saved.retain(|h| h.host != trimmed);
            self.persist_saved_hosts(&saved);
        }
        if let Ok(mut live) = self.live_hosts.lock() {
            live.retain(|h| h.host != trimmed);
        }
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(trimmed);
        }
    }

    pub fn ws_url_for_host(&self, host: &str) -> Option<String> {
        self.reconcile_tunnels();
        let live = self.live_hosts.lock().ok()?;
        let found = live.iter().find(|h| h.host == host.trim())?;
        found.local_port?;
        let sessions = self.sessions.lock().ok()?;
        let session = sessions.get(host.trim())?;
        // The remote server is client-scoped: every socket carries its token and this desktop's id.
        Some(format!(
            "ws://127.0.0.1:{}/?token={}&client={}",
            session.local_port, session.token, self.client_id
        ))
    }

    /// Download URLs for a connected host's workspace files, rebuilt from its own tunnel so the
    /// renderer cannot point the desktop at any other URL. Each item keeps only `cwd`, `path`
    /// and a plain `fileName`.
    pub fn download_requests(
        &self,
        input: &DesktopWorkspaceDownloadInput,
    ) -> Result<Vec<(String, String)>, String> {
        if !Self::is_valid_ssh_target(&input.host) {
            return Err("Unknown SSH host.".to_string());
        }
        let invalid = || "This download request is not valid.".to_string();
        let (port, token) = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| {
                s.get(input.host.trim())
                    .map(|s| (s.local_port, s.token.clone()))
            })
            .filter(|_| self.ws_url_for_host(&input.host).is_some())
            .ok_or_else(invalid)?;
        if input.items.len() > 1000 {
            return Err(invalid());
        }
        input
            .items
            .iter()
            .map(|item| {
                let name = &item.file_name;
                let plain = !name.is_empty()
                    && name.chars().count() <= 255
                    && name.trim() == name
                    && name != "."
                    && name != ".."
                    && !name.contains(['/', '\\', '\0']);
                if item.cwd.is_empty() || item.path.is_empty() || !plain {
                    return Err(invalid());
                }
                let mut url =
                    url::Url::parse(&format!("http://127.0.0.1:{port}/api/workspace/download"))
                        .map_err(|e| e.to_string())?;
                url.query_pairs_mut()
                    .append_pair("cwd", &item.cwd)
                    .append_pair("path", &item.path)
                    .append_pair("token", &token)
                    // A shared remote server scopes the download to this desktop's projects.
                    .append_pair("client", &self.client_id);
                Ok((url.to_string(), name.clone()))
            })
            .collect()
    }

    /// Downloads each file in turn; one failure does not stop the rest. A chosen file is
    /// replaced only once its download finished; in a chosen folder a taken name gets " (1)".
    pub async fn save_downloads(
        requests: Vec<(String, String)>,
        destination: DownloadDestination,
    ) -> DesktopWorkspaceDownloadResult {
        let client = reqwest::Client::builder().no_proxy().build();
        let mut saved = Vec::new();
        let mut failures = Vec::new();
        for (url, file_name) in requests {
            let result = async {
                let client = client.as_ref().map_err(|e| e.to_string())?;
                let mut response = client.get(&url).send().await.map_err(|e| e.to_string())?;
                if !response.status().is_success() {
                    let status = response.status().as_u16();
                    let body: Option<serde_json::Value> = response.json().await.ok();
                    return Err(body
                        .and_then(|b| b.get("error")?.as_str().map(str::to_string))
                        .unwrap_or_else(|| format!("Download failed with status {status}.")));
                }
                let (mut file, final_path, temp) =
                    Self::open_download_target(&destination, &file_name)?;
                let written = async {
                    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
                    }
                    Ok::<_, String>(())
                }
                .await;
                drop(file);
                let written_path = temp.clone().unwrap_or_else(|| final_path.clone());
                if let Err(e) = written.and_then(|_| match &temp {
                    Some(t) => std::fs::rename(t, &final_path).map_err(|e| e.to_string()),
                    None => Ok(()),
                }) {
                    let _ = std::fs::remove_file(&written_path);
                    return Err(e);
                }
                Ok(final_path)
            }
            .await;
            match result {
                Ok(path) => saved.push(DesktopWorkspaceSavedFile {
                    file_name,
                    path: path.to_string_lossy().into_owned(),
                }),
                Err(message) => failures.push(DesktopWorkspaceFailedFile { file_name, message }),
            }
        }
        DesktopWorkspaceDownloadResult {
            canceled: false,
            saved,
            failures,
        }
    }

    /// The open file, its final path, and the temporary path it is renamed from (file target).
    fn open_download_target(
        destination: &DownloadDestination,
        file_name: &str,
    ) -> Result<(std::fs::File, PathBuf, Option<PathBuf>), String> {
        let create = |p: &Path| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(p)
        };
        match destination {
            DownloadDestination::File(path) => {
                let base = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let temp =
                    path.with_file_name(format!(".{base}.{}.download", Uuid::new_v4().simple()));
                let file = create(&temp).map_err(|e| e.to_string())?;
                Ok((file, path.clone(), Some(temp)))
            }
            DownloadDestination::Directory(dir) => {
                let (stem, ext) = match file_name.rfind('.') {
                    Some(dot) if dot > 0 => (&file_name[..dot], &file_name[dot..]),
                    _ => (file_name, ""),
                };
                for index in 0..=999 {
                    let candidate = if index == 0 {
                        file_name.to_string()
                    } else {
                        format!("{stem} ({index}){ext}")
                    };
                    let path = dir.join(&candidate);
                    match create(&path) {
                        Ok(file) => return Ok((file, path, None)),
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                        Err(e) => return Err(e.to_string()),
                    }
                }
                Err(format!(
                    "Too many files are already named like {file_name}."
                ))
            }
        }
    }

    pub fn kill_all_tunnels(&self) {
        let children: Vec<Child> = self
            .tunnels
            .lock()
            .ok()
            .map(|mut tunnels| tunnels.drain().map(|(_, c)| c).collect())
            .unwrap_or_default();
        for child in children {
            Self::kill_and_reap(child);
        }
    }
}

impl Drop for RemoteSshManager {
    fn drop(&mut self) {
        self.kill_all_tunnels();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_concrete_ssh_config_host_aliases() {
        let sample = "
            Host *
              ServerAliveInterval 30
            Host dev-box prod.internal *.wildcard !excluded
              User ubuntu
        ";
        let hosts = RemoteSshManager::parse_ssh_config_hosts(sample);
        assert_eq!(
            hosts,
            vec!["dev-box".to_string(), "prod.internal".to_string()]
        );
    }

    #[test]
    fn validates_ssh_targets_and_normalizes_remote_roots() {
        assert!(RemoteSshManager::is_valid_ssh_target("devbox"));
        assert!(RemoteSshManager::is_valid_ssh_target("ubuntu@10.0.0.5"));
        assert!(RemoteSshManager::is_valid_ssh_target("[::1]"));
        assert!(!RemoteSshManager::is_valid_ssh_target(
            "-oProxyCommand=evil"
        ));
        assert!(!RemoteSshManager::is_valid_ssh_target(
            "ubuntu@-oProxyCommand=evil"
        ));
        assert!(!RemoteSshManager::is_valid_ssh_target("user@host@extra"));
        assert!(!RemoteSshManager::is_valid_ssh_target("@host"));
        assert!(!RemoteSshManager::is_valid_ssh_target("user@"));
        assert!(!RemoteSshManager::is_valid_ssh_target(""));

        assert_eq!(
            RemoteSshManager::normalize_remote_root("~/.saint-remote/"),
            Some(".saint-remote".to_string())
        );
        assert!(RemoteSshManager::normalize_remote_root("../escape").is_none());
        assert!(RemoteSshManager::normalize_remote_root("/abs/path").is_none());
    }

    #[test]
    fn builds_ssh_option_args_and_parses_probe_results() {
        let entry = DesktopRemoteSshSavedHost {
            host: "devbox.internal".to_string(),
            remote_root: Some(".saint-remote".to_string()),
            host_key: Some("a1b2c3d4".to_string()),
            auto_connect: None,
            label: Some("Staging Box".to_string()),
            user: Some("ubuntu".to_string()),
            port: Some(2222),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
        };
        assert_eq!(
            RemoteSshManager::ssh_connection_option_args(&entry),
            vec!["-p", "2222", "-l", "ubuntu", "-i", "~/.ssh/id_ed25519"]
        );

        let running = RemoteSshManager::parse_test_host_output(
            "devbox.internal",
            true,
            "SAINT_SSH_OK\nSAINT_SERVER_RUNNING\n",
            "",
        );
        assert!(running.reachable);
        assert!(running.authenticated);
        assert!(running.server_running);

        let auth_failed = RemoteSshManager::parse_test_host_output(
            "devbox.internal",
            false,
            "",
            "ubuntu@devbox.internal: Permission denied (publickey).",
        );
        assert!(auth_failed.reachable);
        assert!(!auth_failed.authenticated);
        assert!(!auth_failed.server_running);
    }

    #[test]
    fn updates_and_renames_saved_hosts_preserving_host_key() {
        let temp_dir = std::env::temp_dir().join(format!("saint-ssh-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let paths = SaintPaths::from_base_dir(temp_dir.clone());
        let manager = RemoteSshManager::new(paths);

        let state = manager
            .update_host(DesktopRemoteSshUpdateHostInput {
                previous_host: None,
                target: DesktopRemoteSshSavedHost {
                    host: "devbox".to_string(),
                    remote_root: Some("custom/saint".to_string()),
                    host_key: None,
                    auto_connect: None,
                    label: Some("Dev Box".to_string()),
                    user: Some("alice".to_string()),
                    port: Some(2200),
                    identity_file: Some("~/.ssh/dev_key".to_string()),
                },
            })
            .unwrap();
        assert_eq!(state.saved_hosts.len(), 1);
        let original_key = state.saved_hosts[0].host_key.clone();
        assert!(original_key.is_some());

        let renamed = manager
            .update_host(DesktopRemoteSshUpdateHostInput {
                previous_host: Some("devbox".to_string()),
                target: DesktopRemoteSshSavedHost {
                    host: "devbox-2".to_string(),
                    remote_root: Some("custom/saint".to_string()),
                    host_key: None,
                    auto_connect: None,
                    label: Some("Dev Box 2".to_string()),
                    user: Some("bob".to_string()),
                    port: Some(22),
                    identity_file: Some("~/.ssh/id_ed25519".to_string()),
                },
            })
            .unwrap();
        assert_eq!(renamed.saved_hosts.len(), 1);
        assert_eq!(renamed.saved_hosts[0].host, "devbox-2");
        assert_eq!(renamed.saved_hosts[0].host_key, original_key);
        assert_eq!(renamed.saved_hosts[0].label.as_deref(), Some("Dev Box 2"));
        assert_eq!(renamed.saved_hosts[0].user.as_deref(), Some("bob"));
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn brackets_first_char_in_remote_root_process_pattern() {
        assert_eq!(
            RemoteSshManager::remote_root_process_pattern(".saint-remote"),
            "[.]saint-remote"
        );
        assert_eq!(
            RemoteSshManager::remote_root_process_pattern("custom/saint"),
            "[c]ustom/saint"
        );
        assert_eq!(RemoteSshManager::remote_root_process_pattern(""), "");
    }

    #[cfg(unix)]
    #[test]
    fn rekeys_tunnel_on_host_rename_so_disconnect_by_new_name_kills_it() {
        let temp_dir =
            std::env::temp_dir().join(format!("saint-ssh-rename-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let paths = SaintPaths::from_base_dir(temp_dir.clone());
        let manager = RemoteSshManager::new(paths);

        let child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sleep 30");
        manager
            .tunnels
            .lock()
            .unwrap()
            .insert("devbox".to_string(), child);

        manager
            .update_host(DesktopRemoteSshUpdateHostInput {
                previous_host: Some("devbox".to_string()),
                target: DesktopRemoteSshSavedHost {
                    host: "devbox-renamed".to_string(),
                    remote_root: None,
                    host_key: None,
                    auto_connect: None,
                    label: None,
                    user: None,
                    port: None,
                    identity_file: None,
                },
            })
            .unwrap();

        {
            let tunnels = manager.tunnels.lock().unwrap();
            assert!(!tunnels.contains_key("devbox"));
            assert!(tunnels.contains_key("devbox-renamed"));
        }

        manager.disconnect("devbox-renamed").unwrap();
        assert!(!manager
            .tunnels
            .lock()
            .unwrap()
            .contains_key("devbox-renamed"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
