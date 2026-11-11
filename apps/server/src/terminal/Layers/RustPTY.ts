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

export const PAUSE_BUFFER_LIMIT = 8 * 1024 * 1024; // 8 MB

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

interface PendingDataChunk {
  readonly text: string;
  readonly bytes: number;
}

function sliceUtf16TailToUtf8ByteLimit(text: string, maxBytes: number): PendingDataChunk {
  let low = Math.max(0, text.length - maxBytes);
  let high = text.length;
  if (Buffer.byteLength(text.slice(low), "utf8") > maxBytes) {
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (Buffer.byteLength(text.slice(mid), "utf8") <= maxBytes) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
  }
  if (low < text.length) {
    const code = text.charCodeAt(low);
    if (code >= 0xdc00 && code <= 0xdfff) {
      low += 1;
    }
  }
  const tail = text.slice(low);
  return {
    text: tail,
    bytes: Buffer.byteLength(tail, "utf8"),
  };
}

export class RustPtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly decoder = new TextDecoder();
  private didExit = false;
  private paused = false;
  private readonly pausedChunks: Uint8Array[] = [];
  private pausedBytes = 0;
  private readonly pendingData: PendingDataChunk[] = [];
  private pendingDataBytes = 0;
  private pendingExit: PtyExitEvent | null = null;
  private pendingFlushScheduled = false;

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
    if (this.dataListeners.size === 0) {
      this.clearPendingData();
    }
    if (this.didExit || this.socket.destroyed) return;
    if (this.paused) {
      this.paused = false;
      this.socket.resume();
    }
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
    this.flushPendingData();
    if (!this.socket.destroyed) {
      this.socket.resume();
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    if (!this.paused || this.pendingExit !== null) {
      this.schedulePendingFlush();
    }
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    this.schedulePendingFlush();
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
      this.deliverData(remainder);
    }
    this.pendingExit = event;
    this.schedulePendingFlush();
  }

  private flushPendingData(): void {
    if (this.pendingData.length === 0 || this.dataListeners.size === 0) {
      return;
    }
    const buffered = this.pendingData.splice(0, this.pendingData.length);
    this.pendingDataBytes = 0;
    for (const chunk of buffered) {
      for (const listener of this.dataListeners) {
        listener(chunk.text);
      }
    }
  }

  private clearPendingData(): void {
    this.pendingData.length = 0;
    this.pendingDataBytes = 0;
  }

  private emitPendingExitNow(): void {
    if (this.pendingExit === null || this.exitListeners.size === 0) {
      return;
    }
    this.flushPendingData();
    this.clearPendingData();
    const event = this.pendingExit;
    this.pendingExit = null;
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  private schedulePendingFlush(): void {
    const hasFlushableData =
      !this.paused && this.pendingData.length > 0 && this.dataListeners.size > 0;
    const hasFlushableExit = this.pendingExit !== null && this.exitListeners.size > 0;
    if (!hasFlushableData && !hasFlushableExit) {
      return;
    }
    if (this.pendingFlushScheduled) {
      return;
    }
    this.pendingFlushScheduled = true;
    queueMicrotask(() => {
      this.pendingFlushScheduled = false;
      if (!this.paused) {
        this.flushPendingData();
      }
      this.emitPendingExitNow();
    });
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
    this.deliverData(text);
  }

  private deliverData(text: string): void {
    if (text.length === 0) return;
    if (this.dataListeners.size === 0 || (this.pendingFlushScheduled && !this.paused)) {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > PAUSE_BUFFER_LIMIT) {
        this.clearPendingData();
        const tail = sliceUtf16TailToUtf8ByteLimit(text, PAUSE_BUFFER_LIMIT);
        if (tail.text.length > 0) {
          this.pendingData.push(tail);
          this.pendingDataBytes = tail.bytes;
        }
      } else {
        this.pendingData.push({ text, bytes });
        this.pendingDataBytes += bytes;
        while (this.pendingData.length > 0 && this.pendingDataBytes > PAUSE_BUFFER_LIMIT) {
          const removed = this.pendingData.shift()!;
          this.pendingDataBytes -= removed.bytes;
        }
      }
      if (!this.paused && this.dataListeners.size > 0) {
        this.schedulePendingFlush();
      }
      return;
    }
    this.flushPendingData();
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
    const lineDecoder = new TextDecoder();

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
        processHandle?.handleExit({ exitCode: null, signal: null });
      }
    });

    socket.once("close", () => {
      if (!settled) {
        fail("Rust PTY bridge closed connection before spawn completed");
      } else {
        processHandle?.handleExit({ exitCode: null, signal: null });
      }
    });

    socket.on("data", (chunk: Buffer) => {
      lineBuffer += lineDecoder.decode(chunk, { stream: true });
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
