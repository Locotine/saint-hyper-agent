import * as Net from "node:net";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PtyAdapter, type PtyExitEvent } from "../Services/PTY";
import { PAUSE_BUFFER_LIMIT, RustPtyProcess, layer as RustPtyAdapterLive } from "./RustPTY";

describe("RustPTY", () => {
  const originalPort = process.env.SAINT_RUST_PTY_PORT;
  const originalToken = process.env.SAINT_RUST_PTY_TOKEN;
  const servers: Net.Server[] = [];
  const sockets: Net.Socket[] = [];

  afterEach(async () => {
    if (originalPort === undefined) {
      delete process.env.SAINT_RUST_PTY_PORT;
    } else {
      process.env.SAINT_RUST_PTY_PORT = originalPort;
    }
    if (originalToken === undefined) {
      delete process.env.SAINT_RUST_PTY_TOKEN;
    } else {
      process.env.SAINT_RUST_PTY_TOKEN = originalToken;
    }
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("buffers data and exit frames arriving in the same chunk as spawned until onData/onExit subscribe", async () => {
    const token = "test-bridge-token";
    const initialPrompt = "Welcome to Saint Terminal\r\n$ ";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        // Send spawned + data + exit in a single TCP write so they arrive in one chunk
        // before the caller after `spawn()` can attach `onData` / `onExit`.
        const spawnedFrame = JSON.stringify({ type: "spawned", pid: 4242 });
        const dataFrame = JSON.stringify({
          type: "data",
          dataBase64: Buffer.from(initialPrompt, "utf8").toString("base64"),
        });
        const exitFrame = JSON.stringify({
          type: "exit",
          exitCode: 0,
          signal: null,
        });
        socket.write(`${spawnedFrame}\n${dataFrame}\n${exitFrame}\n`);
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    expect(ptyProcess.pid).toBe(4242);

    const receivedData: string[] = [];
    const receivedExits: PtyExitEvent[] = [];
    const eventsOrder: string[] = [];

    ptyProcess.onData((chunk) => {
      receivedData.push(chunk);
      eventsOrder.push(`data:${chunk}`);
    });
    ptyProcess.onExit((event) => {
      receivedExits.push(event);
      eventsOrder.push(`exit:${event.exitCode}`);
    });

    // Callbacks must not fire synchronously during onData/onExit registration.
    expect(receivedData).toEqual([]);
    expect(receivedExits).toEqual([]);
    expect(eventsOrder).toEqual([]);

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(receivedData.join("")).toBe(initialPrompt);
    expect(receivedExits).toEqual([{ exitCode: 0, signal: null }]);
    expect(eventsOrder).toEqual([`data:${initialPrompt}`, "exit:0"]);
  });

  it("delivers buffered data before exit even when onExit subscribes before onData", async () => {
    const token = "test-bridge-token-order";
    const initialPrompt = "output-before-exit\r\n";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const spawnedFrame = JSON.stringify({ type: "spawned", pid: 5151 });
        const dataFrame = JSON.stringify({
          type: "data",
          dataBase64: Buffer.from(initialPrompt, "utf8").toString("base64"),
        });
        const exitFrame = JSON.stringify({
          type: "exit",
          exitCode: 7,
          signal: null,
        });
        socket.write(`${spawnedFrame}\n${dataFrame}\n${exitFrame}\n`);
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    const eventsOrder: string[] = [];

    // Subscribe onExit first while pendingData is still buffered.
    ptyProcess.onExit((event) => {
      eventsOrder.push(`exit:${event.exitCode}`);
    });
    expect(eventsOrder).toEqual([]);

    // Subscribing onData in the same tick still delivers data before exit on the microtask.
    ptyProcess.onData((chunk) => {
      eventsOrder.push(`data:${chunk}`);
    });
    expect(eventsOrder).toEqual([]);

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(eventsOrder).toEqual([`data:${initialPrompt}`, "exit:7"]);
  });

  it("delivers exit and clears buffered data when only onExit subscribes", async () => {
    const token = "test-bridge-token-exit-only";
    const trailingOutput = "^C\r\n";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const spawnedFrame = JSON.stringify({ type: "spawned", pid: 5252 });
        const dataFrame = JSON.stringify({
          type: "data",
          dataBase64: Buffer.from(trailingOutput, "utf8").toString("base64"),
        });
        const exitFrame = JSON.stringify({
          type: "exit",
          exitCode: 130,
          signal: null,
        });
        socket.write(`${spawnedFrame}\n${dataFrame}\n${exitFrame}\n`);
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    const exitEvent = await new Promise<PtyExitEvent>((resolve) => {
      ptyProcess.onExit((event) => {
        resolve(event);
      });
    });
    expect(exitEvent).toEqual({ exitCode: 130, signal: null });

    // Attaching onData after exit was emitted must not replay stale buffered data.
    const lateData: string[] = [];
    ptyProcess.onData((chunk) => {
      lateData.push(chunk);
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(lateData).toEqual([]);
  });

  it("flushes buffered data to onData listeners and emits exit immediately without waiting for resume when paused", async () => {
    const token = "test-bridge-token-paused-exit";
    const trailingError = "fatal: port already in use\r\n";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const spawnedFrame = JSON.stringify({ type: "spawned", pid: 5353 });
        const dataFrame = JSON.stringify({
          type: "data",
          dataBase64: Buffer.from(trailingError, "utf8").toString("base64"),
        });
        const exitFrame = JSON.stringify({
          type: "exit",
          exitCode: 1,
          signal: null,
        });
        socket.write(`${spawnedFrame}\n${dataFrame}\n${exitFrame}\n`);
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    const eventsOrder: string[] = [];
    ptyProcess.onData((chunk) => {
      eventsOrder.push(`data:${chunk}`);
    });
    // Pause before the scheduled microtask flushes pendingData.
    ptyProcess.pause?.();
    ptyProcess.onExit((event) => {
      eventsOrder.push(`exit:${event.exitCode}`);
    });

    expect(eventsOrder).toEqual([]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    // Exit is terminal: even while paused, buffered data is flushed to attached onData
    // listeners and exit is emitted immediately without waiting for resume().
    expect(eventsOrder).toEqual([`data:${trailingError}`, "exit:1"]);
  });

  it("emits exit with exitCode null when the bridge socket closes without an exit event", async () => {
    const token = "test-bridge-token-socket-close-no-exit";
    const partialOutput = "stream cut off by backpressure shutdown\r\n";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const spawnedFrame = JSON.stringify({ type: "spawned", pid: 5454 });
        const dataFrame = JSON.stringify({
          type: "data",
          dataBase64: Buffer.from(partialOutput, "utf8").toString("base64"),
        });
        socket.write(`${spawnedFrame}\n${dataFrame}\n`, () => {
          socket.destroy();
        });
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    const receivedData: string[] = [];
    ptyProcess.onData((chunk) => {
      receivedData.push(chunk);
    });

    const exitEvent = await new Promise<PtyExitEvent>((resolve) => {
      ptyProcess.onExit((event) => {
        resolve(event);
      });
    });

    expect(receivedData.join("")).toBe(partialOutput);
    expect(exitEvent).toEqual({ exitCode: null, signal: null });
  });

  it("caps pendingData at PAUSE_BUFFER_LIMIT by dropping whole oldest chunks without corrupting multibyte UTF-8", async () => {
    const token = "test-bridge-token-cap";
    // Each chunk is 1,000,002 bytes (333,334 3-byte UTF-8 characters '€'), which does not
    // divide 8 MB (8,388,608 bytes) evenly, proving whole chunks are dropped rather than byte-sliced.
    const unit = "€"; // 3 bytes in UTF-8
    const chunkText = unit.repeat(333_334);
    const chunkBytes = Buffer.byteLength(chunkText, "utf8");
    expect(chunkBytes).toBe(1_000_002);

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const frames: string[] = [JSON.stringify({ type: "spawned", pid: 6262 })];
        // Send 10 chunks (~10 MB > 8 MB PAUSE_BUFFER_LIMIT) while no onData listener is attached.
        for (let i = 0; i < 10; i += 1) {
          const taggedChunk = `${i}${chunkText}`;
          frames.push(
            JSON.stringify({
              type: "data",
              dataBase64: Buffer.from(taggedChunk, "utf8").toString("base64"),
            }),
          );
        }
        socket.write(`${frames.join("\n")}\n`);
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const spy = vi.spyOn(RustPtyProcess.prototype, "handleRawData");
    try {
      const ptyProcess = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* PtyAdapter;
          return yield* adapter.spawn({
            shell: "sh",
            cwd: process.cwd(),
            cols: 80,
            rows: 24,
            env: {},
          });
        }).pipe(Effect.provide(RustPtyAdapterLive)),
      );

      // Wait until all 10 chunks are read from the loopback socket before onData attaches.
      // ~13 MB of base64 over loopback can take well over the 1 s default under full-suite load.
      await vi.waitFor(
        () => {
          expect(spy).toHaveBeenCalledTimes(10);
        },
        { timeout: 15_000 },
      );

      const receivedChunks: string[] = [];
      ptyProcess.onData((chunk) => {
        receivedChunks.push(chunk);
      });
      expect(receivedChunks).toEqual([]);
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      const combined = receivedChunks.join("");
      const receivedBytes = Buffer.byteLength(combined, "utf8");
      // 8 chunks of 1,000,003 bytes = 8,000,024 bytes <= 8,388,608; chunks 0 and 1 were dropped.
      expect(receivedChunks.length).toBe(8);
      expect(receivedBytes).toBeLessThanOrEqual(PAUSE_BUFFER_LIMIT);
      expect(receivedChunks[0]?.startsWith("2€")).toBe(true);
      expect(receivedChunks[7]?.startsWith("9€")).toBe(true);
      expect(combined.includes("\uFFFD")).toBe(false);
      ptyProcess.kill();
    } finally {
      spy.mockRestore();
    }
  });

  it("delivers all output without eviction when paused buffer overflows PAUSE_BUFFER_LIMIT with an attached listener", () => {
    const chunkText = "A".repeat(1_000_000);
    const ptyProcess = new RustPtyProcess(new Net.Socket(), 7272);

    const receivedChunks: string[] = [];
    ptyProcess.onData((chunk) => {
      receivedChunks.push(chunk);
    });
    ptyProcess.pause();

    // Feed 10 chunks of ~1 MB each (~10 MB > 8 MB PAUSE_BUFFER_LIMIT) while paused so
    // handleRawData overflows pausedChunks into emitDecoded -> deliverData.
    for (let i = 0; i < 10; i += 1) {
      ptyProcess.handleRawData(Buffer.from(`${i}:${chunkText}`, "utf8"));
    }

    ptyProcess.resume();

    const combined = receivedChunks.join("");
    expect(Buffer.byteLength(combined, "utf8")).toBe(10 * (chunkText.length + 2));
    expect(combined.startsWith("0:A")).toBe(true);
    expect(combined.includes("9:A")).toBe(true);
  });

  it("keeps the fitting UTF-16 tail without splitting surrogate pairs when a single chunk exceeds PAUSE_BUFFER_LIMIT", async () => {
    const ptyProcess = new RustPtyProcess(new Net.Socket(), 7373);

    // Buffer an earlier chunk before the oversized single chunk arrives.
    ptyProcess.handleRawData(Buffer.from("earlier-chunk\n", "utf8"));

    // Build a single chunk > PAUSE_BUFFER_LIMIT using 4-byte emoji surrogate pairs ("😀")
    // plus an odd byte prefix so the exact byte boundary lands mid-surrogate-pair.
    const pairCount = Math.floor(PAUSE_BUFFER_LIMIT / 4) + 100;
    const oversized = `X${"😀".repeat(pairCount)}TAIL`;
    ptyProcess.handleRawData(Buffer.from(oversized, "utf8"));

    const receivedChunks: string[] = [];
    ptyProcess.onData((chunk) => {
      receivedChunks.push(chunk);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(receivedChunks.length).toBe(1);
    const tail = receivedChunks[0]!;
    const tailBytes = Buffer.byteLength(tail, "utf8");
    expect(tailBytes).toBeLessThanOrEqual(PAUSE_BUFFER_LIMIT);
    expect(tailBytes).toBeGreaterThan(PAUSE_BUFFER_LIMIT - 4);
    expect(tail.includes("earlier-chunk")).toBe(false);
    expect(tail.endsWith("😀TAIL")).toBe(true);
    expect(tail.includes("\uFFFD")).toBe(false);
    const firstCode = tail.charCodeAt(0);
    expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true);
  });

  it("resumes a paused bridge socket on kill so exit events are still delivered", async () => {
    const token = "test-bridge-token-paused-kill";

    const server = Net.createServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      let spawned = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (!line) continue;
          const msg = JSON.parse(line) as { type: string };
          if (!spawned) {
            spawned = true;
            socket.write(`${JSON.stringify({ type: "spawned", pid: 8888 })}\n`);
          } else if (msg.type === "kill") {
            socket.write(`${JSON.stringify({ type: "exit", exitCode: 0, signal: null })}\n`);
          }
        }
      });
    });
    servers.push(server);

    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Failed to bind mock PTY server"));
        }
      });
    });

    process.env.SAINT_RUST_PTY_PORT = String(port);
    process.env.SAINT_RUST_PTY_TOKEN = token;

    const ptyProcess = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        return yield* adapter.spawn({
          shell: "sh",
          cwd: process.cwd(),
          cols: 80,
          rows: 24,
          env: {},
        });
      }).pipe(Effect.provide(RustPtyAdapterLive)),
    );

    ptyProcess.pause();
    const exitPromise = new Promise<PtyExitEvent>((resolve) => {
      ptyProcess.onExit(resolve);
    });
    ptyProcess.kill();

    const exitEvent = await exitPromise;
    expect(exitEvent).toEqual({ exitCode: 0, signal: null });
  });
});
