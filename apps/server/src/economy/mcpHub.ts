// FILE: mcpHub.ts
// Purpose: MCP Hub: runs each opted-in stdio MCP server once and shares it with every agent.
//          Agents reach it as a connector (`<name>_hub`) on the gateway; the hub multiplexes their
//          JSON-RPC onto the one process, answering repeat `initialize` calls from the first.
// Layer: Server economy

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import readline from "node:readline";

import { spawnProcess } from "@saint/shared/processRuntime";

import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import type { McpConnectorProxyResult } from "../mcpConnectors/proxy.ts";
import {
  stripSaintControlPlaneEnvironment,
  withoutProviderCredentialEnvironment,
} from "../providerChildEnvironment.ts";

export const MCP_HUB_ID_PREFIX = "hub-";
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Splits a command line on spaces, honouring single and double quotes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let has = false;
  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      has = true;
    } else if (/\s/.test(char)) {
      if (has || current) out.push(current);
      current = "";
      has = false;
    } else {
      current += char;
    }
  }
  if (has || current) out.push(current);
  return out;
}

/** A short MCP server name for a command line: the package or script that names the server. */
export function hubServerName(commandLine: string): string {
  const parts = splitCommandLine(commandLine);
  const named =
    parts.find((part) => /mcp/i.test(part)) ??
    parts.filter((part) => !part.startsWith("-")).at(-1) ??
    "server";
  const base =
    named
      .split(/[\\/]/)
      .at(-1)!
      .replace(/@[^@]*$/, "") || named;
  const slug = base
    .toLowerCase()
    .replace(/\.(m?js|ts|py)$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Names never start with `saint`, which tool policy treats as trusted.
  return `${slug.replace(/^saint_?/, "") || "server"}_hub`;
}

export const hubServerId = (commandLine: string) =>
  `${MCP_HUB_ID_PREFIX}${Buffer.from(commandLine).toString("base64url").slice(0, 48)}`;

type JsonRpcMessage = Record<string, unknown>;

interface Pending {
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One shared server process and the JSON-RPC traffic of every agent on it. */
export class HubServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private initialized: Promise<JsonRpcMessage> | null = null;
  private initializedNotified = false;
  readonly sessions = new Set<string>();

  constructor(
    readonly commandLine: string,
    private readonly spawn: (command: string, args: string[]) => ChildProcessWithoutNullStreams,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const [command, ...args] = splitCommandLine(this.commandLine);
    const child = this.spawn(command!, args);
    this.child = child;
    this.initialized = null;
    this.initializedNotified = false;
    child.stderr.resume();
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.once("exit", () => {
      if (this.child === child) this.child = null;
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "Server exited." } });
      }
      this.pending.clear();
    });
    child.on("error", () => undefined);
    return child;
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === "string" && this.pending.has(id) && !("method" in message)) {
      const entry = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    } else if ("method" in message && id !== undefined) {
      // Server → client requests (roots, sampling) have no single client to go to.
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Not supported by the Saint MCP Hub." },
      });
    }
    // Server notifications are dropped: the gateway offers no stream to push them on.
  }

  private write(message: JsonRpcMessage): void {
    this.ensureChild().stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    const id = `hub:${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: "Request timed out." } });
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.write({ ...message, id });
    });
  }

  /** One client message; returns the response, or null for a notification. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const clientId = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    if (clientId === undefined) {
      // Only the first client's `initialized` reaches the server; it was initialized once.
      if (method === "notifications/initialized") {
        if (this.initializedNotified) return null;
        this.initializedNotified = true;
      }
      if (method !== "notifications/cancelled") this.write(message);
      return null;
    }
    if (method === "initialize") {
      this.ensureChild();
      this.initialized ??= this.request(message).then((response) => {
        if ("error" in response) this.initialized = null;
        return response;
      });
      return { ...(await this.initialized), id: clientId };
    }
    const response = await this.request(message);
    return { ...response, id: clientId };
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

function defaultSpawn(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawnProcess(command, args, {
    cwd: os.homedir(),
    env: withoutProviderCredentialEnvironment(stripSaintControlPlaneEnvironment(process.env)),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** All shared servers. One instance per server process; McpConnectors routes `hub-*` ids here. */
export class McpHub {
  private readonly servers = new Map<string, HubServer>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly spawn: (
      command: string,
      args: string[],
    ) => ChildProcessWithoutNullStreams = defaultSpawn,
  ) {}

  /** Opt-in list changed: start nothing yet (servers start on first use), stop removed ones. */
  setShared(commandLines: ReadonlyArray<string>): void {
    const wanted = new Set(commandLines);
    let changed = false;
    for (const [id, server] of this.servers) {
      if (wanted.has(server.commandLine)) continue;
      server.stop();
      this.servers.delete(id);
      changed = true;
    }
    for (const line of wanted) {
      const id = hubServerId(line);
      if (this.servers.has(id)) continue;
      this.servers.set(id, new HubServer(line, this.spawn));
      changed = true;
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  registrations(): AgentGatewayConnectorRegistration[] {
    return [...this.servers].map(([connectorId, server]) => ({
      connectorId,
      name: hubServerName(server.commandLine),
    }));
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  server(commandLine: string): HubServer | undefined {
    return this.servers.get(hubServerId(commandLine));
  }

  async forward(
    connectorId: string,
    request: {
      readonly method: "POST" | "DELETE";
      readonly body?: unknown;
      readonly sessionId?: string | undefined;
    },
  ): Promise<McpConnectorProxyResult> {
    const server = this.servers.get(connectorId);
    if (!server) {
      return {
        status: 404,
        sessionId: null,
        body: { kind: "text", value: "Not Found", contentType: "text/plain" },
      };
    }
    if (request.method === "DELETE") {
      if (request.sessionId) server.sessions.delete(request.sessionId);
      return { status: 200, sessionId: null, body: { kind: "empty" } };
    }
    const messages = Array.isArray(request.body) ? request.body : [request.body];
    let sessionId = request.sessionId ?? null;
    if (messages.some((message) => (message as JsonRpcMessage)?.method === "initialize")) {
      sessionId = randomUUID();
    }
    if (sessionId) server.sessions.add(sessionId);
    const responses = (
      await Promise.all(messages.map((message) => server.handle(message as JsonRpcMessage)))
    ).filter((response) => response !== null);
    if (responses.length === 0) return { status: 202, sessionId, body: { kind: "empty" } };
    return {
      status: 200,
      sessionId,
      body: { kind: "json", value: Array.isArray(request.body) ? responses : responses[0] },
    };
  }

  stopAll(): void {
    for (const server of this.servers.values()) server.stop();
  }
}

/** The server-wide hub: Economy sets what is shared, McpConnectors serves it. */
export const sharedMcpHub = new McpHub();
