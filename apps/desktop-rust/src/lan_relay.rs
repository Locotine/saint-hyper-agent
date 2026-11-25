// FILE: lan_relay.rs
// Purpose: Mobile LAN / Tailscale HTTP + WebSocket Reverse Proxy Relay with one-time/rotatable
//          QR pairing token authentication and instant session revocation (Phase 5 Option B).
// Layer: Desktop native networking & security boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::backend::BackendSupervisor;
use crate::remote_ssh::{
    DesktopRemoteSshSavedHost, DesktopRemoteSshUpdateHostInput, RemoteSshManager,
};
use crate::updater::now_iso8601;

pub const DEFAULT_LAN_RELAY_PORT: u16 = 3883;
pub const MAX_LAN_RELAY_SESSIONS: usize = 64;
const LAN_SESSION_COOKIE_NAME: &str = "saint_lan_session";
const LAN_RELAY_CAPABILITY_COOKIE_NAME: &str = "saint_lan_relay";
const MAX_CONTROL_API_BODY_BYTES: usize = 64 * 1024;
const PAIRING_TOKEN_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LEN: usize = 12;
const PAIR_RATE_LIMIT_MAX_FAILURES: usize = 10;
const PAIR_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(300);

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRelayClientSession {
    pub session_id: String,
    pub label: String,
    pub remote_address: String,
    pub user_agent: Option<String>,
    pub created_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRelayInterface {
    pub name: String,
    pub address: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRelayState {
    pub enabled: bool,
    pub port: u16,
    pub interfaces: Vec<DesktopLanRelayInterface>,
    pub bind_address: Option<String>,
    pub pairing_token: String,
    pub pairing_url: Option<String>,
    pub qr_svg: Option<String>,
    pub active_sessions: Vec<DesktopLanRelayClientSession>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRelaySetEnabledInput {
    pub enabled: bool,
    pub port: Option<u16>,
    pub bind_address: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLanRelayRevokeSessionInput {
    pub session_id: String,
}

struct StoredRelaySession {
    info: DesktopLanRelayClientSession,
    secret: String,
    revoke_tx: watch::Sender<bool>,
}

struct ForwardedPortProxy {
    local_port: u16,
    listen_port: u16,
    bind_ip: IpAddr,
    stop_tx: watch::Sender<bool>,
}

struct RelayInner {
    enabled: bool,
    port: u16,
    /// Address the relay listens on; never 0.0.0.0. None picks the primary interface.
    bind_address: Option<Ipv4Addr>,
    pairing_token: String,
    error: Option<String>,
    stop_tx: Option<watch::Sender<bool>>,
    sessions: HashMap<String, StoredRelaySession>,
    pair_failures: HashMap<IpAddr, Vec<Instant>>,
    forward_proxies: HashMap<(String, u16), ForwardedPortProxy>,
}

pub struct LanRelayManager {
    backend: Arc<BackendSupervisor>,
    remote_ssh: Arc<RemoteSshManager>,
    inner: Arc<Mutex<RelayInner>>,
}

impl LanRelayManager {
    pub fn new(backend: Arc<BackendSupervisor>, remote_ssh: Arc<RemoteSshManager>) -> Self {
        Self {
            backend,
            remote_ssh,
            inner: Arc::new(Mutex::new(RelayInner {
                enabled: false,
                port: DEFAULT_LAN_RELAY_PORT,
                bind_address: None,
                pairing_token: generate_pairing_token(),
                error: None,
                stop_tx: None,
                sessions: HashMap::new(),
                pair_failures: HashMap::new(),
                forward_proxies: HashMap::new(),
            })),
        }
    }

    pub fn get_state(&self) -> DesktopLanRelayState {
        let interfaces = discover_network_interfaces();

        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let bind_address =
            resolve_bind_address(guard.bind_address, &interfaces).map(|ip| ip.to_string());

        let pairing_url = bind_address.as_ref().map(|host| {
            format!(
                "http://{}:{}/pair#token={}",
                host, guard.port, guard.pairing_token
            )
        });
        let qr_svg = pairing_url.as_deref().and_then(|url| render_qr_svg(url, 4));

        let mut active_sessions: Vec<DesktopLanRelayClientSession> =
            guard.sessions.values().map(|s| s.info.clone()).collect();
        active_sessions.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));

        DesktopLanRelayState {
            enabled: guard.enabled,
            port: guard.port,
            interfaces,
            bind_address,
            pairing_token: guard.pairing_token.clone(),
            pairing_url,
            qr_svg,
            active_sessions,
            error: guard.error.clone(),
        }
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        requested_port: Option<u16>,
        requested_bind_address: Option<String>,
    ) -> DesktopLanRelayState {
        // Stop existing listener if any
        {
            let mut guard = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(tx) = guard.stop_tx.take() {
                let _ = tx.send(true);
            }
            for (_, proxy) in guard.forward_proxies.drain() {
                let _ = proxy.stop_tx.send(true);
            }
            guard.enabled = false;
            guard.error = None;
            if let Some(p) = requested_port.filter(|p| *p >= 1024) {
                guard.port = p;
            }
            if let Some(ip) = requested_bind_address.and_then(|a| a.parse::<Ipv4Addr>().ok()) {
                guard.bind_address = Some(ip);
            }
        }

        if !enabled {
            return self.get_state();
        }

        let (port, stored_bind) = {
            let guard = match self.inner.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            (guard.port, guard.bind_address)
        };
        let Some(bind_ip) = resolve_bind_address(stored_bind, &discover_network_interfaces())
        else {
            if let Ok(mut guard) = self.inner.lock() {
                guard.error = Some("No LAN or Tailscale interface found to listen on.".to_string());
            }
            return self.get_state();
        };

        let bind_addr = SocketAddr::from((bind_ip, port));
        match TcpListener::bind(bind_addr).await {
            Ok(listener) => {
                let actual_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);
                let (stop_tx, stop_rx) = watch::channel(false);
                {
                    let mut guard = match self.inner.lock() {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                    guard.enabled = true;
                    guard.port = actual_port;
                    guard.error = None;
                    guard.stop_tx = Some(stop_tx);
                }

                let inner_clone = Arc::clone(&self.inner);
                let backend_clone = Arc::clone(&self.backend);
                let remote_ssh_clone = Arc::clone(&self.remote_ssh);
                tokio::spawn(async move {
                    run_relay_accept_loop(
                        listener,
                        stop_rx,
                        inner_clone,
                        backend_clone,
                        remote_ssh_clone,
                    )
                    .await;
                });
            }
            Err(err) => {
                let mut guard = match self.inner.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard.enabled = false;
                guard.error = Some(format!("Could not bind {bind_ip}:{port}: {err}"));
            }
        }

        self.get_state()
    }

    pub fn rotate_pairing_token(&self) -> DesktopLanRelayState {
        if let Ok(mut guard) = self.inner.lock() {
            guard.pairing_token = generate_pairing_token();
        }
        self.get_state()
    }

    pub fn revoke_session(&self, session_id: &str) -> DesktopLanRelayState {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(removed) = guard.sessions.remove(session_id) {
                let _ = removed.revoke_tx.send(true);
            }
        }
        self.get_state()
    }

    pub fn revoke_all_sessions(&self) -> DesktopLanRelayState {
        if let Ok(mut guard) = self.inner.lock() {
            for (_, session) in guard.sessions.drain() {
                let _ = session.revoke_tx.send(true);
            }
        }
        self.get_state()
    }

    pub fn stop_sync(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(tx) = guard.stop_tx.take() {
                let _ = tx.send(true);
            }
            for (_, proxy) in guard.forward_proxies.drain() {
                let _ = proxy.stop_tx.send(true);
            }
            for (_, session) in guard.sessions.drain() {
                let _ = session.revoke_tx.send(true);
            }
            guard.enabled = false;
        }
    }
}

fn generate_pairing_token() -> String {
    let u1 = *uuid::Uuid::new_v4().as_bytes();
    let u2 = *uuid::Uuid::new_v4().as_bytes();
    let mut entropy = Vec::with_capacity(24);
    for b in [&u1, &u2] {
        // Skip byte 6 (UUID version nibble) and byte 8 (UUID variant bits) so all 12 bytes are uniform random.
        for (idx, &val) in b.iter().enumerate() {
            if idx != 6 && idx != 8 {
                entropy.push(val);
            }
        }
    }
    let mut out = String::with_capacity(PAIRING_TOKEN_LEN);
    for b in entropy.iter().take(PAIRING_TOKEN_LEN) {
        let idx = (*b as usize) % PAIRING_TOKEN_ALPHABET.len();
        out.push(PAIRING_TOKEN_ALPHABET[idx] as char);
    }
    out
}

pub fn classify_ipv4_address(ip: Ipv4Addr) -> Option<&'static str> {
    if ip.is_loopback() || ip.is_link_local() || ip.is_broadcast() || ip.is_unspecified() {
        return None;
    }
    let octets = ip.octets();
    // Tailscale / CGNAT range: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
    if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        return Some("tailscale");
    }
    // RFC 1918 private LAN ranges
    if octets[0] == 192 && octets[1] == 168 {
        return Some("lan");
    }
    if octets[0] == 10 {
        return Some("lan");
    }
    if octets[0] == 172 && (16..=31).contains(&octets[1]) {
        return Some("lan");
    }
    None
}

/// Picks the stored address while its interface is still up, else the primary interface.
fn resolve_bind_address(
    stored: Option<Ipv4Addr>,
    interfaces: &[DesktopLanRelayInterface],
) -> Option<Ipv4Addr> {
    let available = |ip: &Ipv4Addr| interfaces.iter().any(|i| i.address == ip.to_string());
    stored
        .filter(available)
        .or_else(|| interfaces.first().and_then(|i| i.address.parse().ok()))
}

/// Private LAN and Tailscale IPv4 interfaces, primary route first. Container
/// bridges are left out because a phone cannot reach them.
pub fn discover_network_interfaces() -> Vec<DesktopLanRelayInterface> {
    let primary = UdpSocket::bind("0.0.0.0:0").ok().and_then(|socket| {
        socket.connect("8.8.8.8:80").ok()?;
        match socket.local_addr().ok()? {
            SocketAddr::V4(local) => Some(*local.ip()),
            SocketAddr::V6(_) => None,
        }
    });
    let mut out = build_discovered_interfaces(list_system_ipv4_interfaces(), primary);
    sort_interfaces(&mut out, primary);
    out
}

fn build_discovered_interfaces(
    raw: Vec<(String, Ipv4Addr)>,
    primary: Option<Ipv4Addr>,
) -> Vec<DesktopLanRelayInterface> {
    let mut out: Vec<DesktopLanRelayInterface> = Vec::new();
    for (name, ip) in raw {
        let Some(kind) = classify_ipv4_address(ip) else {
            continue;
        };
        if is_virtual_interface_name(&name) || out.iter().any(|i| i.address == ip.to_string()) {
            continue;
        }
        out.push(DesktopLanRelayInterface {
            name,
            address: ip.to_string(),
            kind: kind.to_string(),
        });
    }
    // Fallback when system CLI inspection fails (minimal container, stripped PATH,
    // or localized output): keep the UDP default-route IPv4 if it is LAN/Tailscale.
    if out.is_empty() {
        if let Some(ip) = primary {
            if let Some(kind) = classify_ipv4_address(ip) {
                out.push(DesktopLanRelayInterface {
                    name: "default".to_string(),
                    address: ip.to_string(),
                    kind: kind.to_string(),
                });
            }
        }
    }
    out
}

/// LAN before Tailscale, then the primary route. A Tailscale exit node owns the
/// default route, but a phone on the same Wi-Fi can only reach the LAN address.
fn sort_interfaces(interfaces: &mut [DesktopLanRelayInterface], primary: Option<Ipv4Addr>) {
    let primary = primary.map(|p| p.to_string());
    interfaces.sort_by_key(|i| (i.kind != "lan", Some(&i.address) != primary.as_ref()));
}

fn is_virtual_interface_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "cni", "flannel", "podman", "lxc",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
        || lower.contains("vethernet")
}

fn list_system_ipv4_interfaces() -> Vec<(String, Ipv4Addr)> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // ipconfig outputs OEM codepage bytes on non-English Windows, so decode lossily.
        std::process::Command::new("ipconfig")
            .creation_flags(0x0800_0000)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .map(|text| parse_ipconfig(&text))
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let run = |prog: &str, args: &[&str]| {
            std::process::Command::new(prog)
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        };
        // Debian omits /sbin and /usr/sbin from default user PATH, and macOS GUI apps
        // may inherit a minimal PATH, so check explicit system paths as fallbacks.
        for ip_bin in ["ip", "/sbin/ip", "/usr/sbin/ip"] {
            if let Some(text) = run(ip_bin, &["-4", "-o", "addr", "show"]) {
                let parsed = parse_ip_addr_oneline(&text);
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
        for ifconfig_bin in ["ifconfig", "/sbin/ifconfig", "/usr/sbin/ifconfig"] {
            if let Some(text) = run(ifconfig_bin, &[]) {
                let parsed = parse_ifconfig(&text);
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
        Vec::new()
    }
}

/// `ip -4 -o addr show`: `2: wlan0    inet 192.168.1.5/24 brd 192.168.1.255 ...`
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn parse_ip_addr_oneline(text: &str) -> Vec<(String, Ipv4Addr)> {
    text.lines()
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            let name = tokens.get(1)?.trim_end_matches(':').split('@').next()?;
            let inet = tokens.iter().position(|t| *t == "inet")?;
            let ip = tokens.get(inet + 1)?.split('/').next()?.parse().ok()?;
            Some((name.to_string(), ip))
        })
        .collect()
}

/// BSD/macOS `ifconfig`: an unindented `en0: flags=...` header, then `\tinet 192.168.1.5 netmask ...`.
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn parse_ifconfig(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) && !line.is_empty() {
            current = line.split(':').next().unwrap_or("").trim().to_string();
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.first() == Some(&"inet") {
            let raw = tokens.get(1).map(|t| t.trim_start_matches("addr:"));
            if let Some(ip) = raw.and_then(|t| t.parse().ok()) {
                out.push((current.clone(), ip));
            }
        }
    }
    out
}

/// Windows `ipconfig`: `Wireless LAN adapter Wi-Fi:` then `   IPv4 Address. . . : 192.168.1.5(Preferred)`.
/// Also tolerates localized headers and full-width colons/parentheses on non-English Windows.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_ipconfig(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let trimmed_end = line.trim_end();
        if !line.starts_with(char::is_whitespace)
            && (trimmed_end.ends_with(':') || trimmed_end.ends_with('：'))
        {
            let header = trimmed_end.trim_end_matches([':', '：']);
            current = header
                .split_once(" adapter ")
                .map(|(_, name)| name)
                .unwrap_or(header)
                .trim()
                .to_string();
            continue;
        }
        if line.contains("IPv4") {
            if let Some((_, right)) = line.split_once([':', '：']) {
                let candidate = right
                    .trim()
                    .split(['(', '（'])
                    .next()
                    .unwrap_or("")
                    .trim();
                if let Ok(ip) = candidate.parse() {
                    let name = if current.is_empty() {
                        "interface".to_string()
                    } else {
                        current.clone()
                    };
                    out.push((name, ip));
                }
            }
        }
    }
    out
}

async fn run_relay_accept_loop(
    listener: TcpListener,
    mut stop_rx: watch::Receiver<bool>,
    inner: Arc<Mutex<RelayInner>>,
    backend: Arc<BackendSupervisor>,
    remote_ssh: Arc<RemoteSshManager>,
) {
    let relay_local_ip = listener
        .local_addr()
        .map(|addr| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((stream, remote_addr)) = accepted else {
                    continue;
                };
                let inner_conn = Arc::clone(&inner);
                let backend_conn = Arc::clone(&backend);
                let remote_ssh_conn = Arc::clone(&remote_ssh);
                let stop_conn = stop_rx.clone();
                tokio::spawn(async move {
                    if let Err(err) = handle_relay_connection(stream, remote_addr, relay_local_ip, inner_conn, backend_conn, remote_ssh_conn, stop_conn).await {
                        eprintln!("[lan-relay] {remote_addr}: {err}");
                    }
                });
            }
        }
    }
}

struct ParsedHttpHeader {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    header_end: usize,
}

fn parse_http_header(buf: &[u8]) -> Option<ParsedHttpHeader> {
    let header_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| pos + 4)?;
    let header_str = std::str::from_utf8(&buf[..header_end]).ok()?;
    let mut lines = header_str.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Some(ParsedHttpHeader {
        method,
        target,
        headers,
        header_end,
    })
}

fn extract_cookie_value(headers: &[(String, String)], cookie_name: &str) -> Option<String> {
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("cookie") {
            for pair in v.split(';') {
                if let Some((name, val)) = pair.trim().split_once('=') {
                    if name.trim() == cookie_name {
                        return Some(val.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn percent_decode_form_value(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0usize;
    while idx < bytes.len() {
        match bytes[idx] {
            b'+' => {
                out.push(b' ');
                idx += 1;
            }
            b'%' if idx + 2 < bytes.len() => {
                let hex = &input[idx + 1..idx + 3];
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    idx += 3;
                } else {
                    out.push(bytes[idx]);
                    idx += 1;
                }
            }
            byte => {
                out.push(byte);
                idx += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn extract_form_param(body: &[u8], param_name: &str) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    for pair in text.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == param_name {
                return Some(percent_decode_form_value(v));
            }
        }
    }
    None
}

fn normalize_authority_for_scheme(scheme: &str, authority: &str) -> String {
    let lower = authority.trim().to_ascii_lowercase();
    match scheme {
        "http" => lower.strip_suffix(":80").unwrap_or(&lower).to_string(),
        "https" => lower.strip_suffix(":443").unwrap_or(&lower).to_string(),
        _ => lower,
    }
}

/// Validates browser origin metadata (`Origin` and `Sec-Fetch-Site`) against this listener's
/// `Host` header. Rejects cross-origin and cross-port (`Sec-Fetch-Site: same-site`) WebSocket
/// upgrades and state-changing HTTP requests before headers are ever forwarded upstream.
fn validate_same_origin_request(
    headers: &[(String, String)],
    require_same_origin_fetch_site: bool,
) -> Result<(), &'static str> {
    let host_header = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim())
        .unwrap_or("");

    if let Some((_, fetch_site)) = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("sec-fetch-site"))
    {
        let site = fetch_site.trim().to_ascii_lowercase();
        if require_same_origin_fetch_site {
            if site != "same-origin" {
                return Err("Cross-origin or cross-port request rejected.");
            }
        } else if site != "same-origin" && site != "none" {
            return Err("Cross-origin or cross-port request rejected.");
        }
    }

    if let Some((_, origin_value)) = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("origin"))
    {
        let trimmed = origin_value.trim();
        let Some((scheme, rest)) = trimmed.split_once("://") else {
            return Err("Invalid Origin header.");
        };
        let scheme_lower = scheme.to_ascii_lowercase();
        if scheme_lower != "http" && scheme_lower != "https" {
            return Err("Unsupported Origin scheme.");
        }
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() || host_header.is_empty() {
            return Err("Missing Host or Origin authority.");
        }
        let expected_host = normalize_authority_for_scheme(&scheme_lower, host_header);
        let origin_host = normalize_authority_for_scheme(&scheme_lower, authority);
        if origin_host != expected_host {
            return Err("Cross-origin request rejected.");
        }
    }

    Ok(())
}

fn has_json_content_type(headers: &[(String, String)]) -> bool {
    headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("content-type")
            && v.split(';')
                .next()
                .map(|ct| ct.trim().eq_ignore_ascii_case("application/json"))
                .unwrap_or(false)
    })
}

fn is_pair_rate_limited(inner: &Arc<Mutex<RelayInner>>, ip: IpAddr) -> bool {
    let Ok(mut guard) = inner.lock() else {
        return false;
    };
    let now = Instant::now();
    let Some(entries) = guard.pair_failures.get_mut(&ip) else {
        return false;
    };
    entries.retain(|at| now.saturating_duration_since(*at) < PAIR_RATE_LIMIT_WINDOW);
    entries.len() >= PAIR_RATE_LIMIT_MAX_FAILURES
}

fn record_pair_failure(inner: &Arc<Mutex<RelayInner>>, ip: IpAddr) {
    if let Ok(mut guard) = inner.lock() {
        let now = Instant::now();
        let entries = guard.pair_failures.entry(ip).or_default();
        entries.retain(|at| now.saturating_duration_since(*at) < PAIR_RATE_LIMIT_WINDOW);
        entries.push(now);
    }
}

fn clear_pair_failures(inner: &Arc<Mutex<RelayInner>>, ip: IpAddr) {
    if let Ok(mut guard) = inner.lock() {
        guard.pair_failures.remove(&ip);
    }
}

async fn ensure_isolated_forward_listener(
    inner: &Arc<Mutex<RelayInner>>,
    bind_ip: IpAddr,
    host_key: &str,
    remote_port: u16,
    local_port: u16,
    relay_stop_rx: &watch::Receiver<bool>,
) -> Result<String, String> {
    let map_key = (host_key.to_string(), remote_port);
    {
        let guard = inner.lock().map_err(|_| "Relay lock poisoned.".to_string())?;
        if let Some(existing) = guard.forward_proxies.get(&map_key) {
            if existing.local_port == local_port && existing.bind_ip == bind_ip {
                return Ok(format!("http://{}:{}/", existing.bind_ip, existing.listen_port));
            }
        }
    }

    let listener = TcpListener::bind(SocketAddr::from((bind_ip, 0)))
        .await
        .map_err(|err| format!("Could not bind isolated forward listener on {bind_ip}: {err}"))?;
    let listen_port = listener
        .local_addr()
        .map_err(|err| err.to_string())?
        .port();
    let (proxy_stop_tx, proxy_stop_rx) = watch::channel(false);

    {
        let mut guard = inner.lock().map_err(|_| "Relay lock poisoned.".to_string())?;
        if let Some(old) = guard.forward_proxies.insert(
            map_key,
            ForwardedPortProxy {
                local_port,
                listen_port,
                bind_ip,
                stop_tx: proxy_stop_tx,
            },
        ) {
            let _ = old.stop_tx.send(true);
        }
    }

    let inner_clone = Arc::clone(inner);
    let relay_stop = relay_stop_rx.clone();
    tokio::spawn(async move {
        run_forward_proxy_accept_loop(listener, local_port, inner_clone, proxy_stop_rx, relay_stop)
            .await;
    });

    Ok(format!("http://{bind_ip}:{listen_port}/"))
}

async fn run_forward_proxy_accept_loop(
    listener: TcpListener,
    local_port: u16,
    inner: Arc<Mutex<RelayInner>>,
    mut proxy_stop_rx: watch::Receiver<bool>,
    mut relay_stop_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = proxy_stop_rx.changed() => {
                if changed.is_err() || *proxy_stop_rx.borrow() {
                    break;
                }
            }
            changed = relay_stop_rx.changed() => {
                if changed.is_err() || *relay_stop_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((stream, _remote_addr)) = accepted else {
                    continue;
                };
                let inner_conn = Arc::clone(&inner);
                let stop_a = proxy_stop_rx.clone();
                let stop_b = relay_stop_rx.clone();
                tokio::spawn(async move {
                    let _ = handle_isolated_forward_connection(
                        stream,
                        local_port,
                        inner_conn,
                        stop_a,
                        stop_b,
                    )
                    .await;
                });
            }
        }
    }
}

async fn handle_isolated_forward_connection(
    mut client_stream: TcpStream,
    local_port: u16,
    inner: Arc<Mutex<RelayInner>>,
    mut proxy_stop_rx: watch::Receiver<bool>,
    mut relay_stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut buf = vec![0u8; 16384];
    let mut filled = 0usize;
    let header_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let parsed = loop {
        if filled >= buf.len() {
            return Err("Header too large".to_string());
        }
        let read_res = tokio::select! {
            _ = tokio::time::sleep_until(header_deadline) => return Err("Timed out reading HTTP header".to_string()),
            _ = proxy_stop_rx.changed() => return Ok(()),
            _ = relay_stop_rx.changed() => return Ok(()),
            res = client_stream.read(&mut buf[filled..]) => res,
        };
        let n = read_res.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        filled += n;
        if let Some(p) = parse_http_header(&buf[..filled]) {
            break p;
        }
    };

    let session_rx = extract_cookie_value(&parsed.headers, LAN_SESSION_COOKIE_NAME)
        .and_then(|secret| validate_relay_session(&inner, &secret));
    let Some(mut revoke_rx) = session_rx else {
        let unauthorized = build_unauthorized_json_response();
        let _ = client_stream.write_all(unauthorized.as_bytes()).await;
        return Ok(());
    };

    let is_upgrade = parsed
        .headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
    let is_mutation = !matches!(parsed.method.as_str(), "GET" | "HEAD" | "OPTIONS");
    if (is_upgrade || is_mutation) && validate_same_origin_request(&parsed.headers, true).is_err() {
        let resp = build_json_error_response("403 Forbidden", "Cross-origin request rejected.");
        let _ = client_stream.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    let mut upstream = match TcpStream::connect(("127.0.0.1", local_port)).await {
        Ok(s) => s,
        Err(err) => {
            let resp = build_json_error_response(
                "502 Bad Gateway",
                &format!("Forwarded port unavailable: {err}"),
            );
            let _ = client_stream.write_all(resp.as_bytes()).await;
            return Ok(());
        }
    };
    let forward_header = build_forwarded_request_header(
        &parsed.method,
        &parsed.target,
        local_port,
        &parsed.headers,
        is_upgrade,
    );
    upstream
        .write_all(forward_header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if filled > parsed.header_end {
        upstream
            .write_all(&buf[parsed.header_end..filled])
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut client_stream, &mut upstream) => {}
        _ = revoke_rx.changed() => {}
        _ = proxy_stop_rx.changed() => {}
        _ = relay_stop_rx.changed() => {}
    }
    Ok(())
}

fn extract_query_param(target: &str, param_name: &str) -> Option<String> {
    let (_, query) = target.split_once('?')?;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == param_name {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn friendly_device_label(user_agent: Option<&str>, ip: &str) -> String {
    let ua = user_agent.unwrap_or_default();
    let device = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows"
    } else {
        "Browser"
    };
    format!("{device} ({ip})")
}

fn issue_relay_session(
    inner: &Arc<Mutex<RelayInner>>,
    provided_token: &str,
    remote_addr: SocketAddr,
    user_agent: Option<String>,
) -> Option<String> {
    let clean_token = provided_token.trim().to_uppercase();
    let mut guard = inner.lock().ok()?;
    let expected = guard.pairing_token.to_uppercase();
    if clean_token.is_empty() || !constant_time_eq(clean_token.as_bytes(), expected.as_bytes()) {
        return None;
    }

    if guard.sessions.len() >= MAX_LAN_RELAY_SESSIONS {
        if let Some(oldest_id) = guard
            .sessions
            .values()
            .min_by(|a, b| a.info.last_seen_at.cmp(&b.info.last_seen_at))
            .map(|s| s.info.session_id.clone())
        {
            if let Some(removed) = guard.sessions.remove(&oldest_id) {
                let _ = removed.revoke_tx.send(true);
            }
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let secret = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let now = now_iso8601();
    let remote_ip = remote_addr.ip().to_string();
    let label = friendly_device_label(user_agent.as_deref(), &remote_ip);
    let (revoke_tx, _) = watch::channel(false);

    guard.sessions.insert(
        session_id.clone(),
        StoredRelaySession {
            info: DesktopLanRelayClientSession {
                session_id,
                label,
                remote_address: remote_ip,
                user_agent,
                created_at: now.clone(),
                last_seen_at: now,
            },
            secret: secret.clone(),
            revoke_tx,
        },
    );
    Some(secret)
}

fn validate_relay_session(
    inner: &Arc<Mutex<RelayInner>>,
    secret: &str,
) -> Option<watch::Receiver<bool>> {
    let mut guard = inner.lock().ok()?;
    for session in guard.sessions.values_mut() {
        if constant_time_eq(session.secret.as_bytes(), secret.as_bytes()) {
            session.info.last_seen_at = now_iso8601();
            return Some(session.revoke_tx.subscribe());
        }
    }
    None
}

fn append_auth_token_to_target(target: &str, token: &str) -> String {
    let Some((path, query)) = target.split_once('?') else {
        return format!("{target}?token={token}");
    };
    let mut kept_params: Vec<&str> = query
        .split('&')
        .filter(|pair| {
            !pair.is_empty()
                && pair
                    .split_once('=')
                    .map(|(k, _)| k != "token")
                    .unwrap_or(pair != &"token")
        })
        .collect();
    let token_pair = format!("token={token}");
    kept_params.push(&token_pair);
    format!("{path}?{}", kept_params.join("&"))
}

fn append_remote_ssh_auth_params(target: &str, token: &str, client_id: &str) -> String {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    let mut kept_params: Vec<&str> = query
        .map(|q| {
            q.split('&')
                .filter(|pair| {
                    !pair.is_empty()
                        && pair
                            .split_once('=')
                            .map(|(k, _)| k != "token" && k != "client")
                            .unwrap_or(*pair != "token" && *pair != "client")
                })
                .collect()
        })
        .unwrap_or_default();
    let token_pair = format!("token={token}");
    let client_pair = format!("client={client_id}");
    kept_params.push(&token_pair);
    kept_params.push(&client_pair);
    format!("{path}?{}", kept_params.join("&"))
}

fn strip_prefix_preserving_query(target: &str, prefix: &str) -> String {
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (target, None),
    };
    let rest = path.strip_prefix(prefix).unwrap_or(path);
    let normalized = if rest.is_empty() {
        "/".to_string()
    } else if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{rest}")
    };
    match query {
        Some(q) if !q.is_empty() => format!("{normalized}?{q}"),
        _ => normalized,
    }
}

fn is_valid_host_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && segment != "."
        && segment != ".."
}

fn build_json_response(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nX-Saint-Lan-Relay: 1\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn build_json_error_response(status: &str, message: &str) -> String {
    let body = serde_json::json!({ "error": message }).to_string();
    build_json_response(status, &body)
}

async fn read_request_body(
    client_stream: &mut TcpStream,
    parsed: &ParsedHttpHeader,
    initial_buf: &[u8],
    revoke_rx: &mut watch::Receiver<bool>,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<Vec<u8>, String> {
    let content_length = parsed
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_CONTROL_API_BODY_BYTES {
        return Err("Request body too large.".to_string());
    }
    let already = &initial_buf[parsed.header_end..];
    if already.len() >= content_length {
        return Ok(already[..content_length].to_vec());
    }
    let mut body = Vec::with_capacity(content_length);
    body.extend_from_slice(already);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        let to_read = (content_length - body.len()).min(chunk.len());
        let read_res = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                return Err("Timed out reading request body.".to_string());
            }
            _ = revoke_rx.changed() => {
                return Err("Session revoked.".to_string());
            }
            _ = stop_rx.changed() => {
                return Err("Relay stopped.".to_string());
            }
            res = client_stream.read(&mut chunk[..to_read]) => res,
        };
        let n = read_res.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Unexpected EOF while reading request body.".to_string());
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(body)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSshHostOnlyInput {
    host: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSshForwardPortInput {
    host: String,
    remote_port: u16,
}

async fn handle_remote_ssh_route(
    client_stream: &mut TcpStream,
    parsed: &ParsedHttpHeader,
    path_only: &str,
    initial_buf: &[u8],
    is_upgrade: bool,
    relay_local_ip: IpAddr,
    inner: &Arc<Mutex<RelayInner>>,
    remote_ssh: Arc<RemoteSshManager>,
    revoke_rx: &mut watch::Receiver<bool>,
    stop_rx: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    // 1. Reverse proxy HTTP/WebSocket traffic to a connected remote SSH server:
    //    `/api/remote-ssh/proxy/<hostKey>` or `/api/remote-ssh/proxy/<hostKey>/...`
    if let Some(rest) = path_only.strip_prefix("/api/remote-ssh/proxy/") {
        let host_key = rest.split('/').next().unwrap_or("");
        if !is_valid_host_key_segment(host_key) {
            let resp = build_json_error_response("400 Bad Request", "Invalid remote host key.");
            let _ = client_stream.write_all(resp.as_bytes()).await;
            return Ok(());
        }
        let Some((local_port, remote_token, client_id)) =
            remote_ssh.proxy_target_for_host_key(host_key)
        else {
            let resp = build_json_error_response(
                "503 Service Unavailable",
                "Remote SSH host is not connected.",
            );
            let _ = client_stream.write_all(resp.as_bytes()).await;
            return Ok(());
        };
        let prefix = format!("/api/remote-ssh/proxy/{host_key}");
        let stripped = strip_prefix_preserving_query(&parsed.target, &prefix);
        let rewritten_target =
            append_remote_ssh_auth_params(&stripped, &remote_token, &client_id);
        let mut upstream = match TcpStream::connect(("127.0.0.1", local_port)).await {
            Ok(s) => s,
            Err(err) => {
                let resp = build_json_error_response(
                    "502 Bad Gateway",
                    &format!("Remote SSH tunnel unavailable: {err}"),
                );
                let _ = client_stream.write_all(resp.as_bytes()).await;
                return Ok(());
            }
        };
        let forward_header = build_forwarded_request_header(
            &parsed.method,
            &rewritten_target,
            local_port,
            &parsed.headers,
            is_upgrade,
        );
        upstream
            .write_all(forward_header.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        if initial_buf.len() > parsed.header_end {
            upstream
                .write_all(&initial_buf[parsed.header_end..])
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::select! {
            _ = tokio::io::copy_bidirectional(client_stream, &mut upstream) => {}
            _ = revoke_rx.changed() => {}
            _ = stop_rx.changed() => {}
        }
        return Ok(());
    }

    // 2. Same-origin forwarded dev-server path is disabled to prevent untrusted dev-server JS
    //    from running in Saint LAN Relay's origin. Forwarded ports use dedicated isolated ports
    //    returned by `POST /api/remote-ssh/forward-port`.
    if path_only.starts_with("/api/remote-ssh/forward/") {
        let resp = build_json_error_response(
            "410 Gone",
            "Forwarded dev servers are served on dedicated isolated ports via POST /api/remote-ssh/forward-port.",
        );
        let _ = client_stream.write_all(resp.as_bytes()).await;
        return Ok(());
    }

    // 3. Control API & SSE event stream for Remote SSH hosts (full desktop parity)
    if parsed.method == "POST" && !has_json_content_type(&parsed.headers) {
        let resp = build_json_error_response(
            "415 Unsupported Media Type",
            "Content-Type: application/json is required.",
        );
        let _ = client_stream.write_all(resp.as_bytes()).await;
        return Ok(());
    }
    match (parsed.method.as_str(), path_only) {
        ("GET", "/api/remote-ssh/state") => {
            let remote_ssh_clone = Arc::clone(&remote_ssh);
            let state = tokio::task::spawn_blocking(move || remote_ssh_clone.get_state())
                .await
                .map_err(|e| e.to_string())?;
            let body = serde_json::to_string(&state).map_err(|e| e.to_string())?;
            let resp = build_json_response("200 OK", &body);
            client_stream
                .write_all(resp.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        ("GET", "/api/remote-ssh/events") => {
            let mut rx = remote_ssh.subscribe_state_changes();
            let headers = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\nX-Saint-Lan-Relay: 1\r\n\r\n";
            client_stream
                .write_all(headers.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            let remote_ssh_init = Arc::clone(&remote_ssh);
            let initial_state = tokio::task::spawn_blocking(move || remote_ssh_init.get_state())
                .await
                .map_err(|e| e.to_string())?;
            let initial = serde_json::to_string(&initial_state).unwrap_or_default();
            let mut last_payload = initial.clone();
            client_stream
                .write_all(format!("data: {initial}\n\n").as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(20));
            keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            keepalive.tick().await;
            loop {
                tokio::select! {
                    _ = revoke_rx.changed() => break,
                    _ = stop_rx.changed() => break,
                    _ = keepalive.tick() => {
                        if client_stream.write_all(b": ping\n\n").await.is_err() {
                            break;
                        }
                    }
                    msg = rx.recv() => {
                        match msg {
                            Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                while matches!(
                                    rx.try_recv(),
                                    Ok(())
                                        | Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_))
                                ) {}
                                let remote_ssh_next = Arc::clone(&remote_ssh);
                                let Ok(next_state) =
                                    tokio::task::spawn_blocking(move || remote_ssh_next.get_state())
                                        .await
                                else {
                                    continue;
                                };
                                let payload = serde_json::to_string(&next_state).unwrap_or_default();
                                if payload == last_payload {
                                    continue;
                                }
                                last_payload = payload.clone();
                                if client_stream.write_all(format!("data: {payload}\n\n").as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
            Ok(())
        }
        ("POST", "/api/remote-ssh/connect") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let host: DesktopRemoteSshSavedHost = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let result = tokio::task::spawn_blocking(move || remote_ssh.connect(host))
                .await
                .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(host_state) => {
                    let json = serde_json::to_string(&host_state).map_err(|e| e.to_string())?;
                    build_json_response("200 OK", &json)
                }
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/disconnect") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let input: RemoteSshHostOnlyInput = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let result = tokio::task::spawn_blocking(move || remote_ssh.disconnect(&input.host))
                .await
                .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(()) => build_json_response("200 OK", "{}"),
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/stop-server") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let host: DesktopRemoteSshSavedHost = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let result = tokio::task::spawn_blocking(move || remote_ssh.stop_server(host))
                .await
                .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(()) => build_json_response("200 OK", "{}"),
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/forget") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let input: RemoteSshHostOnlyInput = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let _ = tokio::task::spawn_blocking(move || remote_ssh.forget_host(&input.host))
                .await
                .map_err(|e| e.to_string())?;
            let resp = build_json_response("200 OK", "{}");
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/test-host") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let host: DesktopRemoteSshSavedHost = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let result = tokio::task::spawn_blocking(move || remote_ssh.test_host(host))
                .await
                .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(test_result) => {
                    let json = serde_json::to_string(&test_result).map_err(|e| e.to_string())?;
                    build_json_response("200 OK", &json)
                }
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/update-host") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let input: DesktopRemoteSshUpdateHostInput = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let result = tokio::task::spawn_blocking(move || remote_ssh.update_host(input))
                .await
                .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(state) => {
                    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
                    build_json_response("200 OK", &json)
                }
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/ws-url") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let input: RemoteSshHostOnlyInput = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let proxy_path = if remote_ssh.ws_url_for_host(&input.host).is_some() {
                remote_ssh
                    .host_key_for_host(&input.host)
                    .filter(|key| is_valid_host_key_segment(key))
                    .map(|key| format!("/api/remote-ssh/proxy/{key}/"))
            } else {
                None
            };
            let json = serde_json::json!({ "proxyPath": proxy_path }).to_string();
            let resp = build_json_response("200 OK", &json);
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        ("POST", "/api/remote-ssh/forward-port") => {
            let body = read_request_body(client_stream, parsed, initial_buf, revoke_rx, stop_rx).await?;
            let input: RemoteSshForwardPortInput = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(err) => {
                    let resp = build_json_error_response("400 Bad Request", &err.to_string());
                    let _ = client_stream.write_all(resp.as_bytes()).await;
                    return Ok(());
                }
            };
            let remote_ssh_clone = Arc::clone(&remote_ssh);
            let host_clone = input.host.clone();
            let remote_port = input.remote_port;
            let result = tokio::task::spawn_blocking(move || {
                remote_ssh_clone.forward_port(&host_clone, remote_port)
            })
            .await
            .map_err(|e| e.to_string())?;
            let resp = match result {
                Ok(_) => match remote_ssh
                    .host_key_for_host(&input.host)
                    .filter(|key| is_valid_host_key_segment(key))
                {
                    Some(key) => {
                        let Some(local_port) =
                            remote_ssh.forwarded_port_local_port(&key, remote_port)
                        else {
                            let resp = build_json_error_response(
                                "503 Service Unavailable",
                                "Forwarded remote port is not active.",
                            );
                            let _ = client_stream.write_all(resp.as_bytes()).await;
                            return Ok(());
                        };
                        match ensure_isolated_forward_listener(
                            inner,
                            relay_local_ip,
                            &key,
                            remote_port,
                            local_port,
                            stop_rx,
                        )
                        .await
                        {
                            Ok(url) => {
                                let json = serde_json::json!({ "url": url }).to_string();
                                build_json_response("200 OK", &json)
                            }
                            Err(err) => build_json_error_response("500 Internal Server Error", &err),
                        }
                    }
                    None => build_json_error_response(
                        "500 Internal Server Error",
                        "Remote host key unavailable.",
                    ),
                },
                Err(err) => build_json_error_response("400 Bad Request", &err),
            };
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
        _ => {
            let resp = build_json_error_response("404 Not Found", "Unknown remote SSH route.");
            let _ = client_stream.write_all(resp.as_bytes()).await;
            Ok(())
        }
    }
}

async fn handle_relay_connection(
    mut client_stream: TcpStream,
    remote_addr: SocketAddr,
    relay_local_ip: IpAddr,
    inner: Arc<Mutex<RelayInner>>,
    backend: Arc<BackendSupervisor>,
    remote_ssh: Arc<RemoteSshManager>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let mut buf = vec![0u8; 16384];
    let mut filled = 0usize;
    let header_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);

    let parsed = loop {
        if filled >= buf.len() {
            return Err("Header too large".to_string());
        }
        let read_res = tokio::select! {
            _ = tokio::time::sleep_until(header_deadline) => {
                return Err("Timed out reading HTTP header".to_string());
            }
            _ = stop_rx.changed() => {
                return Ok(());
            }
            res = client_stream.read(&mut buf[filled..]) => res,
        };
        let n = read_res.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        // 0x16 opens a TLS handshake: the browser upgraded the link to https.
        // Close at once so it falls back to http instead of waiting out the timeout.
        if filled == 0 && buf[0] == 0x16 {
            return Err("TLS handshake on the plain-HTTP relay (browser upgraded to https://); open the http:// link".to_string());
        }
        filled += n;
        if let Some(p) = parse_http_header(&buf[..filled]) {
            break p;
        }
    };

    let path_only = parsed
        .target
        .split('?')
        .next()
        .unwrap_or(parsed.target.as_str());
    let user_agent = parsed
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
        .map(|(_, v)| v.clone());

    // 1. Handle `/pair` route (`POST /pair` exchanges token; `GET /pair` renders pairing page
    //    and scrubs legacy `?token=` URLs without authenticating on GET).
    if path_only == "/pair" {
        if parsed.method == "POST" {
            if let Err(reason) = validate_same_origin_request(&parsed.headers, true) {
                let resp = build_json_error_response("403 Forbidden", reason);
                let _ = client_stream.write_all(resp.as_bytes()).await;
                return Ok(());
            }
            if is_pair_rate_limited(&inner, remote_addr.ip()) {
                let html = pairing_html_page(Some(
                    "Too many failed pairing attempts. Wait a few minutes before retrying.",
                ));
                let response = format!(
                    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\nRetry-After: {}\r\nContent-Length: {}\r\n\r\n{}",
                    PAIR_RATE_LIMIT_WINDOW.as_secs(),
                    html.len(),
                    html
                );
                let _ = client_stream.write_all(response.as_bytes()).await;
                return Ok(());
            }
            let (_dummy_tx, mut dummy_revoke_rx) = watch::channel(false);
            let body = read_request_body(
                &mut client_stream,
                &parsed,
                &buf[..filled],
                &mut dummy_revoke_rx,
                &mut stop_rx,
            )
            .await?;
            let token = extract_form_param(&body, "token").unwrap_or_default();
            if let Some(session_secret) =
                issue_relay_session(&inner, &token, remote_addr, user_agent)
            {
                clear_pair_failures(&inner, remote_addr.ip());
                let response = format!(
                    "HTTP/1.1 302 Found\r\nLocation: /\r\nSet-Cookie: {LAN_SESSION_COOKIE_NAME}={session_secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000\r\nSet-Cookie: {LAN_RELAY_CAPABILITY_COOKIE_NAME}=1; SameSite=Lax; Path=/; Max-Age=2592000\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\nContent-Length: 0\r\n\r\n"
                );
                let _ = client_stream.write_all(response.as_bytes()).await;
                return Ok(());
            }
            record_pair_failure(&inner, remote_addr.ip());
            let html = pairing_html_page(Some(
                "Invalid or expired pairing code. Check Settings in Saint Desktop.",
            ));
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\nContent-Length: {}\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = client_stream.write_all(response.as_bytes()).await;
            return Ok(());
        }

        if extract_query_param(&parsed.target, "token").is_some() {
            let redirect = "HTTP/1.1 302 Found\r\nLocation: /pair\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\n\r\n";
            let _ = client_stream.write_all(redirect.as_bytes()).await;
            return Ok(());
        }

        // Use `same-origin` rather than `no-referrer`: under Fetch, a document with
        // `Referrer-Policy: no-referrer` sends `Origin: null` on same-origin `<form method="POST">`
        // submissions, which `validate_same_origin_request` rejects as an invalid Origin.
        let html = pairing_html_page(None);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: same-origin\r\nContent-Length: {}\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = client_stream.write_all(response.as_bytes()).await;
        return Ok(());
    }

    // 2. Check session cookie
    let session_rx = extract_cookie_value(&parsed.headers, LAN_SESSION_COOKIE_NAME)
        .and_then(|secret| validate_relay_session(&inner, &secret));

    let Some(mut revoke_rx) = session_rx else {
        let is_upgrade = parsed
            .headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
        if !is_upgrade
            && parsed.method == "GET"
            && (path_only == "/" || !path_only.starts_with("/api/"))
        {
            let redirect = "HTTP/1.1 302 Found\r\nLocation: /pair\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n";
            let _ = client_stream.write_all(redirect.as_bytes()).await;
        } else {
            let unauthorized = build_unauthorized_json_response();
            let _ = client_stream.write_all(unauthorized.as_bytes()).await;
        }
        return Ok(());
    };

    // 3. Enforce exact same-origin on WebSocket upgrades and state-changing HTTP requests so
    //    neither cross-site pages nor same-host/different-port services can hijack the relay
    //    session (SameSite=Lax is port-agnostic).
    let is_upgrade = parsed
        .headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
    let is_state_changing = !matches!(parsed.method.as_str(), "GET" | "HEAD" | "OPTIONS");
    if is_upgrade || is_state_changing {
        if let Err(reason) = validate_same_origin_request(&parsed.headers, true) {
            let resp = build_json_error_response("403 Forbidden", reason);
            let _ = client_stream.write_all(resp.as_bytes()).await;
            return Ok(());
        }
    }

    // 4. Authenticated: handle Remote SSH control API + reverse-proxy routes before local backend
    if path_only.starts_with("/api/remote-ssh/") {
        return handle_remote_ssh_route(
            &mut client_stream,
            &parsed,
            path_only,
            &buf[..filled],
            is_upgrade,
            relay_local_ip,
            &inner,
            remote_ssh,
            &mut revoke_rx,
            &mut stop_rx,
        )
        .await;
    }

    // 4. Authenticated: proxy to local `saint-server` (or Vite dev server for web assets in dev)
    let backend_port = backend.port();
    let backend_token = backend.auth_token();
    let is_backend_route = is_upgrade
        || path_only.starts_with("/api/")
        || path_only == "/ws"
        || path_only.starts_with("/ws/")
        || path_only.starts_with("/attachments/")
        || path_only == "/health";

    // Dev builds: Vite serves ~1,400 separate modules, each a new relay
    // connection; over Tailscale the phone sits on the boot logo for minutes.
    // Serve the production web build instead when one exists.
    if cfg!(debug_assertions)
        && !is_backend_route
        && (parsed.method == "GET" || parsed.method == "HEAD")
    {
        if let Some(dist) = dev_web_dist() {
            let response = static_file_response(&dist, path_only, parsed.method == "HEAD");
            client_stream
                .write_all(&response)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    let (mut upstream, upstream_port, rewritten_target) =
        if !is_backend_route && cfg!(debug_assertions) {
            let dev_port = dev_web_port();
            if let Ok(vite_stream) = TcpStream::connect(("127.0.0.1", dev_port)).await {
                (vite_stream, dev_port, parsed.target.clone())
            } else {
                let s = TcpStream::connect(("127.0.0.1", backend_port))
                    .await
                    .map_err(|e| e.to_string())?;
                (
                    s,
                    backend_port,
                    append_auth_token_to_target(&parsed.target, backend_token),
                )
            }
        } else {
            let s = TcpStream::connect(("127.0.0.1", backend_port))
                .await
                .map_err(|e| e.to_string())?;
            (
                s,
                backend_port,
                append_auth_token_to_target(&parsed.target, backend_token),
            )
        };

    // Rewrite request line and Host/Origin headers so loopback guards on `saint-server` succeed
    let forward_header = build_forwarded_request_header(
        &parsed.method,
        &rewritten_target,
        upstream_port,
        &parsed.headers,
        is_upgrade,
    );

    upstream
        .write_all(forward_header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if filled > parsed.header_end {
        upstream
            .write_all(&buf[parsed.header_end..filled])
            .await
            .map_err(|e| e.to_string())?;
    }

    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut client_stream, &mut upstream) => {}
        _ = revoke_rx.changed() => {}
        _ = stop_rx.changed() => {}
    }

    Ok(())
}

/// Port of the Vite dev server the webview uses. The dev runner shifts it off
/// 5733 when another instance runs, so a fixed port reached the wrong server.
fn dev_web_port() -> u16 {
    std::env::var("VITE_DEV_SERVER_URL")
        .ok()
        .and_then(|url| {
            url.trim()
                .trim_end_matches('/')
                .rsplit(':')
                .next()?
                .parse()
                .ok()
        })
        .unwrap_or(5733)
}

/// `apps/web/dist` of this checkout when it has been built (dev builds only).
fn dev_web_dist() -> Option<std::path::PathBuf> {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    dist.join("index.html").is_file().then_some(dist)
}

/// A complete HTTP response for `path` under `root`; unknown paths get
/// `index.html` so client-side routes load the app.
fn static_file_response(root: &std::path::Path, path: &str, head_only: bool) -> Vec<u8> {
    let relative = path.trim_start_matches('/');
    let safe = !relative
        .split('/')
        .any(|part| part == ".." || part.contains('\\'));
    let candidate = root.join(relative);
    let (file, body) = match (safe && !relative.is_empty())
        .then(|| std::fs::read(&candidate).ok())
        .flatten()
    {
        Some(body) => (candidate, body),
        None => {
            let index = root.join("index.html");
            match std::fs::read(&index) {
                Ok(body) => (index, body),
                Err(_) => return b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
            }
        }
    };
    let content_type = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    };
    // Hashed assets never change; the HTML shell must be refetched.
    let cache = if relative.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    if !head_only {
        out.extend_from_slice(&body);
    }
    out
}

fn build_unauthorized_json_response() -> String {
    const BODY: &str = "{\"error\":\"LAN pairing required.\"}";
    format!(
        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        BODY.len(),
        BODY
    )
}

fn build_forwarded_request_header(
    method: &str,
    rewritten_target: &str,
    upstream_port: u16,
    headers: &[(String, String)],
    is_upgrade: bool,
) -> String {
    let mut forward_header = format!("{method} {rewritten_target} HTTP/1.1\r\n");
    forward_header.push_str(&format!("Host: 127.0.0.1:{upstream_port}\r\n"));
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("host") {
            continue;
        }
        if !is_upgrade && k.eq_ignore_ascii_case("connection") {
            continue;
        }
        if k.eq_ignore_ascii_case("origin") {
            forward_header.push_str(&format!("Origin: http://127.0.0.1:{upstream_port}\r\n"));
            continue;
        }
        if k.eq_ignore_ascii_case("cookie") {
            let filtered_cookies: Vec<&str> = v
                .split(';')
                .map(str::trim)
                .filter(|pair| {
                    !pair.is_empty()
                        && pair
                            .split_once('=')
                            .map(|(name, _)| {
                                let trimmed = name.trim();
                                trimmed != LAN_SESSION_COOKIE_NAME
                                    && trimmed != LAN_RELAY_CAPABILITY_COOKIE_NAME
                            })
                            .unwrap_or(true)
                })
                .collect();
            if !filtered_cookies.is_empty() {
                forward_header.push_str(&format!("Cookie: {}\r\n", filtered_cookies.join("; ")));
            }
            continue;
        }
        forward_header.push_str(&format!("{k}: {v}\r\n"));
    }
    if !is_upgrade {
        forward_header.push_str("Connection: close\r\n");
    }
    forward_header.push_str("\r\n");
    forward_header
}

fn pairing_html_page(error_msg: Option<&str>) -> String {
    let error_block = error_msg
        .map(|msg| format!("<p style=\"color:#f87171;font-size:14px;margin:0 0 14px;\">{msg}</p>"))
        .unwrap_or_default();
    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Saint Mobile &amp; LAN Pairing</title>
<style>
  body {{ background:#0b0d12; color:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:16px; box-sizing:border-box; }}
  .card {{ background:#131722; border:1px solid #262c3d; border-radius:14px; max-width:380px; width:100%; padding:24px; box-shadow:0 16px 40px rgba(0,0,0,0.45); }}
  h1 {{ font-size:18px; margin:0 0 8px; font-weight:600; }}
  p {{ font-size:14px; color:#9ca3af; margin:0 0 16px; line-height:1.45; }}
  input {{ width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid #32394e; background:#0b0d12; color:#f9fafb; font-size:16px; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:12px; }}
  button {{ width:100%; padding:10px 14px; border-radius:8px; border:none; background:#3b82f6; color:#fff; font-weight:600; font-size:15px; cursor:pointer; }}
</style>
<script>
  window.addEventListener("DOMContentLoaded", function () {{
    if (window.location.hash && window.location.hash.indexOf("token=") !== -1) {{
      var raw = window.location.hash.slice(1).split("&").find(function (part) {{
        return part.indexOf("token=") === 0;
      }});
      var token = raw ? decodeURIComponent(raw.slice(6)) : "";
      if (window.history && window.history.replaceState) {{
        window.history.replaceState(null, "", "/pair");
      }}
      if (token) {{
        var input = document.getElementById("pair-token");
        var form = document.getElementById("pair-form");
        if (input && form) {{
          input.value = token;
          form.submit();
        }}
      }}
    }}
  }});
</script>
</head>
<body>
  <form id="pair-form" class="card" method="POST" action="/pair">
    <h1>Pair with Saint Desktop</h1>
    <p>Scan the QR code in Saint Settings &rarr; Remote Hosts, or enter the 12-character pairing code below.</p>
    {error_block}
    <input id="pair-token" type="text" name="token" placeholder="PAIRING CODE" required autocomplete="off" autocapitalize="characters" />
    <button type="submit">Connect Device</button>
  </form>
</body>
</html>"##
    )
}

// ============================================================================
// Pure-Rust ISO/IEC 18004 QR Code SVG Generator (Byte Mode, ECC Level L, V1..V6)
// ============================================================================

struct QrVersionSpec {
    size: usize,
    total_data_codewords: usize,
    ec_codewords_per_block: usize,
    num_blocks: usize,
    alignment_centers: &'static [usize],
}

const QR_SPECS: &[QrVersionSpec] = &[
    QrVersionSpec {
        size: 21,
        total_data_codewords: 19,
        ec_codewords_per_block: 7,
        num_blocks: 1,
        alignment_centers: &[],
    },
    QrVersionSpec {
        size: 25,
        total_data_codewords: 34,
        ec_codewords_per_block: 10,
        num_blocks: 1,
        alignment_centers: &[6, 18],
    },
    QrVersionSpec {
        size: 29,
        total_data_codewords: 55,
        ec_codewords_per_block: 15,
        num_blocks: 1,
        alignment_centers: &[6, 22],
    },
    QrVersionSpec {
        size: 33,
        total_data_codewords: 80,
        ec_codewords_per_block: 20,
        num_blocks: 1,
        alignment_centers: &[6, 26],
    },
    QrVersionSpec {
        size: 37,
        total_data_codewords: 108,
        ec_codewords_per_block: 26,
        num_blocks: 1,
        alignment_centers: &[6, 30],
    },
    QrVersionSpec {
        size: 41,
        total_data_codewords: 136,
        ec_codewords_per_block: 18,
        num_blocks: 2,
        alignment_centers: &[6, 34],
    },
];

fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    for _ in 0..8 {
        if (b & 1) != 0 {
            p ^= a;
        }
        let hi = (a & 0x80) != 0;
        a <<= 1;
        if hi {
            a ^= 0x1D;
        }
        b >>= 1;
    }
    p
}

fn rs_generator_poly(degree: usize) -> Vec<u8> {
    let mut poly = vec![1u8];
    let mut root = 1u8;
    for _ in 0..degree {
        let mut next = vec![0u8; poly.len() + 1];
        for (i, &c) in poly.iter().enumerate() {
            next[i] ^= c;
            next[i + 1] ^= gf_mul(c, root);
        }
        poly = next;
        root = gf_mul(root, 2);
    }
    poly
}

fn rs_compute_remainder(data: &[u8], ec_len: usize) -> Vec<u8> {
    let gen = rs_generator_poly(ec_len);
    let mut rem = vec![0u8; ec_len];
    for &b in data {
        let factor = b ^ rem[0];
        rem.remove(0);
        rem.push(0);
        for i in 0..ec_len {
            rem[i] ^= gf_mul(gen[i + 1], factor);
        }
    }
    rem
}

pub fn render_qr_svg(payload: &str, border: usize) -> Option<String> {
    let bytes = payload.as_bytes();
    let spec = QR_SPECS
        .iter()
        .find(|s| bytes.len() + 3 <= s.total_data_codewords)?;

    // Encode Byte mode bit stream
    let mut bits = Vec::with_capacity(spec.total_data_codewords * 8);
    let push_bits = |bits: &mut Vec<bool>, val: usize, count: usize| {
        for i in (0..count).rev() {
            bits.push(((val >> i) & 1) != 0);
        }
    };
    push_bits(&mut bits, 0b0100, 4); // Byte mode
    push_bits(&mut bits, bytes.len(), 8);
    for &b in bytes {
        push_bits(&mut bits, b as usize, 8);
    }
    let max_bits = spec.total_data_codewords * 8;
    let terminator = (max_bits - bits.len()).min(4);
    push_bits(&mut bits, 0, terminator);
    while bits.len() % 8 != 0 {
        bits.push(false);
    }
    let mut data_codewords = Vec::with_capacity(spec.total_data_codewords);
    for chunk in bits.chunks(8) {
        let mut byte = 0u8;
        for &bit in chunk {
            byte = (byte << 1) | u8::from(bit);
        }
        data_codewords.push(byte);
    }
    let pad_bytes = [0xECu8, 0x11u8];
    let mut pad_idx = 0;
    while data_codewords.len() < spec.total_data_codewords {
        data_codewords.push(pad_bytes[pad_idx % 2]);
        pad_idx += 1;
    }

    // Split into blocks and compute Reed-Solomon EC codewords
    let block_data_len = spec.total_data_codewords / spec.num_blocks;
    let mut data_blocks = Vec::new();
    let mut ec_blocks = Vec::new();
    for b in 0..spec.num_blocks {
        let slice = &data_codewords[b * block_data_len..(b + 1) * block_data_len];
        data_blocks.push(slice.to_vec());
        ec_blocks.push(rs_compute_remainder(slice, spec.ec_codewords_per_block));
    }

    let mut interleaved = Vec::new();
    for i in 0..block_data_len {
        for b in 0..spec.num_blocks {
            interleaved.push(data_blocks[b][i]);
        }
    }
    for i in 0..spec.ec_codewords_per_block {
        for b in 0..spec.num_blocks {
            interleaved.push(ec_blocks[b][i]);
        }
    }

    // Build matrix
    let n = spec.size;
    let mut modules = vec![vec![false; n]; n];
    let mut is_function = vec![vec![false; n]; n];

    let mut set_func = |r: usize, c: usize, val: bool| {
        modules[r][c] = val;
        is_function[r][c] = true;
    };

    // Finder patterns + separators
    for &(fr, fc) in &[(0usize, 0usize), (0, n - 7), (n - 7, 0)] {
        for dr in 0..7 {
            for dc in 0..7 {
                let border_7 = dr == 0 || dr == 6 || dc == 0 || dc == 6;
                let inner_3 = (2..=4).contains(&dr) && (2..=4).contains(&dc);
                set_func(fr + dr, fc + dc, border_7 || inner_3);
            }
        }
        for i in 0..8 {
            if fr + 7 < n && fc + i < n {
                set_func(fr + 7, fc + i, false);
            }
            if fr > 0 && fc + i < n {
                set_func(fr - 1, fc + i, false);
            }
            if fr + i < n && fc + 7 < n {
                set_func(fr + i, fc + 7, false);
            }
            if fr + i < n && fc > 0 {
                set_func(fr + i, fc - 1, false);
            }
        }
    }

    // Timing patterns
    for i in 8..n - 8 {
        set_func(6, i, i % 2 == 0);
        set_func(i, 6, i % 2 == 0);
    }

    // Alignment patterns
    for &ar in spec.alignment_centers {
        for &ac in spec.alignment_centers {
            if (ar < 9 && ac < 9) || (ar < 9 && ac > n - 10) || (ar > n - 10 && ac < 9) {
                continue;
            }
            for dr in 0..5 {
                for dc in 0..5 {
                    let edge = dr == 0 || dr == 4 || dc == 0 || dc == 4;
                    let center = dr == 2 && dc == 2;
                    set_func(ar - 2 + dr, ac - 2 + dc, edge || center);
                }
            }
        }
    }

    // Reserve format info areas & dark module
    set_func(n - 8, 8, true);
    for i in 0..9 {
        if i != 6 {
            is_function[8][i] = true;
            is_function[i][8] = true;
        }
    }
    for i in 0..8 {
        is_function[8][n - 1 - i] = true;
        is_function[n - 1 - i][8] = true;
    }

    // Place data bits in zigzag
    let mut bit_idx = 0usize;
    let total_bits = interleaved.len() * 8;
    let mut right = (n - 1) as isize;
    let mut upward = true;
    while right >= 1 {
        if right == 6 {
            right -= 1;
        }
        for step in 0..n {
            let r = if upward { n - 1 - step } else { step };
            for dc in 0..2 {
                let c = (right - dc) as usize;
                if !is_function[r][c] {
                    let bit = if bit_idx < total_bits {
                        ((interleaved[bit_idx / 8] >> (7 - (bit_idx % 8))) & 1) != 0
                    } else {
                        false
                    };
                    // Mask pattern 0: (r + c) % 2 == 0
                    modules[r][c] = bit ^ ((r + c) % 2 == 0);
                    bit_idx += 1;
                }
            }
        }
        upward = !upward;
        right -= 2;
    }

    // Format information for ECC Level L (01) + Mask 0 (000) => 0x77C4.
    // Bit i goes to the positions ISO/IEC 18004 fixes for it (row, column).
    let format_bits: u16 = 0x77C4;
    let bit = |i: usize| ((format_bits >> i) & 1) != 0;
    for i in 0..6 {
        modules[i][8] = bit(i);
    }
    modules[7][8] = bit(6);
    modules[8][8] = bit(7);
    modules[8][7] = bit(8);
    for i in 9..15 {
        modules[8][14 - i] = bit(i);
    }
    for i in 0..8 {
        modules[8][n - 1 - i] = bit(i);
    }
    for i in 8..15 {
        modules[n - 15 + i][8] = bit(i);
    }

    // Render SVG path
    let dim = n + border * 2;
    let mut path_data = String::new();
    for (r, row) in modules.iter().enumerate() {
        for (c, &dark) in row.iter().enumerate() {
            if dark {
                let x = c + border;
                let y = r + border;
                path_data.push_str(&format!("M{x},{y}h1v1h-1z"));
            }
        }
    }

    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/><path d=\"{path_data}\" fill=\"#090d16\"/></svg>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_lan_and_tailscale_ipv4_ranges() {
        assert_eq!(
            classify_ipv4_address(Ipv4Addr::new(192, 168, 1, 42)),
            Some("lan")
        );
        assert_eq!(
            classify_ipv4_address(Ipv4Addr::new(10, 0, 0, 15)),
            Some("lan")
        );
        assert_eq!(
            classify_ipv4_address(Ipv4Addr::new(172, 20, 5, 1)),
            Some("lan")
        );
        assert_eq!(
            classify_ipv4_address(Ipv4Addr::new(100, 101, 102, 103)),
            Some("tailscale")
        );
        assert_eq!(classify_ipv4_address(Ipv4Addr::new(127, 0, 0, 1)), None);
        assert_eq!(classify_ipv4_address(Ipv4Addr::new(169, 254, 1, 1)), None);
    }

    #[test]
    fn parses_interface_names_and_skips_broadcast_addresses() {
        let ip = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever\n\
                  3: wlp0s20f3    inet 192.168.110.133/24 brd 192.168.110.255 scope global\n";
        assert_eq!(
            parse_ip_addr_oneline(ip),
            vec![
                ("lo".to_string(), Ipv4Addr::new(127, 0, 0, 1)),
                ("wlp0s20f3".to_string(), Ipv4Addr::new(192, 168, 110, 133)),
            ]
        );
        let mac = "en0: flags=8863<UP> mtu 1500\n\tinet 10.0.0.7 netmask 0xffffff00 broadcast 10.0.0.255\n";
        assert_eq!(
            parse_ifconfig(mac),
            vec![("en0".to_string(), Ipv4Addr::new(10, 0, 0, 7))]
        );
        let win = "Wireless LAN adapter Wi-Fi:\r\n\r\n   IPv4 Address. . . . . . . . . . . : 192.168.1.20(Preferred)\r\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0\r\n";
        assert_eq!(
            parse_ipconfig(win),
            vec![("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 20))]
        );
        let win_localized = "Ethernet-Adapter Ethernet:\r\n   IPv4-Adresse  . . . . . . . . . . : 10.0.0.42(Bevorzugt)\r\n无线局域网适配器 WLAN：\r\n   IPv4 地址 . . . . . . . . . . . . : 192.168.50.9（首选）\r\n";
        assert_eq!(
            parse_ipconfig(win_localized),
            vec![
                (
                    "Ethernet-Adapter Ethernet".to_string(),
                    Ipv4Addr::new(10, 0, 0, 42)
                ),
                (
                    "无线局域网适配器 WLAN".to_string(),
                    Ipv4Addr::new(192, 168, 50, 9)
                ),
            ]
        );
        let fallback = build_discovered_interfaces(Vec::new(), Some(Ipv4Addr::new(192, 168, 1, 88)));
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].address, "192.168.1.88");
        assert_eq!(fallback[0].kind, "lan");
        assert!(is_virtual_interface_name("docker0"));
        assert!(is_virtual_interface_name("br-1a2b3c"));
        assert!(!is_virtual_interface_name("tailscale0"));
    }

    /// Drives one request through the real relay into a fake backend.
    async fn relay_round_trip(path: &str, paired: bool) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!(
            "saint-relay-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = crate::state::SaintPaths::from_base_dir(root.clone());
        // Bind the fake upstream listener first on port 0 so parallel tests cannot race for an
        // ephemeral port released by BackendSupervisor::new().
        let fake = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake_port = fake.local_addr().unwrap().port();
        let backend = Arc::new(BackendSupervisor::new_with_port(paths.clone(), fake_port));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths));
        tokio::spawn(async move {
            let (mut s, _) = fake.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let first = String::from_utf8_lossy(&buf[..n])
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            let body = format!("upstream saw: {first}");
            let _ = s
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
        });
        let manager = LanRelayManager::new(Arc::clone(&backend), Arc::clone(&remote_ssh));
        let token = manager.get_state().pairing_token;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_stop_tx, stop_rx) = watch::channel(false);
        let inner = Arc::clone(&manager.inner);
        let cookie = if paired {
            let secret = issue_relay_session(&inner, &token, addr, None).unwrap();
            format!("Cookie: {LAN_SESSION_COOKIE_NAME}={secret}\r\n")
        } else {
            String::new()
        };
        tokio::spawn(run_relay_accept_loop(
            listener,
            stop_rx,
            inner,
            backend,
            remote_ssh,
        ));
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: 192.168.1.5:3883\r\n{cookie}\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut out = String::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.read_to_string(&mut out),
        )
        .await;
        let _ = std::fs::remove_dir_all(&root);
        out
    }

    #[test]
    fn prefers_lan_over_a_tailscale_default_route() {
        let iface = |name: &str, address: &str, kind: &str| DesktopLanRelayInterface {
            name: name.to_string(),
            address: address.to_string(),
            kind: kind.to_string(),
        };
        let mut list = vec![
            iface("tailscale0", "100.77.126.10", "tailscale"),
            iface("eth0", "10.0.0.2", "lan"),
            iface("wlan0", "192.168.110.133", "lan"),
        ];
        sort_interfaces(&mut list, Some(Ipv4Addr::new(100, 77, 126, 10)));
        assert_eq!(list[0].kind, "lan");
        sort_interfaces(&mut list, Some(Ipv4Addr::new(192, 168, 110, 133)));
        assert_eq!(list[0].address, "192.168.110.133");
        assert_eq!(list[2].kind, "tailscale");
    }

    #[tokio::test]
    async fn closes_tls_handshakes_immediately() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root =
            std::env::temp_dir().join(format!("saint-relay-tls-{}", uuid::Uuid::new_v4().simple()));
        let paths = crate::state::SaintPaths::from_base_dir(root);
        let backend = Arc::new(BackendSupervisor::new(paths.clone()));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths));
        let manager = LanRelayManager::new(Arc::clone(&backend), Arc::clone(&remote_ssh));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_stop_tx, stop_rx) = watch::channel(false);
        tokio::spawn(run_relay_accept_loop(
            listener,
            stop_rx,
            Arc::clone(&manager.inner),
            backend,
            remote_ssh,
        ));
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(&[0x16, 0x03, 0x01, 0x00, 0x05])
            .await
            .unwrap();
        let mut out = Vec::new();
        let closed = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.read_to_end(&mut out),
        )
        .await;
        assert!(
            closed.is_ok(),
            "relay must close a TLS handshake without waiting for the header timeout"
        );
    }

    #[test]
    fn serves_built_web_files_with_spa_fallback_and_no_traversal() {
        let root = std::env::temp_dir().join(format!(
            "saint-relay-dist-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<html>app</html>").unwrap();
        std::fs::write(root.join("assets/app-1.js"), "console.log(1)").unwrap();
        let text =
            |path: &str| String::from_utf8(static_file_response(&root, path, false)).unwrap();

        let js = text("/assets/app-1.js");
        assert!(
            js.contains("text/javascript")
                && js.contains("immutable")
                && js.ends_with("console.log(1)")
        );
        assert!(text("/").ends_with("<html>app</html>"));
        assert!(text("/thread/abc").ends_with("<html>app</html>"));
        assert!(text("/../secret").ends_with("<html>app</html>"));
        let head = text("/assets/app-1.js");
        assert!(
            String::from_utf8(static_file_response(&root, "/assets/app-1.js", true))
                .unwrap()
                .ends_with("\r\n\r\n")
        );
        assert!(head.contains("Content-Length: 14"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn pairing_post_sets_a_session_cookie_while_get_query_is_rejected_and_rate_limited() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!(
            "saint-relay-pair-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = crate::state::SaintPaths::from_base_dir(root);
        let backend = Arc::new(BackendSupervisor::new(paths.clone()));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths));
        let manager = LanRelayManager::new(Arc::clone(&backend), Arc::clone(&remote_ssh));
        let state = manager.get_state();
        let token = state.pairing_token.clone();
        if let Some(url) = &state.pairing_url {
            assert!(
                url.contains("/pair#token="),
                "pairing_url must keep token in fragment: {url}"
            );
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_stop_tx, stop_rx) = watch::channel(false);
        tokio::spawn(run_relay_accept_loop(
            listener,
            stop_rx,
            Arc::clone(&manager.inner),
            backend,
            remote_ssh,
        ));

        let send = |raw: String| async move {
            let mut client = TcpStream::connect(addr).await.unwrap();
            client.write_all(raw.as_bytes()).await.unwrap();
            let mut out = String::new();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                client.read_to_string(&mut out),
            )
            .await;
            out
        };

        // 1. GET /pair?token=... must NOT issue a session cookie and keeps Referrer-Policy: no-referrer.
        let get_pair = send(format!(
            "GET /pair?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUser-Agent: curl/8.18.0\r\n\r\n",
            addr.port()
        ))
        .await;
        assert!(get_pair.starts_with("HTTP/1.1 302"), "get_pair: {get_pair:?}");
        assert!(
            get_pair.contains("Referrer-Policy: no-referrer\r\n"),
            "legacy ?token= redirect should scrub referrer: {get_pair:?}"
        );
        assert!(
            !get_pair.contains("Set-Cookie: saint_lan_session="),
            "GET /pair?token must not set session cookie: {get_pair:?}"
        );

        // 1b. GET /pair HTML must use Referrer-Policy: same-origin (never no-referrer, which
        //     causes browsers to send `Origin: null` on the same-origin POST /pair form submit).
        let get_pair_page = send(format!(
            "GET /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            addr.port()
        ))
        .await;
        assert!(
            get_pair_page.starts_with("HTTP/1.1 200"),
            "get_pair_page: {get_pair_page:?}"
        );
        assert!(
            get_pair_page.contains("Referrer-Policy: same-origin\r\n"),
            "GET /pair must send Referrer-Policy: same-origin: {get_pair_page:?}"
        );
        assert!(
            !get_pair_page.contains("Referrer-Policy: no-referrer"),
            "GET /pair must not send Referrer-Policy: no-referrer: {get_pair_page:?}"
        );

        // 1c. POST /pair with `Origin: null` (e.g. sandboxed cross-origin iframe) remains rejected.
        let null_origin_body = format!("token={token}");
        let null_origin = send(format!(
            "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: null\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{null_origin_body}",
            addr.port(),
            null_origin_body.len()
        ))
        .await;
        assert!(
            null_origin.starts_with("HTTP/1.1 403"),
            "Origin: null POST /pair must stay rejected: {null_origin:?}"
        );

        // 2. Repeated invalid POST /pair attempts trigger 429 rate limiting and keep same-origin referrer policy.
        for _ in 0..PAIR_RATE_LIMIT_MAX_FAILURES {
            let bad_body = "token=WRONGCODE123";
            let bad = send(format!(
                "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{bad_body}",
                addr.port(),
                addr.port(),
                bad_body.len()
            ))
            .await;
            assert!(bad.starts_with("HTTP/1.1 401"), "bad pair: {bad:?}");
            assert!(
                bad.contains("Referrer-Policy: same-origin\r\n"),
                "401 pairing page must send Referrer-Policy: same-origin: {bad:?}"
            );
        }
        let limited_body = format!("token={token}");
        let limited = send(format!(
            "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{limited_body}",
            addr.port(),
            addr.port(),
            limited_body.len()
        ))
        .await;
        assert!(limited.starts_with("HTTP/1.1 429"), "rate limit: {limited:?}");
        assert!(
            limited.contains("Referrer-Policy: same-origin\r\n"),
            "429 pairing page must send Referrer-Policy: same-origin: {limited:?}"
        );

        // Clear rate limit table and verify valid POST /pair succeeds.
        clear_pair_failures(&manager.inner, IpAddr::V4(Ipv4Addr::LOCALHOST));
        let ok_body = format!("token={token}");
        let out = send(format!(
            "POST /pair HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://127.0.0.1:{}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n\r\n{ok_body}",
            addr.port(),
            addr.port(),
            ok_body.len()
        ))
        .await;
        assert!(out.starts_with("HTTP/1.1 302"), "pair: {out:?}");
        assert!(
            out.contains("Set-Cookie: saint_lan_session="),
            "pair: {out:?}"
        );
        assert!(
            out.contains("Set-Cookie: saint_lan_relay=1;"),
            "pair should set capability cookie: {out:?}"
        );
    }

    #[tokio::test]
    async fn blocks_cross_port_cswsh_csrf_and_isolates_forwarded_dev_servers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!(
            "saint-relay-sec-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = crate::state::SaintPaths::from_base_dir(root.clone());
        let backend = Arc::new(BackendSupervisor::new(paths.clone()));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths));

        // Fake dev server behind an SSH tunnel on loopback
        let fake_dev = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake_dev_port = fake_dev.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = fake_dev.accept().await {
                let mut buf = vec![0u8; 4096];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = format!("dev-saw-cookie={}", req.contains(LAN_SESSION_COOKIE_NAME));
                let _ = s
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        });

        let manager = LanRelayManager::new(Arc::clone(&backend), Arc::clone(&remote_ssh));
        let pairing_token = manager.get_state().pairing_token;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_stop_tx, stop_rx) = watch::channel(false);
        let inner = Arc::clone(&manager.inner);
        let session_secret = issue_relay_session(&inner, &pairing_token, addr, None).unwrap();
        tokio::spawn(run_relay_accept_loop(
            listener,
            stop_rx.clone(),
            Arc::clone(&inner),
            backend,
            Arc::clone(&remote_ssh),
        ));

        let send_to = |target: SocketAddr, raw: String| async move {
            let mut c = TcpStream::connect(target).await.unwrap();
            c.write_all(raw.as_bytes()).await.unwrap();
            let mut out = String::new();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                c.read_to_string(&mut out),
            )
            .await;
            out
        };

        // 1. Cross-port WebSocket upgrade (same IP, different port) is blocked with 403.
        let ws_cross_port = send_to(
            addr,
            format!(
                "GET /ws HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nOrigin: http://192.168.1.5:5173\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n"
            ),
        )
        .await;
        assert!(
            ws_cross_port.starts_with("HTTP/1.1 403"),
            "cross-port CSWSH must be rejected: {ws_cross_port:?}"
        );

        // 2. Same-site (cross-port) Sec-Fetch-Site WebSocket upgrade is blocked with 403.
        let ws_same_site = send_to(
            addr,
            format!(
                "GET /ws HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nSec-Fetch-Site: same-site\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n"
            ),
        )
        .await;
        assert!(
            ws_same_site.starts_with("HTTP/1.1 403"),
            "Sec-Fetch-Site: same-site WS must be rejected: {ws_same_site:?}"
        );

        // 3. Cross-origin POST /api/remote-ssh/ws-url is blocked with 403.
        let body = r#"{"host":"devbox"}"#;
        let post_cross_origin = send_to(
            addr,
            format!(
                "POST /api/remote-ssh/ws-url HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nOrigin: http://192.168.1.5:5173\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(
            post_cross_origin.starts_with("HTTP/1.1 403"),
            "cross-origin POST must be rejected: {post_cross_origin:?}"
        );

        // 4. text/plain POST /api/remote-ssh/ws-url is rejected with 415.
        let post_plain = send_to(
            addr,
            format!(
                "POST /api/remote-ssh/ws-url HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nOrigin: http://192.168.1.5:3883\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(
            post_plain.starts_with("HTTP/1.1 415"),
            "text/plain POST must be rejected: {post_plain:?}"
        );

        // 5. Legacy same-origin /api/remote-ssh/forward/... route returns 410 Gone.
        let legacy_forward = send_to(
            addr,
            format!(
                "GET /api/remote-ssh/forward/hk-1/3000/ HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n"
            ),
        )
        .await;
        assert!(
            legacy_forward.starts_with("HTTP/1.1 410"),
            "same-origin forward path must return 410: {legacy_forward:?}"
        );

        // 6. Isolated forward listener runs on its own port, requires session cookie, and strips it.
        let isolated_url = ensure_isolated_forward_listener(
            &inner,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            "hk-1",
            3000,
            fake_dev_port,
            &stop_rx,
        )
        .await
        .unwrap();
        let port_str = isolated_url
            .trim_start_matches("http://127.0.0.1:")
            .trim_end_matches('/');
        let isolated_port: u16 = port_str.parse().unwrap();
        assert_ne!(isolated_port, addr.port());
        let isolated_addr = SocketAddr::from((Ipv4Addr::LOCALHOST, isolated_port));

        let unauth_dev = send_to(
            isolated_addr,
            format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{isolated_port}\r\n\r\n"),
        )
        .await;
        assert!(unauth_dev.starts_with("HTTP/1.1 401"), "unauth dev: {unauth_dev:?}");

        let auth_dev = send_to(
            isolated_addr,
            format!(
                "GET / HTTP/1.1\r\nHost: 127.0.0.1:{isolated_port}\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n"
            ),
        )
        .await;
        assert!(auth_dev.contains("dev-saw-cookie=false"), "auth dev: {auth_dev:?}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn serves_remote_ssh_state_and_proxies_connected_host_for_paired_device() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = std::env::temp_dir().join(format!(
            "saint-relay-ssh-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let paths = crate::state::SaintPaths::from_base_dir(root.clone());
        let backend = Arc::new(BackendSupervisor::new(paths.clone()));
        let remote_ssh = Arc::new(RemoteSshManager::new(paths));

        // Fake remote SSH server listening on desktop loopback
        let fake_ssh = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fake_ssh_port = fake_ssh.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = fake_ssh.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let first = req.lines().next().unwrap_or("").to_string();
            let body = format!("ssh-upstream: {first}");
            let _ = s
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await;
        });
        remote_ssh.insert_test_connected_host("devbox", "hk-devbox-1", fake_ssh_port, "ssh-secret");

        let manager = LanRelayManager::new(Arc::clone(&backend), Arc::clone(&remote_ssh));
        let pairing_token = manager.get_state().pairing_token;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_stop_tx, stop_rx) = watch::channel(false);
        let inner = Arc::clone(&manager.inner);
        let session_secret = issue_relay_session(&inner, &pairing_token, addr, None).unwrap();
        tokio::spawn(run_relay_accept_loop(
            listener,
            stop_rx,
            inner,
            backend,
            Arc::clone(&remote_ssh),
        ));

        let send_raw = |raw: String| async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(raw.as_bytes()).await.unwrap();
            let mut out = String::new();
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                c.read_to_string(&mut out),
            )
            .await;
            out
        };

        // 1. Unpaired request to /api/remote-ssh/state must be rejected with 401
        let unauth = send_raw(
            "GET /api/remote-ssh/state HTTP/1.1\r\nHost: 192.168.1.5:3883\r\n\r\n".to_string(),
        )
        .await;
        assert!(unauth.starts_with("HTTP/1.1 401"), "unauth: {unauth:?}");

        // 2. Paired GET /api/remote-ssh/state returns the connected host + capability header
        let state_resp = send_raw(format!(
            "GET /api/remote-ssh/state HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\n\r\n"
        ))
        .await;
        assert!(state_resp.starts_with("HTTP/1.1 200"), "state: {state_resp:?}");
        assert!(state_resp.contains("X-Saint-Lan-Relay: 1"));
        assert!(state_resp.contains("\"hostKey\":\"hk-devbox-1\""));

        // 3. Paired POST /api/remote-ssh/ws-url returns proxy path without leaking token
        let ws_body = r#"{"host":"devbox"}"#;
        let ws_resp = send_raw(format!(
            "POST /api/remote-ssh/ws-url HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{ws_body}",
            ws_body.len()
        ))
        .await;
        assert!(ws_resp.starts_with("HTTP/1.1 200"), "ws-url: {ws_resp:?}");
        assert!(ws_resp.contains("/api/remote-ssh/proxy/hk-devbox-1/"));
        assert!(!ws_resp.contains("ssh-secret"));

        // 4. Paired GET /api/remote-ssh/proxy/hk-devbox-1/attachments/a.png?x=1 proxies & injects auth
        let proxied = send_raw(format!(
            "GET /api/remote-ssh/proxy/hk-devbox-1/attachments/a.png?x=1&token=forged HTTP/1.1\r\nHost: 192.168.1.5:3883\r\nCookie: {LAN_SESSION_COOKIE_NAME}={session_secret}; {LAN_RELAY_CAPABILITY_COOKIE_NAME}=1\r\n\r\n"
        ))
        .await;
        assert!(proxied.starts_with("HTTP/1.1 200"), "proxy: {proxied:?}");
        assert!(
            proxied.contains("ssh-upstream: GET /attachments/a.png?x=1&token=ssh-secret&client="),
            "proxy did not rewrite path/auth properly: {proxied:?}"
        );
        assert!(!proxied.contains("forged"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn relays_health_to_the_backend_for_a_paired_device() {
        let unpaired = relay_round_trip("/health", false).await;
        assert!(
            unpaired.starts_with("HTTP/1.1 302"),
            "unpaired: {unpaired:?}"
        );
        let paired = relay_round_trip("/health", true).await;
        assert!(
            paired.contains("upstream saw: GET /health?token="),
            "paired: {paired:?}"
        );
    }

    #[test]
    fn renders_valid_qr_code_svg_for_pairing_url() {
        let url = "http://192.168.1.25:3883/pair?token=ABCDEFGH2345";
        let svg = render_qr_svg(url, 4).expect("should generate QR SVG");
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.contains("<path d=\"M"));
        assert!(svg.ends_with("</svg>"));
    }

    #[test]
    fn rewrites_headers_with_connection_close_for_http_and_preserves_upgrade_for_ws() {
        let http_headers = vec![
            ("Host".to_string(), "192.168.1.25:3883".to_string()),
            ("Origin".to_string(), "http://192.168.1.25:3883".to_string()),
            ("Connection".to_string(), "keep-alive".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];
        let rewritten_get = build_forwarded_request_header(
            "GET",
            "/api/health?token=secret",
            41820,
            &http_headers,
            false,
        );
        assert!(rewritten_get.starts_with("GET /api/health?token=secret HTTP/1.1\r\n"));
        assert!(rewritten_get.contains("Host: 127.0.0.1:41820\r\n"));
        assert!(rewritten_get.contains("Origin: http://127.0.0.1:41820\r\n"));
        assert!(rewritten_get.contains("Connection: close\r\n"));
        assert!(!rewritten_get.contains("keep-alive"));
        assert!(rewritten_get.ends_with("\r\n\r\n"));

        let ws_headers = vec![
            ("Host".to_string(), "192.168.1.25:3883".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            ("Connection".to_string(), "Upgrade".to_string()),
        ];
        let rewritten_ws =
            build_forwarded_request_header("GET", "/?token=secret", 41820, &ws_headers, true);
        assert!(rewritten_ws.contains("Upgrade: websocket\r\n"));
        assert!(rewritten_ws.contains("Connection: Upgrade\r\n"));
        assert!(!rewritten_ws.contains("Connection: close\r\n"));

        let unauthorized = build_unauthorized_json_response();
        let (head, body) = unauthorized
            .split_once("\r\n\r\n")
            .expect("valid HTTP response");
        let content_len = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .and_then(|v| v.parse::<usize>().ok())
            .expect("Content-Length header");
        assert_eq!(content_len, body.len());
    }
}
