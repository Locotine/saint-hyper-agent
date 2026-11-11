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

    fn reconcile_tunnels(&self) {
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
                        entry.phase = "error".to_string();
                        entry.local_port = None;
                        entry.message = Some("SSH tunnel closed.".to_string());
                    }
                }
            }
        }
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
        if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
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
            Some(raw) => Some(
                Self::normalize_remote_root(raw).ok_or_else(|| {
                    "The remote folder must be a relative path inside the home folder.".to_string()
                })?,
            ),
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
            port: input.port.filter(|p| *p > 0).or_else(|| existing.as_ref().and_then(|h| h.port)),
            identity_file: Self::sanitize_optional_field(input.identity_file.as_deref())
                .or_else(|| existing.as_ref().and_then(|h| h.identity_file.clone())),
        };

        if promote_to_front {
            saved_guard.retain(|h| h.host != prev && h.host != host);
            saved_guard.insert(0, entry.clone());
        } else if let Some(pos) = saved_guard.iter().position(|h| h.host == prev || h.host == host) {
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
            Some(raw) => Some(
                Self::normalize_remote_root(raw).ok_or_else(|| {
                    "The remote folder must be a relative path inside the home folder.".to_string()
                })?,
            ),
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

            if let Some(pos) = saved_guard.iter().position(|h| h.host == prev || h.host == host) {
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
            user: input.user.or_else(|| saved_entry.as_ref().and_then(|s| s.user.clone())),
            port: input.port.or_else(|| saved_entry.as_ref().and_then(|s| s.port)),
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

    pub fn connect(
        &self,
        input: DesktopRemoteSshSavedHost,
    ) -> Result<DesktopRemoteSshHostState, String> {
        let entry = self.upsert_saved_entry(None, input, true)?;
        let host = entry.host.clone();
        let host_key = entry
            .host_key
            .clone()
            .unwrap_or_else(Self::generate_host_key);
        let remote_root = entry
            .remote_root
            .clone()
            .unwrap_or_else(|| DEFAULT_REMOTE_ROOT.to_string());
        let local_port = Self::reserve_local_port();
        let extra_args = Self::ssh_connection_option_args(&entry);

        // Spawn non-interactive SSH port forward (`ssh -N -L <localPort>:127.0.0.1:3773 <host>`)
        let mut ssh_cmd = Command::new("ssh");
        ssh_cmd.args([
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ExitOnForwardFailure=yes",
        ]);
        ssh_cmd.args(&extra_args);
        ssh_cmd
            .args([
                "-N",
                "-L",
                &format!("{local_port}:127.0.0.1:3773"),
                "--",
                &host,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            ssh_cmd.creation_flags(0x0800_0000);
        }

        let (phase, message, bound_port) = match ssh_cmd.spawn() {
            Ok(child) => {
                let prev = self
                    .tunnels
                    .lock()
                    .ok()
                    .and_then(|mut tunnels| tunnels.insert(host.clone(), child));
                if let Some(prev_child) = prev {
                    Self::kill_and_reap(prev_child);
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
            user: input.user.or_else(|| saved_entry.as_ref().and_then(|s| s.user.clone())),
            port: input.port.or_else(|| saved_entry.as_ref().and_then(|s| s.port)),
            identity_file: input
                .identity_file
                .or_else(|| saved_entry.as_ref().and_then(|s| s.identity_file.clone())),
        };
        let extra_args = Self::ssh_connection_option_args(&merged);
        let pattern = Self::remote_root_process_pattern(&remote_root);
        let mut stop_cmd = Command::new("ssh");
        stop_cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
        stop_cmd.args(&extra_args);
        stop_cmd
            .arg("--")
            .arg(&host)
            .arg(format!("pkill -f '{pattern}' >/dev/null 2>&1 || true"))
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
    }

    pub fn ws_url_for_host(&self, host: &str) -> Option<String> {
        self.reconcile_tunnels();
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
        assert_eq!(hosts, vec!["dev-box".to_string(), "prod.internal".to_string()]);
    }

    #[test]
    fn validates_ssh_targets_and_normalizes_remote_roots() {
        assert!(RemoteSshManager::is_valid_ssh_target("devbox"));
        assert!(RemoteSshManager::is_valid_ssh_target("ubuntu@10.0.0.5"));
        assert!(RemoteSshManager::is_valid_ssh_target("[::1]"));
        assert!(!RemoteSshManager::is_valid_ssh_target("-oProxyCommand=evil"));
        assert!(!RemoteSshManager::is_valid_ssh_target("ubuntu@-oProxyCommand=evil"));
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
        let temp_dir = std::env::temp_dir().join(format!("saint-ssh-rename-test-{}", Uuid::new_v4()));
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
        assert!(!manager.tunnels.lock().unwrap().contains_key("devbox-renamed"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
