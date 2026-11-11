// FILE: lan_relay.rs
// Purpose: Mobile LAN / Tailscale HTTP + WebSocket Reverse Proxy Relay with one-time/rotatable
//          QR pairing token authentication and instant session revocation (Phase 5 Option B).
// Layer: Desktop native networking & security boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::backend::BackendSupervisor;
use crate::updater::now_iso8601;

pub const DEFAULT_LAN_RELAY_PORT: u16 = 3883;
pub const MAX_LAN_RELAY_SESSIONS: usize = 64;
const LAN_SESSION_COOKIE_NAME: &str = "saint_lan_session";
const PAIRING_TOKEN_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LEN: usize = 12;

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

struct RelayInner {
    enabled: bool,
    port: u16,
    /// Address the relay listens on; never 0.0.0.0. None picks the primary interface.
    bind_address: Option<Ipv4Addr>,
    pairing_token: String,
    error: Option<String>,
    stop_tx: Option<watch::Sender<bool>>,
    sessions: HashMap<String, StoredRelaySession>,
}

pub struct LanRelayManager {
    backend: Arc<BackendSupervisor>,
    inner: Arc<Mutex<RelayInner>>,
}

impl LanRelayManager {
    pub fn new(backend: Arc<BackendSupervisor>) -> Self {
        Self {
            backend,
            inner: Arc::new(Mutex::new(RelayInner {
                enabled: false,
                port: DEFAULT_LAN_RELAY_PORT,
                bind_address: None,
                pairing_token: generate_pairing_token(),
                error: None,
                stop_tx: None,
                sessions: HashMap::new(),
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
                "http://{}:{}/pair?token={}",
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
                tokio::spawn(async move {
                    run_relay_accept_loop(listener, stop_rx, inner_clone, backend_clone).await;
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
    let mut out: Vec<DesktopLanRelayInterface> = Vec::new();
    for (name, ip) in list_system_ipv4_interfaces() {
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
    // Primary route first, then LAN before Tailscale.
    out.sort_by_key(|i| {
        (
            Some(i.address.as_str()) != primary.map(|p| p.to_string()).as_deref(),
            i.kind != "lan",
        )
    });
    out
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
        std::process::Command::new("ipconfig")
            .creation_flags(0x0800_0000)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
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
                .and_then(|o| String::from_utf8(o.stdout).ok())
        };
        let from_ip = run("ip", &["-4", "-o", "addr", "show"])
            .map(|t| parse_ip_addr_oneline(&t))
            .unwrap_or_default();
        if !from_ip.is_empty() {
            return from_ip;
        }
        run("ifconfig", &[])
            .map(|t| parse_ifconfig(&t))
            .unwrap_or_default()
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
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_ipconfig(text: &str) -> Vec<(String, Ipv4Addr)> {
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if !line.starts_with(char::is_whitespace) && line.trim_end().ends_with(':') {
            let header = line.trim_end().trim_end_matches(':');
            current = header
                .split_once(" adapter ")
                .map(|(_, name)| name)
                .unwrap_or(header)
                .to_string();
            continue;
        }
        if line.contains("IPv4") {
            if let Some((_, right)) = line.split_once(':') {
                let candidate = right.trim().split('(').next().unwrap_or("").trim();
                if let Ok(ip) = candidate.parse() {
                    out.push((current.clone(), ip));
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
) {
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
                let stop_conn = stop_rx.clone();
                tokio::spawn(async move {
                    let _ = handle_relay_connection(stream, remote_addr, inner_conn, backend_conn, stop_conn).await;
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

async fn handle_relay_connection(
    mut client_stream: TcpStream,
    remote_addr: SocketAddr,
    inner: Arc<Mutex<RelayInner>>,
    backend: Arc<BackendSupervisor>,
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

    // 1. Handle `/pair` route (supports both `?token=CODE` and `#token=CODE` + manual input)
    if path_only == "/pair" {
        if let Some(token) = extract_query_param(&parsed.target, "token") {
            if let Some(session_secret) =
                issue_relay_session(&inner, &token, remote_addr, user_agent)
            {
                let response = format!(
                    "HTTP/1.1 302 Found\r\nLocation: /\r\nSet-Cookie: {LAN_SESSION_COOKIE_NAME}={session_secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n"
                );
                let _ = client_stream.write_all(response.as_bytes()).await;
                return Ok(());
            }
            let html = pairing_html_page(Some(
                "Invalid or expired pairing code. Check Settings in Saint Desktop.",
            ));
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = client_stream.write_all(response.as_bytes()).await;
            return Ok(());
        }

        let html = pairing_html_page(None);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{}",
            html.len(),
            html
        );
        let _ = client_stream.write_all(response.as_bytes()).await;
        return Ok(());
    }

    // 2. Check session cookie (or direct `?pairingToken=` query param)
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

    // 3. Authenticated: proxy to local `saint-server` (or Vite dev server for web assets in dev)
    let backend_port = backend.port();
    let backend_token = backend.auth_token();
    let is_upgrade = parsed
        .headers
        .iter()
        .any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket"));
    let is_backend_route = is_upgrade
        || path_only.starts_with("/api/")
        || path_only == "/ws"
        || path_only.starts_with("/ws/")
        || path_only.starts_with("/attachments/")
        || path_only == "/health";

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
        .and_then(|url| url.trim().trim_end_matches('/').rsplit(':').next()?.parse().ok())
        .unwrap_or(5733)
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
                            .map(|(name, _)| name.trim() != LAN_SESSION_COOKIE_NAME)
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
  if (window.location.hash && window.location.hash.indexOf("token=") !== -1) {{
    var t = window.location.hash.split("token=")[1];
    if (t) window.location.replace("/pair?token=" + encodeURIComponent(t));
  }}
</script>
</head>
<body>
  <form class="card" method="GET" action="/pair">
    <h1>Pair with Saint Desktop</h1>
    <p>Scan the QR code in Saint Settings &rarr; Remote Hosts, or enter the 12-character pairing code below.</p>
    {error_block}
    <input type="text" name="token" placeholder="PAIRING CODE" required autocomplete="off" autocapitalize="characters" />
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
        assert!(is_virtual_interface_name("docker0"));
        assert!(is_virtual_interface_name("br-1a2b3c"));
        assert!(!is_virtual_interface_name("tailscale0"));
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
