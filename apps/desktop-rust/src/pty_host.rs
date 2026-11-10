// FILE: pty_host.rs
// Purpose: Native Rust PTY session manager using `portable-pty` and `vt100`.
//          Replaces `node-pty` + `@xterm/headless` so the sidecar server needs zero C++ addons.
//          Exposes both Tauri IPC methods and a local authenticated loopback TCP bridge
//          (`SAINT_RUST_PTY_PORT` / `SAINT_RUST_PTY_TOKEN`) for `apps/server`.
// Layer: Native Terminal / PTY subsystem (Option 1A+ / 4A).

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub const MAX_RETAINED_EXITED_PTY_SESSIONS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenInput {
    pub session_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionSnapshot {
    pub session_id: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub screen_contents: String,
    pub running: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BridgeClientCommand {
    #[serde(rename_all = "camelCase")]
    Spawn {
        token: String,
        shell: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        env: HashMap<String, String>,
    },
    #[serde(rename_all = "camelCase")]
    Write { data_base64: String },
    #[serde(rename_all = "camelCase")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename_all = "camelCase")]
    Kill,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum BridgeServerEvent {
    #[serde(rename_all = "camelCase")]
    Spawned { pid: u32 },
    #[serde(rename_all = "camelCase")]
    Data { data_base64: String },
    #[serde(rename_all = "camelCase")]
    Exit {
        exit_code: i32,
        signal: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
}

fn send_bridge_event(writer: &Arc<Mutex<TcpStream>>, event: &BridgeServerEvent) -> bool {
    let Ok(serialized) = serde_json::to_string(event) else {
        return false;
    };
    let Ok(mut guard) = writer.lock() else {
        return false;
    };
    guard
        .write_all(format!("{serialized}\n").as_bytes())
        .and_then(|_| guard.flush())
        .is_ok()
}

fn send_exit_or_shutdown_bridge_stream(
    writer: &Arc<Mutex<TcpStream>>,
    shutdown_stream: Option<&TcpStream>,
    exit_code: i32,
    deadline: std::time::Instant,
) -> bool {
    loop {
        match writer.try_lock() {
            Ok(mut guard) => {
                let _ = guard.set_write_timeout(Some(Duration::from_millis(250)));
                let sent = serde_json::to_string(&BridgeServerEvent::Exit {
                    exit_code,
                    signal: None,
                })
                .ok()
                .map(|serialized| {
                    guard
                        .write_all(format!("{serialized}\n").as_bytes())
                        .and_then(|_| guard.flush())
                        .is_ok()
                })
                .unwrap_or(false);
                let _ = guard.shutdown(std::net::Shutdown::Both);
                return sent;
            }
            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                let guard = poisoned.into_inner();
                let _ = guard.shutdown(std::net::Shutdown::Both);
                return false;
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    if let Some(stream) = shutdown_stream {
                        let _ = stream.shutdown(std::net::Shutdown::Both);
                    }
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn handle_pty_bridge_client(stream: TcpStream, expected_token: String) {
    let _ = stream.set_nodelay(true);
    let Ok(writer_stream) = stream.try_clone() else {
        return;
    };
    let shutdown_stream = stream.try_clone().ok();
    let writer = Arc::new(Mutex::new(writer_stream));
    let reader = BufReader::new(stream);
    let mut lines = reader.lines();

    let Some(Ok(first_line)) = lines.next() else {
        return;
    };
    let Ok(BridgeClientCommand::Spawn {
        token,
        shell,
        args,
        cwd,
        cols,
        rows,
        env,
    }) = serde_json::from_str::<BridgeClientCommand>(&first_line)
    else {
        let _ = send_bridge_event(
            &writer,
            &BridgeServerEvent::Error {
                message: "Expected initial spawn command".into(),
            },
        );
        return;
    };

    if token != expected_token {
        let _ = send_bridge_event(
            &writer,
            &BridgeServerEvent::Error {
                message: "Invalid PTY bridge token".into(),
            },
        );
        return;
    }

    let pty_system = native_pty_system();
    let size = PtySize {
        rows: rows.max(2),
        cols: cols.max(8),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match pty_system.openpty(size) {
        Ok(p) => p,
        Err(e) => {
            let _ = send_bridge_event(
                &writer,
                &BridgeServerEvent::Error {
                    message: format!("Failed to open native PTY: {e}"),
                },
            );
            return;
        }
    };

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);
    // The server sends the complete, already-sanitized terminal env; inheriting
    // the desktop process env would bring back keys it deliberately removed.
    cmd.env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }

    let mut child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            let _ = send_bridge_event(
                &writer,
                &BridgeServerEvent::Error {
                    message: format!("Failed to spawn PTY process '{shell}': {e}"),
                },
            );
            return;
        }
    };
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let mut pty_reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            let _ = send_bridge_event(
                &writer,
                &BridgeServerEvent::Error {
                    message: format!("Failed to clone PTY reader: {e}"),
                },
            );
            return;
        }
    };
    let pty_writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            let _ = send_bridge_event(
                &writer,
                &BridgeServerEvent::Error {
                    message: format!("Failed to take PTY writer: {e}"),
                },
            );
            return;
        }
    };
    let master = Arc::new(Mutex::new(Some(pair.master)));
    let pty_writer = Arc::new(Mutex::new(Some(pty_writer)));
    let mut child_killer = child.clone_killer();

    if !send_bridge_event(&writer, &BridgeServerEvent::Spawned { pid }) {
        let _ = child_killer.kill();
        return;
    }

    let reader_done_pair = Arc::new((Mutex::new(false), Condvar::new()));

    fn take_and_drop<T>(slot: &Mutex<Option<T>>) {
        let taken = slot.lock().ok().and_then(|mut guard| guard.take());
        drop(taken);
    }

    let writer_for_output = Arc::clone(&writer);
    let reader_done_for_output = Arc::clone(&reader_done_pair);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        #[cfg(windows)]
        let mut send_open = true;
        while let Ok(n) = pty_reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            #[cfg(windows)]
            if !send_open {
                continue;
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
            if !send_bridge_event(
                &writer_for_output,
                &BridgeServerEvent::Data {
                    data_base64: encoded,
                },
            ) {
                #[cfg(windows)]
                {
                    // Client disconnected: keep draining (discarding) output until EOF
                    // so ConPTY's pipe never backs up and blocks ClosePseudoConsole.
                    send_open = false;
                }
                #[cfg(not(windows))]
                {
                    break;
                }
            }
        }

        let (done_lock, done_cvar) = &*reader_done_for_output;
        if let Ok(mut done) = done_lock.lock() {
            *done = true;
            done_cvar.notify_all();
        }
    });

    let writer_for_wait = Arc::clone(&writer);
    let reader_done_for_wait = Arc::clone(&reader_done_pair);
    let master_for_wait = Arc::clone(&master);
    let pty_writer_for_wait = Arc::clone(&pty_writer);
    std::thread::spawn(move || {
        let exit_code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(1);

        // Drop the writer and ConPTY master on a short-lived thread outside their mutex locks
        // so ClosePseudoConsole flushes remaining output without blocking the 2s drain timer
        // if pty_reader is backpressured.
        std::thread::spawn(move || {
            take_and_drop(&pty_writer_for_wait);
            take_and_drop(&master_for_wait);
        });

        // Wait (up to 2s) for pty_reader to finish forwarding trailing Data frames.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let (done_lock, done_cvar) = &*reader_done_for_wait;
        if let Ok(mut guard) = done_lock.lock() {
            while !*guard {
                let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now())
                else {
                    break;
                };
                match done_cvar.wait_timeout(guard, remaining) {
                    Ok((next_guard, timeout_res)) => {
                        guard = next_guard;
                        if timeout_res.timed_out() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }

        let lock_deadline = deadline.max(std::time::Instant::now() + Duration::from_millis(100));
        let _ = send_exit_or_shutdown_bridge_stream(
            &writer_for_wait,
            shutdown_stream.as_ref(),
            exit_code,
            lock_deadline,
        );
    });

    for line_res in lines {
        let Ok(line) = line_res else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(command) = serde_json::from_str::<BridgeClientCommand>(&line) else {
            continue;
        };
        match command {
            BridgeClientCommand::Write { data_base64 } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&data_base64) {
                    if let Ok(mut guard) = pty_writer.lock() {
                        if let Some(w) = guard.as_mut() {
                            let _ = w.write_all(&bytes).and_then(|_| w.flush());
                        }
                    }
                }
            }
            BridgeClientCommand::Resize { cols, rows } => {
                if let Ok(guard) = master.lock() {
                    if let Some(m) = guard.as_ref() {
                        let _ = m.resize(PtySize {
                            rows: rows.max(2),
                            cols: cols.max(8),
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
            }
            BridgeClientCommand::Kill => {
                let _ = child_killer.kill();
                break;
            }
            BridgeClientCommand::Spawn { .. } => {}
        }
    }

    let _ = child_killer.kill();
    std::thread::spawn(move || {
        take_and_drop(&pty_writer);
        take_and_drop(&master);
    });
}

struct ActivePtySession {
    cwd: String,
    cols: u16,
    rows: u16,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child_killer: Box<dyn ChildKiller + Send + Sync>,
    parser: Arc<Mutex<vt100::Parser>>,
    running: Arc<Mutex<bool>>,
}

impl Drop for ActivePtySession {
    fn drop(&mut self) {
        let _ = self.child_killer.kill();
    }
}

pub struct PtyHostManager {
    sessions: Mutex<HashMap<String, ActivePtySession>>,
    bridge_port: u16,
    bridge_token: String,
}

impl PtyHostManager {
    pub fn new() -> Self {
        let bridge_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let listener = TcpListener::bind("127.0.0.1:0").ok();
        let bridge_port = listener
            .as_ref()
            .and_then(|l| l.local_addr().ok())
            .map(|a| a.port())
            .unwrap_or(0);

        if let Some(listener) = listener {
            let token_for_server = bridge_token.clone();
            std::thread::spawn(move || {
                for incoming in listener.incoming().flatten() {
                    let token = token_for_server.clone();
                    std::thread::spawn(move || {
                        handle_pty_bridge_client(incoming, token);
                    });
                }
            });
        }

        Self {
            sessions: Mutex::new(HashMap::new()),
            bridge_port,
            bridge_token,
        }
    }

    pub fn bridge_port(&self) -> u16 {
        self.bridge_port
    }

    pub fn bridge_token(&self) -> &str {
        &self.bridge_token
    }

    fn default_shell() -> String {
        #[cfg(target_os = "windows")]
        {
            std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        }
    }

    pub fn open_session(&self, input: PtyOpenInput) -> Result<PtySessionSnapshot, String> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows: input.rows.max(2),
            cols: input.cols.max(8),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open native PTY: {e}"))?;

        let shell_program = input.shell.unwrap_or_else(Self::default_shell);
        let mut cmd = CommandBuilder::new(shell_program);
        cmd.cwd(&input.cwd);
        for (k, v) in &input.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell in PTY: {e}"))?;
        let child_killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

        let parser = Arc::new(Mutex::new(vt100::Parser::new(
            size.rows,
            size.cols,
            5_000,
        )));
        let running = Arc::new(Mutex::new(true));

        let parser_clone = Arc::clone(&parser);
        let running_for_reader = Arc::clone(&running);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut guard) = parser_clone.lock() {
                    guard.process(&buf[..n]);
                }
            }
            if let Ok(mut guard) = running_for_reader.lock() {
                *guard = false;
            }
        });

        let running_for_wait = Arc::clone(&running);
        std::thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut guard) = running_for_wait.lock() {
                *guard = false;
            }
        });

        let snapshot = PtySessionSnapshot {
            session_id: input.session_id.clone(),
            cwd: input.cwd.clone(),
            cols: size.cols,
            rows: size.rows,
            screen_contents: String::new(),
            running: true,
        };

        let session = ActivePtySession {
            cwd: input.cwd,
            cols: size.cols,
            rows: size.rows,
            master: pair.master,
            writer,
            child_killer,
            parser,
            running,
        };

        if let Ok(mut map) = self.sessions.lock() {
            let exited_count = map
                .values()
                .filter(|s| !s.running.lock().map(|r| *r).unwrap_or(false))
                .count();
            if exited_count >= MAX_RETAINED_EXITED_PTY_SESSIONS {
                map.retain(|_, s| s.running.lock().map(|r| *r).unwrap_or(false));
            }
            map.insert(input.session_id, session);
        }

        Ok(snapshot)
    }

    pub fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut map = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = map
            .get_mut(session_id)
            .ok_or_else(|| format!("Unknown PTY session: {session_id}"))?;
        session
            .writer
            .write_all(data)
            .and_then(|_| session.writer.flush())
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut map = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = map
            .get_mut(session_id)
            .ok_or_else(|| format!("Unknown PTY session: {session_id}"))?;
        let new_cols = cols.max(8);
        let new_rows = rows.max(2);
        session
            .master
            .resize(PtySize {
                rows: new_rows,
                cols: new_cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        session.cols = new_cols;
        session.rows = new_rows;
        if let Ok(mut parser) = session.parser.lock() {
            parser.set_size(new_rows, new_cols);
        }
        Ok(())
    }

    pub fn snapshot(&self, session_id: &str) -> Result<PtySessionSnapshot, String> {
        let map = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = map
            .get(session_id)
            .ok_or_else(|| format!("Unknown PTY session: {session_id}"))?;
        let contents = session
            .parser
            .lock()
            .map(|p| p.screen().contents())
            .unwrap_or_default();
        let running = session.running.lock().map(|r| *r).unwrap_or(false);
        Ok(PtySessionSnapshot {
            session_id: session_id.to_string(),
            cwd: session.cwd.clone(),
            cols: session.cols,
            rows: session.rows,
            screen_contents: contents,
            running,
        })
    }

    pub fn close_session(&self, session_id: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            map.remove(session_id);
        }
    }

    pub fn close_all_sessions(&self) {
        if let Ok(mut map) = self.sessions.lock() {
            map.clear();
        }
    }
}

impl Drop for PtyHostManager {
    fn drop(&mut self) {
        self.close_all_sessions();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_reports_exit_when_process_terminates_while_client_stays_connected() {
        let manager = PtyHostManager::new();
        let port = manager.bridge_port();
        assert!(port > 0, "bridge port should be bound");

        let stream = TcpStream::connect(("127.0.0.1", port)).expect("connect to PTY bridge");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let mut writer = stream.try_clone().unwrap();
        let reader = BufReader::new(stream);

        #[cfg(target_os = "windows")]
        let (shell, args, env) = {
            let comspec = std::env::var("COMSPEC")
                .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
            let mut env_map = HashMap::new();
            if let Ok(sys_root) = std::env::var("SystemRoot") {
                env_map.insert("SystemRoot".to_string(), sys_root);
            }
            (
                comspec,
                vec![
                    "/C".to_string(),
                    "echo pty-exit-ok & exit /b 7".to_string(),
                ],
                env_map,
            )
        };
        #[cfg(not(target_os = "windows"))]
        let (shell, args, env) = (
            "/bin/sh".to_string(),
            vec![
                "-c".to_string(),
                "echo pty-exit-ok; exit 7".to_string(),
            ],
            HashMap::<String, String>::new(),
        );

        let spawn_cmd = serde_json::json!({
            "type": "spawn",
            "token": manager.bridge_token(),
            "shell": shell,
            "args": args,
            "cwd": std::env::temp_dir().to_string_lossy(),
            "cols": 80,
            "rows": 24,
            "env": env,
        });
        writer
            .write_all(format!("{spawn_cmd}\n").as_bytes())
            .unwrap();
        writer.flush().unwrap();

        let mut saw_spawned = false;
        let mut exit_events = 0;
        let mut reported_exit_code = None::<i64>;
        let mut decoded_output = String::new();

        for line_res in reader.lines() {
            let Ok(line) = line_res else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            let val: serde_json::Value = serde_json::from_str(&line).unwrap();
            match val.get("type").and_then(|v| v.as_str()) {
                Some("spawned") => {
                    saw_spawned = true;
                }
                Some("data") => {
                    if let Some(b64) = val.get("dataBase64").and_then(|v| v.as_str()) {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                            let chunk = String::from_utf8_lossy(&bytes);
                            if chunk.contains("\x1b[6n") {
                                let dsr_reply = serde_json::json!({
                                    "type": "write",
                                    "dataBase64": base64::engine::general_purpose::STANDARD.encode("\x1b[1;1R"),
                                });
                                let _ = writer
                                    .write_all(format!("{dsr_reply}\n").as_bytes())
                                    .and_then(|_| writer.flush());
                            }
                            decoded_output.push_str(&chunk);
                        }
                    }
                }
                Some("exit") => {
                    exit_events += 1;
                    reported_exit_code = val.get("exitCode").and_then(|v| v.as_i64());
                    break;
                }
                _ => {}
            }
        }

        assert!(saw_spawned, "must receive spawned event");
        assert!(
            decoded_output.contains("pty-exit-ok"),
            "must flush output before exit, got: {decoded_output:?}"
        );
        assert_eq!(exit_events, 1, "must receive exit event exactly once");
        assert_eq!(
            reported_exit_code,
            Some(7),
            "must report the real non-zero exit code from child.wait()"
        );
    }

    #[test]
    fn send_exit_or_shutdown_shuts_down_cloned_stream_when_writer_mutex_is_held_by_blocked_reader()
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (server_stream, _) = listener.accept().unwrap();
        let shutdown_handle = server_stream.try_clone().unwrap();
        let writer = Arc::new(Mutex::new(server_stream));

        // Simulate pty_reader holding the writer mutex while blocked on a backpressured socket.
        let held_guard = writer.lock().unwrap();
        let start = std::time::Instant::now();
        let sent = send_exit_or_shutdown_bridge_stream(
            &writer,
            Some(&shutdown_handle),
            0,
            std::time::Instant::now() + Duration::from_millis(80),
        );
        assert!(
            !sent,
            "must not claim Exit was sent when writer lock is contended past deadline"
        );
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "must bound try_lock wait to deadline instead of blocking on mutex"
        );

        // Client must observe EOF immediately because shutdown_handle shut down the socket.
        let mut client_reader = client;
        let mut buf = [0u8; 16];
        let read_res = client_reader.read(&mut buf);
        assert!(
            matches!(read_res, Ok(0) | Err(_)),
            "client must observe socket shutdown even while writer mutex remains held, got: {read_res:?}"
        );
        drop(held_guard);
    }
}
