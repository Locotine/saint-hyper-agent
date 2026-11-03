import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EGRESS_ALLOWLIST } from "../../aegis/rules.ts";
import { decideOnline, hostAllowed, openScannerEgress, type ScannerEgress } from "./egress.ts";
import { SCANNERS } from "./registry.ts";

const person = { startedBy: "user" } as const;

describe("decideOnline", () => {
  it("goes online only for a person's run at L2 or higher", () => {
    expect(decideOnline({ ...person, autonomy: "L2" })).toEqual({ online: true });
    expect(decideOnline({ ...person, autonomy: "L3" })).toEqual({ online: true });
  });

  it.each([
    [{ ...person, autonomy: "L1" as const }, /L2 or higher; it is L1/],
    [{ ...person, autonomy: "L0" as const }, /L2 or higher; it is L0/],
    [{ ...person, autonomy: null }, /unknown/],
    [{ ...person, autonomy: "L2" as const, startedBy: "flow" }, /person to start/],
  ])("stays offline and says why: %#", (input, reason) => {
    const decision = decideOnline(input);
    expect(decision.online).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringMatching(reason) });
  });
});

describe("decideOnline on a host with no OS sandbox", () => {
  it("lets the person's own run go online where L2 can never be reached", () => {
    // Aegis locks L2 without an OS sandbox (Windows, Linux without bwrap), so requiring it would
    // switch network scanners and first-use downloads off for good on those hosts.
    for (const autonomy of ["L0", "L1", null] as const) {
      expect(decideOnline({ ...person, autonomy, sandboxAvailable: false })).toEqual({
        online: true,
      });
    }
    // Only the person starting it counts; a flow or an agent still cannot.
    expect(
      decideOnline({ startedBy: "agent", autonomy: "L2", sandboxAvailable: false }),
    ).toMatchObject({ online: false });
  });

  it("keeps the L2 gate wherever a sandbox exists", () => {
    expect(decideOnline({ ...person, autonomy: "L1", sandboxAvailable: true })).toMatchObject({
      online: false,
    });
    expect(decideOnline({ ...person, autonomy: "L2", sandboxAvailable: true })).toEqual({
      online: true,
    });
  });
});

describe("scanner allowlists", () => {
  const networkScanners = SCANNERS.filter((scanner) => scanner.network);

  it("gives every network scanner some hosts and every other scanner none", () => {
    for (const scanner of SCANNERS) {
      expect(scanner.egress.length > 0).toBe(scanner.network);
    }
  });

  it("allows a scanner's own hosts only", () => {
    const osv = networkScanners.find((scanner) => scanner.id === "osv-scanner")!;
    expect(hostAllowed(osv.egress, "api.osv.dev")).toBe(true);
    expect(hostAllowed(osv.egress, "API.OSV.DEV")).toBe(true);
    expect(hostAllowed(osv.egress, "ghcr.io")).toBe(false);
    expect(hostAllowed(osv.egress, "evil.osv.dev.example.com")).toBe(false);
    expect(hostAllowed(osv.egress, "169.254.169.254")).toBe(false);
  });

  it("never reaches the providers' hosts or loopback", () => {
    for (const scanner of networkScanners) {
      for (const host of DEFAULT_EGRESS_ALLOWLIST) {
        expect(hostAllowed(scanner.egress, host.replace("*.", "x."))).toBe(false);
      }
    }
  });
});

describe("openScannerEgress", () => {
  let egress: ScannerEgress | null = null;
  let upstream: http.Server | null = null;
  afterEach(async () => {
    await egress?.close();
    await new Promise<void>((done) => (upstream ? upstream.close(() => done()) : done()));
    egress = null;
    upstream = null;
  });

  const through = (proxyUrl: string, target: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const proxy = new URL(proxyUrl);
      http
        .request(
          {
            host: proxy.hostname,
            port: proxy.port,
            path: target,
            headers: { host: new URL(target).host },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        )
        .on("error", reject)
        .end();
    });

  it("hands the scanner only the proxy variables", async () => {
    egress = await openScannerEgress(["osv.dev"], "sandbox-exec");
    expect(Object.keys(egress.env).toSorted()).toEqual(
      ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"].toSorted(),
    );
    expect(egress.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(egress.ports).toEqual([
      { port: Number(new URL(egress.env.HTTPS_PROXY!).port), socketPath: "", direction: "out" },
    ]);
    expect(egress.relay).toBeNull();
  });

  it("relays the port through a socket under bwrap", async () => {
    egress = await openScannerEgress(["osv.dev"], "bwrap");
    expect(egress.ports[0]?.socketPath).toMatch(/saint-cs-[^/]+\/o\d+\.sock$/);
    expect(egress.relay?.args[0]).toMatch(/saint-cs-[^/]+\/relay\.mjs$/);
  });

  it("forwards an allowed host and refuses and records any other", async () => {
    upstream = http.createServer((_, response) => response.end("from upstream"));
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    egress = await openScannerEgress(["127.0.0.1"], "sandbox-exec");

    const allowed = await through(egress.env.HTTP_PROXY!, `http://127.0.0.1:${port}/x`);
    expect(allowed).toEqual({ status: 200, body: "from upstream" });
    const refused = await through(egress.env.HTTP_PROXY!, "http://elsewhere.invalid/x");
    expect(refused.status).toBe(403);
    expect(egress.refused()).toEqual(["elsewhere.invalid"]);
  });

  it("frees the proxy port when closed", async () => {
    egress = await openScannerEgress(["osv.dev"], "sandbox-exec");
    const url = egress.env.HTTP_PROXY!;
    await egress.close();
    egress = null;
    await expect(through(url, "http://osv.dev/")).rejects.toThrow();
  });
});
