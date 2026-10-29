import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startEgressProxy } from "./egressProxy";
import { egressVerdict, type PolicyPrincipal } from "./policy";
import { DEFAULT_EGRESS_ALLOWLIST } from "./rules";
import { SANDBOX_RELAY_SCRIPT, detectSandbox, prepareDecoys, sandboxLauncher } from "./sandbox";

// bwrap's tmpfs hides /tmp inside the sandbox, so the fixture lives under the home cache.
const base = mkdtempSync(path.join(os.homedir(), ".cache", "saint-aegis-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("sandbox-exec profile", () => {
  it("denies credential reads, writes outside the workspace, and all but Saint's ports", () => {
    const { command, args } = sandboxLauncher({
      kind: "sandbox-exec",
      home: "/Users/me",
      cwd: "/work/repo",
      sessionDir: "/Users/me/.saint/aegis/s/ab",
      writable: [],
      readOnly: ["/work/repo/tests/a.test.ts"],
      decoys: [],
      ports: [
        { port: 4100, socketPath: "", direction: "out" },
        { port: 4200, socketPath: "", direction: "in" },
      ],
    });
    const profile = args[1]!;
    expect(command).toBe("sandbox-exec");
    expect(profile).toContain('(subpath "/Users/me/.ssh")');
    expect(profile).toContain('(subpath "/Users/me/Library/Keychains")');
    expect(profile).toContain('(deny file-write* (literal "/work/repo/tests/a.test.ts"))');
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(remote ip "localhost:4100")');
    expect(profile).toContain('(local ip "localhost:4200")');
  });
});

describe("per-session egress proxy", () => {
  it("decides by the principal its port belongs to", async () => {
    const policy = {
      version: 1 as const,
      cedar: `permit(principal == Saint::Thread::"a", action == Saint::Action::"egress", resource == Saint::Host::"git.corp.test");`,
      egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
      egressDenylist: [],
      protectedZones: [],
    };
    const open = (principal: PolicyPrincipal) =>
      startEgressProxy({
        decide: (host) => egressVerdict(policy, host, principal),
        onUnknown: () => undefined,
      });
    const [a, b] = await Promise.all([
      open({ kind: "thread", threadId: "a" }),
      open({ kind: "thread", threadId: "b" }),
    ]);
    const status = (port: number) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () =>
          socket.write("CONNECT git.corp.test:9 HTTP/1.1\r\nHost: git.corp.test\r\n\r\n"),
        );
        socket.on("error", () => resolve("error"));
        socket.once("data", (data) => {
          resolve(data.toString().split("\r\n")[0]!);
          socket.destroy();
        });
        // Allowed: the proxy dials the (unresolvable) host and drops the client.
        socket.once("close", () => resolve("dialed"));
      });
    expect(a.port).not.toBe(b.port);
    expect(await status(b.port)).toContain("403");
    expect(await status(a.port)).not.toContain("403");
    await Promise.all([a.close(), b.close()]);
  });
});

describe.skipIf(detectSandbox() !== "bwrap")("bwrap live", () => {
  it("decoy HOME, read-only protected file, network only through the relay", async () => {
    const workspace = path.join(base, "ws");
    const session = path.join(base, "s");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.join(session, "tmp"), { recursive: true });
    mkdirSync(path.join(session, "r"), { recursive: true });
    writeFileSync(path.join(workspace, "protected.test.ts"), "x");
    const relay = path.join(base, "relay.mjs");
    writeFileSync(relay, SANDBOX_RELAY_SCRIPT);
    const upstream = http.createServer((_request, response) => response.end("host-ok"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as net.AddressInfo).port;
    const socketPath = path.join(session, "r", `o${port}.sock`);
    const bridge = net.createServer((client) => {
      const target = net.connect(port, "127.0.0.1");
      client.pipe(target);
      target.pipe(client);
    });
    await new Promise<void>((resolve) => bridge.listen(socketPath, resolve));
    const decoys = prepareDecoys(path.join(base, "decoys"));
    const launcher = sandboxLauncher({
      kind: "bwrap",
      home: os.homedir(),
      cwd: workspace,
      sessionDir: session,
      writable: [],
      readOnly: [path.join(workspace, "protected.test.ts")],
      decoys: decoys.files,
      ports: [{ port, socketPath, direction: "out" }],
      relay: { command: process.execPath, args: [relay] },
    });
    const script = [
      "echo w > ok.txt && echo WS_WRITE",
      "(echo x > protected.test.ts) 2>/dev/null || echo PROTECTED_RO",
      "cat ~/.ssh/id_ed25519",
      "cat ~/.aws/credentials",
      `node -e "fetch('http://127.0.0.1:${port}/').then(r=>r.text()).then(t=>console.log('RELAY_'+t))" 2>/dev/null || bun -e "console.log('RELAY_'+await (await fetch('http://127.0.0.1:${port}/')).text())"`,
      `node -e "require('net').connect(443,'1.1.1.1').on('error',()=>console.log('NO_NET')).on('connect',()=>console.log('NET_LEAK'))" 2>/dev/null`,
    ].join("; ");
    const output = await new Promise<string>((resolve) => {
      const child = spawn(launcher.command, [...launcher.args, "/bin/sh", "-c", script]);
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("exit", () => resolve(text));
    });
    bridge.close();
    upstream.close();
    expect(output).toContain("WS_WRITE");
    expect(output).toContain("PROTECTED_RO");
    expect(output).toContain(decoys.canaries[2]!);
    expect(output).toContain(decoys.canaries[0]!);
    expect(output).toContain("RELAY_host-ok");
    expect(output).not.toContain("NET_LEAK");
  }, 20_000);
});
