import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { McpHub, hubServerId, hubServerName, splitCommandLine } from "./mcpHub.ts";

// A tiny stdio MCP server: counts initialize calls, echoes tools/call, asks the client for roots.
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
let inits = 0, initialized = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "notifications/initialized") { initialized += 1; return; }
  if (m.method === "initialize") { inits += 1; send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" }, capabilities: {} } }); return; }
  if (m.method === "stats") { send({ jsonrpc: "2.0", id: m.id, result: { inits, initialized } }); return; }
  if (m.method === "tools/call") { send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list" }); send({ jsonrpc: "2.0", id: m.id, result: { echo: m.params } }); return; }
  if (m.id !== undefined && m.error) { process.stderr.write("client error " + m.error.code + "\\n"); }
});
`;

const children: ChildProcessWithoutNullStreams[] = [];
const fakeSpawn = () => {
  const child = spawn(process.execPath, ["-e", FAKE_SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
};

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe("MCP Hub", () => {
  it("names and splits command lines", () => {
    expect(splitCommandLine(`node "/a b/server.js" --flag 'x y'`)).toEqual([
      "node",
      "/a b/server.js",
      "--flag",
      "x y",
    ]);
    expect(hubServerName("npx -y @modelcontextprotocol/server-github@1.2.0")).toBe(
      "server_github_hub",
    );
    expect(hubServerName("uvx mcp-server-git")).toBe("mcp_server_git_hub");
    expect(hubServerName("node saint-mcp.js")).toBe("mcp_hub");
  });

  it("shares one process across agents and initializes it once", async () => {
    const hub = new McpHub(fakeSpawn);
    const command = "fake-mcp";
    const changes: number[] = [];
    hub.onChange(() => changes.push(hub.registrations().length));
    hub.setShared([command]);
    expect(hub.registrations()).toEqual([
      { connectorId: hubServerId(command), name: "fake_mcp_hub" },
    ]);
    const id = hubServerId(command);
    const init = (requestId: number) =>
      hub.forward(id, {
        method: "POST",
        body: { jsonrpc: "2.0", id: requestId, method: "initialize", params: {} },
      });
    const [a, b] = await Promise.all([init(1), init(7)]);
    expect(a.body).toMatchObject({
      kind: "json",
      value: { id: 1, result: { serverInfo: { name: "fake" } } },
    });
    expect(b.body).toMatchObject({ kind: "json", value: { id: 7 } });
    expect(a.sessionId).not.toBe(b.sessionId);
    for (const sessionId of [a.sessionId!, b.sessionId!]) {
      const notified = await hub.forward(id, {
        method: "POST",
        sessionId,
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      expect(notified.status).toBe(202);
    }
    // Same client id from two agents: each gets its own answer back.
    const [callA, callB] = await Promise.all(
      ["a", "b"].map((agent) =>
        hub.forward(id, {
          method: "POST",
          sessionId: a.sessionId!,
          body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { agent } },
        }),
      ),
    );
    expect(callA!.body).toMatchObject({ value: { id: 2, result: { echo: { agent: "a" } } } });
    expect(callB!.body).toMatchObject({ value: { id: 2, result: { echo: { agent: "b" } } } });
    const stats = await hub.forward(id, {
      method: "POST",
      body: { jsonrpc: "2.0", id: "s", method: "stats" },
    });
    expect(stats.body).toMatchObject({ value: { result: { inits: 1, initialized: 1 } } });
    expect(hub.server(command)!.sessions.size).toBe(2);
    expect(children).toHaveLength(1);
    hub.setShared([]);
    expect(hub.registrations()).toEqual([]);
    expect(changes).toEqual([1, 0]);
  });

  it("answers 404 for an unknown hub server", async () => {
    const result = await new McpHub(fakeSpawn).forward("hub-nope", { method: "POST", body: {} });
    expect(result.status).toBe(404);
  });
});
