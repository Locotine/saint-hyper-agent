// FILE: RustPTY.ts
// Purpose: Connects `apps/server` terminal sessions to the native Rust `portable-pty` host
//          (`apps/desktop-rust/src/pty_host.rs`) over a local authenticated loopback socket,
//          requiring zero C++ native addons (`node-pty`).
// Layer: Terminal infrastructure

import * as Net from "node:net";
import { Effect, Layer } from "effect";
import {
  PtyAdapter,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  PtySpawnError,
} from "../Services/PTY";

const PAUSE_BUFFER_LIMIT = 8 * 1024 * 1024; // 8 MB

interface BridgeSpawnedEvent {
  readonly type: "spawned";
  readonly pid: number;
}

interface BridgeDataEvent {
  readonly type: "data";
  readonly dataBase64: string;
}

interface BridgeExitEvent {
  readonly type: "exit";
  readonly exitCode: number;
  readonly signal: number | null;
}

interface BridgeErrorEvent {
  readonly type: "error";
  readonly message: string;
}

type BridgeServerEvent = BridgeSpawnedEvent | BridgeDataEvent | BridgeExitEvent | BridgeErrorEvent;

class RustPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;
  private paused = false;
  private readonly pausedChunks: Uint8Array[] = [];
  private pausedBytes = 0;

  constructor(
    private readonly socket: Net.Socket,
    public readonly pid: number,
  ) {}

  write(data: string): void {
    if (this.didExit || this.socket.destroyed) return;
    const payload = JSON.stringify({
      type: "write",
      dataBase64: Buffer.from(data, "utf8").toString("base64"),
    });
    this.socket.write(`${payload}\n`);
  }

  resize(cols: number, rows: number): void {
    if (this.didExit || this.socket.destroyed) return;
    const payload = JSON.stringify({
      type: "resize",
      cols: Math.max(8, Math.floor(cols)),
      rows: Math.max(2, Math.floor(rows)),
    });
    this.socket.write(`${payload}\n`);
  }

  kill(_signal?: string): void {
    if (this.didExit || this.socket.destroyed) return;
    const payload = JSON.stringify({ type: "kill" });
    this.socket.write(`${payload}\n`, () => {
      this.socket.end();
    });
  }

  pause(): void {
    this.paused = true;
    this.socket.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flushPausedChunks();
    if (!this.socket.destroyed) {
      this.socket.resume();
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  handleRawData(bytes: Uint8Array): void {
    if (this.didExit) return;
    if (this.paused && this.pausedBytes < PAUSE_BUFFER_LIMIT) {
      const copy = bytes.slice();
      this.pausedChunks.push(copy);
      this.pausedBytes += copy.byteLength;
      return;
    }
    this.flushPausedChunks();
    this.emitDecoded(bytes);
  }

  handleExit(event: PtyExitEvent): void {
    if (this.didExit) return;
    this.flushPausedChunks();
    this.didExit = true;

    const remainder = this.decoder.decode();
    if (remainder.length > 0) {
      for (const listener of this.dataListeners) {
        listener(remainder);
      }
    }
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  private flushPausedChunks(): void {
    if (this.pausedChunks.length === 0) {
      this.pausedBytes = 0;
      return;
    }
    const chunks = this.pausedChunks.splice(0, this.pausedChunks.length);
    this.pausedBytes = 0;
    for (const chunk of chunks) {
      this.emitDecoded(chunk);
    }
  }

  private emitDecoded(bytes: Uint8Array): void {
    if (this.didExit) return;
    const text = this.decoder.decode(bytes, { stream: true });
    if (text.length === 0) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function spawnRustPtyProcess(
  port: number,
  token: string,
  input: PtySpawnInput,
): Promise<PtyProcess> {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);

    let settled = false;
    let processHandle: RustPtyProcess | null = null;
    let lineBuffer = "";

    const fail = (message: string, cause?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new PtySpawnError({
          adapter: "rust-portable-pty",
          message,
          cause,
        }),
      );
    };

    socket.once("error", (err) => {
      if (!settled) {
        fail(`Failed to connect to Rust PTY bridge on 127.0.0.1:${port}`, err);
      } else {
        processHandle?.handleExit({ exitCode: 1, signal: null });
      }
    });

    socket.once("close", () => {
      if (!settled) {
        fail("Rust PTY bridge closed connection before spawn completed");
      } else {
        processHandle?.handleExit({ exitCode: 0, signal: null });
      }
    });

    socket.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8");
      let newlineIndex = lineBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        newlineIndex = lineBuffer.indexOf("\n");
        if (line.length === 0) continue;

        let event: BridgeServerEvent;
        try {
          event = JSON.parse(line) as BridgeServerEvent;
        } catch {
          continue;
        }

        if (event.type === "spawned") {
          if (!settled) {
            settled = true;
            processHandle = new RustPtyProcess(socket, event.pid);
            resolve(processHandle);
          }
        } else if (event.type === "data") {
          const bytes = Buffer.from(event.dataBase64, "base64");
          processHandle?.handleRawData(bytes);
        } else if (event.type === "exit") {
          processHandle?.handleExit({
            exitCode: event.exitCode,
            signal: event.signal ?? null,
          });
          socket.end();
        } else if (event.type === "error") {
          if (!settled) {
            fail(event.message);
          } else {
            processHandle?.handleExit({ exitCode: 1, signal: null });
          }
        }
      }
    });

    socket.once("connect", () => {
      const spawnMsg = JSON.stringify({
        type: "spawn",
        token,
        shell: input.shell,
        args: input.args ?? [],
        cwd: input.cwd,
        cols: Math.max(8, Math.floor(input.cols)),
        rows: Math.max(2, Math.floor(input.rows)),
        env: sanitizeEnv(input.env),
      });
      socket.write(`${spawnMsg}\n`);
    });
  });
}

export const layer = Layer.effect(
  PtyAdapter,
  Effect.sync(() => {
    const portRaw = process.env.SAINT_RUST_PTY_PORT?.trim() ?? "";
    const port = Number(portRaw);
    const token = process.env.SAINT_RUST_PTY_TOKEN?.trim() ?? "";

    return {
      spawn: (input: PtySpawnInput) =>
        Effect.tryPromise({
          try: () => {
            if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
              return Promise.reject(
                new Error("SAINT_RUST_PTY_PORT / SAINT_RUST_PTY_TOKEN are not configured"),
              );
            }
            return spawnRustPtyProcess(port, token, input);
          },
          catch: (cause) =>
            cause instanceof PtySpawnError
              ? cause
              : new PtySpawnError({
                  adapter: "rust-portable-pty",
                  message: cause instanceof Error ? cause.message : "Failed to spawn Rust PTY",
                  cause,
                }),
        }),
    } satisfies PtyAdapterShape;
  }),
);
