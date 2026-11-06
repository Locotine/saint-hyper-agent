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
use std::sync::{Arc, Mutex};
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

fn handle_pty_bridge_client(stream: TcpStream, expected_token: String) {
    let _ = stream.set_nodelay(true);
    let Ok(writer_stream) = stream.try_clone() else {
        return;
    };
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
    let mut pty_writer = match pair.master.take_writer() {
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
    let master = pair.master;
    let mut child_killer = child.clone_killer();

    if !send_bridge_event(&writer, &BridgeServerEvent::Spawned { pid }) {
        let _ = child_killer.kill();
        return;
    }

    let writer_for_output = Arc::clone(&writer);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = pty_reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
            if !send_bridge_event(
                &writer_for_output,
                &BridgeServerEvent::Data {
                    data_base64: encoded,
                },
            ) {
                break;
            }
        }
        let exit_code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(1);
        let _ = send_bridge_event(
            &writer_for_output,
            &BridgeServerEvent::Exit {
                exit_code,
                signal: None,
            },
        );
        if let Ok(guard) = writer_for_output.lock() {
            let _ = guard.shutdown(std::net::Shutdown::Both);
        }
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
                    let _ = pty_writer.write_all(&bytes).and_then(|_| pty_writer.flush());
                }
            }
            BridgeClientCommand::Resize { cols, rows } => {
                let _ = master.resize(PtySize {
                    rows: rows.max(2),
                    cols: cols.max(8),
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            BridgeClientCommand::Kill => {
                let _ = child_killer.kill();
                break;
            }
            BridgeClientCommand::Spawn { .. } => {}
        }
    }

    let _ = child_killer.kill();
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
        let running_clone = Arc::clone(&running);
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
            let _ = child.wait();
            if let Ok(mut guard) = running_clone.lock() {
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
