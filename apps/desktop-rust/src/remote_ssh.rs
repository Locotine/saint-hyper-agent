// FILE: remote_ssh.rs
// Purpose: Manages Remote SSH hosts, `~/.ssh/config` host discovery, and SSH tunnels
//          (Option 3.3-A).
// Layer: Desktop Remote SSH subsystem.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use uuid::Uuid;

use crate::state::SaintPaths;

pub const DEFAULT_REMOTE_ROOT: &str = ".saint-remote";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRemoteSshSavedHost {
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
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

#[derive(Debug, Serialize, Deserialize)]
struct PersistedSavedHostsEnvelope {
    version: u32,
    hosts: Vec<DesktopRemoteSshSavedHost>,
}

pub struct RemoteSshManager {
    paths: SaintPaths,
    saved_hosts: Mutex<Vec<DesktopRemoteSshSavedHost>>,
    live_hosts: Mutex<Vec<DesktopRemoteSshHostState>>,
    tunnels: Mutex<HashMap<String, Child>>,
}

impl RemoteSshManager {
    pub fn new(paths: SaintPaths) -> Self {
        let initial_saved = Self::read_saved_hosts(&paths.remote_ssh_hosts_path);
        Self {
            paths,
            saved_hosts: Mutex::new(initial_saved),
            live_hosts: Mutex::new(Vec::new()),
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_valid_ssh_target(value: &str) -> bool {
        let trimmed = value.trim();
        if trimmed.is_empty() || trimmed.len() > 253 || trimmed.starts_with('-') {
            return false;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            return trimmed[1..trimmed.len() - 1]
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
        }
        let mut chars = trimmed.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        if !(first.is_ascii_alphanumeric() || first == '_') {
            return false;
        }
        chars.all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '%' | ':' | '-')
        })
    }

    pub fn normalize_remote_root(value: &str) -> Option<String> {
        let trimmed = value
            .trim()
            .trim_start_matches("~/")
            .trim_end_matches('/');
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

    pub fn get_state(&self) -> DesktopRemoteSshState {
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

    pub fn connect(
        &self,
        input: DesktopRemoteSshSavedHost,
    ) -> Result<DesktopRemoteSshHostState, String> {
        let host = input.host.trim().to_string();
        if !Self::is_valid_ssh_target(&host) {
            return Err("Enter an SSH host such as `devbox` or `user@example.com`.".to_string());
        }
        let normalized_root = match input.remote_root.as_deref() {
            None | Some("") => None,
            Some(raw) => Some(
                Self::normalize_remote_root(raw).ok_or_else(|| {
                    "The remote folder must be a relative path inside the home folder.".to_string()
                })?,
            ),
        };

        let host_key = {
            let mut saved_guard = self.saved_hosts.lock().map_err(|e| e.to_string())?;
            let existing_key = input
                .host_key
                .clone()
                .or_else(|| {
                    saved_guard
                        .iter()
                        .find(|h| h.host == host)
                        .and_then(|h| h.host_key.clone())
                })
                .unwrap_or_else(Self::generate_host_key);

            let entry = DesktopRemoteSshSavedHost {
                host: host.clone(),
                remote_root: normalized_root.clone(),
                host_key: Some(existing_key.clone()),
                auto_connect: None,
            };
            saved_guard.retain(|h| h.host != host);
            saved_guard.insert(0, entry);
            self.persist_saved_hosts(&saved_guard);
            existing_key
        };

        let remote_root = normalized_root.unwrap_or_else(|| DEFAULT_REMOTE_ROOT.to_string());
        let local_port = Self::reserve_local_port();

        // Spawn non-interactive SSH port forward (`ssh -N -L <localPort>:127.0.0.1:3773 <host>`)
        let mut ssh_cmd = Command::new("ssh");
        ssh_cmd
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ExitOnForwardFailure=yes",
                "-N",
                "-L",
                &format!("{local_port}:127.0.0.1:3773"),
                &host,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            ssh_cmd.creation_flags(0x0800_0000);
        }

        let (phase, message, bound_port) = match ssh_cmd.spawn() {
            Ok(child) => {
                if let Ok(mut tunnels) = self.tunnels.lock() {
                    if let Some(mut prev) = tunnels.insert(host.clone(), child) {
                        let _ = prev.kill();
                    }
                }
                ("connected".to_string(), None, Some(local_port))
            }
            Err(err) => (
                "error".to_string(),
                Some(format!("Failed to start SSH tunnel: {err}")),
                None,
            ),
        };

        let next_state = {
            let mut live_guard = self.live_hosts.lock().map_err(|e| e.to_string())?;
            let next_epoch = live_guard
                .iter()
                .find(|h| h.host == host)
                .map(|h| h.epoch + 1)
                .unwrap_or(1);
            let state = DesktopRemoteSshHostState {
                host: host.clone(),
                host_key: Some(host_key),
                epoch: next_epoch,
                remote_root,
                phase,
                message,
                local_port: bound_port,
            };
            if let Some(existing) = live_guard.iter_mut().find(|h| h.host == host) {
                *existing = state.clone();
            } else {
                live_guard.push(state.clone());
            }
            state
        };

        Ok(next_state)
    }

    pub fn disconnect(&self, host: &str) -> Result<(), String> {
        let trimmed = host.trim();
        if !Self::is_valid_ssh_target(trimmed) {
            return Err("Unknown SSH host.".to_string());
        }
        if let Ok(mut tunnels) = self.tunnels.lock() {
            if let Some(mut child) = tunnels.remove(trimmed) {
                let _ = child.kill();
            }
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
        let host = input.host.trim();
        self.disconnect(host)?;
        let remote_root = input
            .remote_root
            .as_deref()
            .and_then(Self::normalize_remote_root)
            .unwrap_or_else(|| DEFAULT_REMOTE_ROOT.to_string());
        let mut stop_cmd = Command::new("ssh");
        stop_cmd
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=5",
                host,
                &format!("pkill -f '{remote_root}' >/dev/null 2>&1 || true"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            stop_cmd.creation_flags(0x0800_0000);
        }
        let _ = stop_cmd.status();
        Ok(())
    }

    pub fn forget_host(&self, host: &str) {
        let trimmed = host.trim();
        if let Ok(mut tunnels) = self.tunnels.lock() {
            if let Some(mut child) = tunnels.remove(trimmed) {
                let _ = child.kill();
            }
        }
        if let Ok(mut saved) = self.saved_hosts.lock() {
            saved.retain(|h| h.host != trimmed);
            self.persist_saved_hosts(&saved);
        }
        if let Ok(mut live) = self.live_hosts.lock() {
            live.retain(|h| h.host != trimmed);
        }
    }

    pub fn ws_url_for_host(&self, host: &str) -> Option<String> {
        let live = self.live_hosts.lock().ok()?;
        let found = live.iter().find(|h| h.host == host.trim())?;
        found.local_port.map(|p| format!("ws://127.0.0.1:{p}"))
    }

    pub fn download_files(
        &self,
        input: DesktopWorkspaceDownloadInput,
    ) -> Result<DesktopWorkspaceDownloadResult, String> {
        if !Self::is_valid_ssh_target(&input.host) {
            return Err("Unknown SSH host.".to_string());
        }
        if input.items.is_empty() {
            return Ok(DesktopWorkspaceDownloadResult {
                canceled: false,
                saved: Vec::new(),
                failures: Vec::new(),
            });
        }
        if self.ws_url_for_host(&input.host).is_none() {
            return Err("Remote SSH host is not connected.".to_string());
        }
        Ok(DesktopWorkspaceDownloadResult {
            canceled: false,
            saved: Vec::new(),
            failures: input
                .items
                .into_iter()
                .map(|item| DesktopWorkspaceFailedFile {
                    file_name: item.file_name,
                    message: "Remote workspace download stream unavailable.".to_string(),
                })
                .collect(),
        })
    }

    pub fn kill_all_tunnels(&self) {
        if let Ok(mut tunnels) = self.tunnels.lock() {
            for (_, mut child) in tunnels.drain() {
                let _ = child.kill();
            }
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
        assert_eq!(hosts, vec!["dev-box".to_string(), "prod.internal".to_string()]);
    }

    #[test]
    fn validates_ssh_targets_and_normalizes_remote_roots() {
        assert!(RemoteSshManager::is_valid_ssh_target("devbox"));
        assert!(RemoteSshManager::is_valid_ssh_target("ubuntu@10.0.0.5"));
        assert!(RemoteSshManager::is_valid_ssh_target("[::1]"));
        assert!(!RemoteSshManager::is_valid_ssh_target("-oProxyCommand=evil"));
        assert!(!RemoteSshManager::is_valid_ssh_target(""));

        assert_eq!(
            RemoteSshManager::normalize_remote_root("~/.saint-remote/"),
            Some(".saint-remote".to_string())
        );
        assert!(RemoteSshManager::normalize_remote_root("../escape").is_none());
        assert!(RemoteSshManager::normalize_remote_root("/abs/path").is_none());
    }
}
