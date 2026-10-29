import http from "node:http";
import net from "node:net";

import { describe, expect, it } from "vitest";

import { startEgressProxy } from "./egressProxy";
import {
  DEFAULT_EGRESS_ALLOWLIST,
  autonomyLocks,
  egressVerdict,
  evaluatePolicy,
  runtimeModeCap,
  scanForTripwire,
} from "./rules";
import { sandboxArgv } from "./sandbox";

const settings = {
  egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
  egressDenylist: ["evil.example"],
  rules: [{ effect: "permit" as const, principal: "*", action: "egress", resource: "*.corp.test" }],
};

describe("autonomy", () => {
  it("caps approval mode by level", () => {
    expect(runtimeModeCap("L0", "full-access")).toBe("approval-required");
    expect(runtimeModeCap("L1", "full-access")).toBe("auto");
    expect(runtimeModeCap("L2", "full-access")).toBe("full-access");
    expect(runtimeModeCap("L2", "approval-required")).toBe("approval-required");
  });

  it("locks levels the host cannot back", () => {
    expect(
      Object.keys(autonomyLocks({ sandboxAvailable: false, tripwires: 9, signedOff: true })),
    ).toEqual(["L4", "L2", "L3"]);
    expect(autonomyLocks({ sandboxAvailable: true, tripwires: 2, signedOff: true }).L3).toContain(
      "3 tripwires",
    );
    expect(autonomyLocks({ sandboxAvailable: true, tripwires: 9, signedOff: false }).L3).toContain(
      "sign-off",
    );
    expect(
      autonomyLocks({ sandboxAvailable: true, tripwires: 9, signedOff: true }).L3,
    ).toBeUndefined();
  });
});

describe("policy and egress", () => {
  it("forbid wins over permit", () => {
    const rules = [
      { effect: "permit" as const, principal: "*", action: "saint_*", resource: "*" },
      {
        effect: "forbid" as const,
        principal: "node:qa",
        action: "saint_flow_start",
        resource: "*",
      },
    ];
    expect(
      evaluatePolicy(
        rules,
        { principal: "node:qa", action: "saint_flow_start", resource: "x" },
        "permit",
      ),
    ).toBe("forbid");
    expect(
      evaluatePolicy(
        rules,
        { principal: "node:coder", action: "saint_flow_start", resource: "x" },
        "forbid",
      ),
    ).toBe("permit");
  });

  it.each([
    ["api.anthropic.com", "allow"],
    ["evil.example", "deny"],
    ["git.corp.test", "allow"],
    ["unknown.example", "unknown"],
  ])("%s → %s", (host, verdict) => {
    expect(egressVerdict(settings, host)).toBe(verdict);
  });

  it("proxy refuses unknown hosts over CONNECT and reports them once", async () => {
    const reported: string[] = [];
    const upstream = http.createServer((_request, response) => response.end("hi"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
      decide: (host) => (host === "127.0.0.1" ? "allow" : "unknown"),
      onUnknown: (host) => reported.push(host),
    });
    const connect = (authority: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () =>
          socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
        );
        socket.once("data", (data) => {
          resolve(data.toString().split("\r\n")[0]!);
          socket.destroy();
        });
      });
    expect(await connect("blocked.example:443")).toContain("403");
    expect(await connect("blocked.example:443")).toContain("403");
    expect(await connect(`127.0.0.1:${upstreamPort}`)).toContain("200");
    expect(reported).toEqual(["blocked.example"]);
    await proxy.close();
    upstream.close();
  });
});

describe("tripwire", () => {
  it("finds canaries and credential paths", () => {
    const canary = "AKIA0123456789ABCDEF";
    expect(scanForTripwire(`{"cmd":"cat x","out":"${canary}"}`, [canary])?.kind).toBe("canary");
    expect(scanForTripwire('{"cmd":"cat ~/.aws/credentials"}', [])?.kind).toBe("sensitive_path");
    expect(scanForTripwire('{"cmd":"cat ~/.ssh/id_ed25519"}', [])?.kind).toBe("sensitive_path");
    expect(scanForTripwire('{"cmd":"bun run test"}', [canary])).toBeNull();
  });
});

describe("sandbox argv", () => {
  it("bwrap binds the workspace and cuts the network without a proxy", () => {
    const { file, args } = sandboxArgv({
      kind: "bwrap",
      cwd: "/work/repo",
      home: "/nonexistent-home",
      scratch: "/tmp/scratch",
      decoys: [],
      command: "bun run test",
      proxyPort: null,
    });
    expect(file).toBe("bwrap");
    expect(args.join(" ")).toContain("--bind /work/repo /work/repo");
    expect(args).toContain("--unshare-net");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "bun run test"]);
  });

  it("sandbox-exec denies credential reads and allows only the proxy port", () => {
    const { args } = sandboxArgv({
      kind: "sandbox-exec",
      cwd: "/work/repo",
      home: "/Users/me",
      scratch: "/tmp/scratch",
      decoys: [],
      command: "make test",
      proxyPort: 4100,
    });
    const profile = args[1]!;
    expect(profile).toContain('(subpath "/Users/me/.ssh")');
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("localhost:4100");
  });
});
