import type { ProjectDiscoveredScriptTarget, ServerLocalServerProcess } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  decideDynamic,
  parseLocalTarget,
  pickDevScript,
  pickLocalTarget,
} from "./dynamicTarget.ts";
import { SCANNERS } from "./registry.ts";

describe("parseLocalTarget", () => {
  it.each([
    ["http://localhost:3000", 3000, "127.0.0.1"],
    ["http://LOCALHOST:3000/path?x=1", 3000, "127.0.0.1"],
    ["http://127.0.0.1:8080", 8080, "127.0.0.1"],
    ["http://127.0.0.1", 80, "127.0.0.1"],
    ["http://[::1]:5173", 5173, "::1"],
    // The URL parser itself normalises these to 127.0.0.1, so they are the same address.
    ["http://0x7f000001:3000", 3000, "127.0.0.1"],
    ["http://2130706433:3000", 3000, "127.0.0.1"],
    ["http://0177.0.0.1:3000", 3000, "127.0.0.1"],
    ["http://127.1:3000", 3000, "127.0.0.1"],
  ])("accepts %s and hands the scanner only the numeric loopback address", (raw, port, bridge) => {
    const result = parseLocalTarget(raw);
    expect(result).toEqual({
      ok: true,
      target: { url: `http://127.0.0.1:${port}`, port, bridgeHost: bridge },
    });
  });

  it.each([
    "http://localhost.evil.com",
    "http://localhost.evil.com:3000",
    "http://evil.com/localhost",
    "http://127.0.0.1@evil.com",
    "http://127.0.0.1:80@evil.com",
    "http://[::1]:80@x",
    "http://user:pass@localhost:3000",
    "http://localhost@127.0.0.1:3000",
    "http://localhost.",
    "http://127.0.0.1.nip.io",
    "http://127.0.0.2:3000",
    "http://127.255.255.254",
    "http://0.0.0.0:3000",
    "http://[::]:3000",
    "http://[::ffff:127.0.0.1]:3000",
    "http://[::ffff:7f00:1]:3000",
    // Decimal, octal and hex forms of addresses that are not loopback.
    "http://3232235777",
    "http://0xc0a80101",
    "http://0300.0250.0.1",
    "http://169.254.169.254",
    "http://10.0.0.1:3000",
    "https://localhost:3000",
    "file:///etc/passwd",
    "ftp://localhost",
    "javascript:alert(1)",
    "localhost:3000",
    "//localhost:3000",
    "",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(parseLocalTarget(raw)).toMatchObject({ ok: false });
  });
});

const server = (addresses: Array<[string, number]>): ServerLocalServerProcess =>
  ({
    id: "1",
    pid: 1,
    command: "node",
    displayName: "node",
    args: "",
    ports: addresses.map(([, port]) => port),
    addresses: addresses.map(([host, port]) => ({ host, port, family: "tcp4", url: null })),
    isStoppable: true,
  }) as unknown as ServerLocalServerProcess;

describe("pickLocalTarget", () => {
  it("takes a loopback or wildcard listener and skips LAN addresses", () => {
    expect(
      pickLocalTarget(
        server([
          ["192.168.1.5", 3000],
          ["127.0.0.1", 3001],
        ]),
      ),
    ).toMatchObject({
      ok: true,
      target: { port: 3001 },
    });
    expect(pickLocalTarget(server([["0.0.0.0", 4000]]))).toMatchObject({
      ok: true,
      target: { port: 4000, bridgeHost: "127.0.0.1" },
    });
    expect(pickLocalTarget(server([["::1", 5000]]))).toMatchObject({
      ok: true,
      target: { port: 5000, bridgeHost: "::1" },
    });
  });

  it("refuses a server that listens only on a non-loopback address", () => {
    expect(pickLocalTarget(server([["192.168.1.5", 3000]]))).toMatchObject({ ok: false });
    expect(pickLocalTarget(server([["example.com", 3000]]))).toMatchObject({ ok: false });
    expect(pickLocalTarget(server([]))).toMatchObject({ ok: false });
  });
});

describe("decideDynamic without an OS sandbox", () => {
  const base = { confirmed: true, startedBy: "user" } as const;

  it("still needs the confirmed run of a person, but not an autonomy level L2 cannot reach", () => {
    expect(decideDynamic({ ...base, autonomy: "L1", sandboxAvailable: false })).toEqual({
      allowed: true,
    });
    expect(decideDynamic({ ...base, autonomy: null, sandboxAvailable: false })).toEqual({
      allowed: true,
    });
    expect(
      decideDynamic({ ...base, confirmed: false, autonomy: "L2", sandboxAvailable: false }),
    ).toMatchObject({ allowed: false });
    expect(
      decideDynamic({ ...base, startedBy: "flow", autonomy: "L2", sandboxAvailable: false }),
    ).toMatchObject({ allowed: false });
    expect(decideDynamic({ ...base, autonomy: "L1", sandboxAvailable: true })).toMatchObject({
      allowed: false,
    });
  });
});

describe("decideDynamic", () => {
  const base = { confirmed: true, autonomy: "L2", startedBy: "user" } as const;

  it("allows only a confirmed run by a person at L2 or higher, on any platform", () => {
    expect(decideDynamic(base)).toEqual({ allowed: true });
    expect(decideDynamic({ ...base, autonomy: "L3" })).toEqual({ allowed: true });
  });

  it.each([
    [{ ...base, confirmed: false }, /Not requested/],
    [{ ...base, startedBy: "flow" }, /person to start/],
    [{ ...base, startedBy: "automation" }, /person to start/],
    [{ ...base, autonomy: null }, /unknown/],
    [{ ...base, autonomy: "L1" as const }, /L2 or higher; it is L1/],
    [{ ...base, autonomy: "L0" as const }, /L2 or higher; it is L0/],
  ])("refuses and says why: %#", (input, reason) => {
    expect(decideDynamic(input)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(reason),
    });
  });

  it("never turns on without the confirmation, whatever else is true", () => {
    for (const autonomy of ["L0", "L1", "L2", "L3", null] as const) {
      expect(decideDynamic({ ...base, autonomy, confirmed: false }).allowed).toBe(false);
    }
  });
});

describe("pickDevScript", () => {
  const targets: ProjectDiscoveredScriptTarget[] = [
    {
      cwd: "/p",
      relativePath: "",
      packageJsonPath: "/p/package.json",
      scripts: [{ name: "dev", command: "npm run dev" }],
    },
    {
      cwd: "/p/web",
      relativePath: "web",
      packageJsonPath: "/p/web/package.json",
      scripts: [{ name: "start", command: "pnpm run start" }],
    },
  ] as unknown as ProjectDiscoveredScriptTarget[];

  it("resolves the command from the project's own scripts, never from the request", () => {
    expect(pickDevScript(targets, { packagePath: "", script: "dev" })).toEqual({
      ok: true,
      command: "npm run dev",
      cwd: "/p",
      label: "dev",
    });
    expect(pickDevScript(targets, { packagePath: "/web/", script: "start" })).toMatchObject({
      ok: true,
      command: "pnpm run start",
      cwd: "/p/web",
    });
  });

  it("falls back to unavailable when the script or folder does not exist", () => {
    expect(pickDevScript(targets, { packagePath: "", script: "start" })).toMatchObject({
      ok: false,
    });
    expect(pickDevScript(targets, { packagePath: "api", script: "dev" })).toMatchObject({
      ok: false,
    });
    expect(pickDevScript([], { packagePath: "", script: "dev" })).toMatchObject({ ok: false });
  });
});

describe("the nuclei invocation", () => {
  const nuclei = SCANNERS.find((scanner) => scanner.id === "nuclei")!;
  const context = {
    root: "/p",
    scratch: "/scratch/nuclei",
    inventory: { languages: [], frameworks: [], surfaces: ["web"], manifests: [] },
    target: { url: "http://127.0.0.1:3000", port: 3000, bridgeHost: "127.0.0.1" as const },
    templates: "/scanners/nuclei-templates",
  };

  it("has no network of its own and runs only when it has a target and local templates", () => {
    expect(nuclei).toMatchObject({ dynamic: true, network: false, egress: [] });
    const { target: _target, ...withoutTarget } = context;
    const { templates: _templates, ...withoutTemplates } = context;
    expect(nuclei.invocation(withoutTarget)).toBeNull();
    expect(nuclei.invocation(withoutTemplates)).toBeNull();
  });

  it("targets only the guarded address with the safe profile and no downloads or callbacks", () => {
    const args = nuclei.invocation(context)!.args;
    expect(args[args.indexOf("-u") + 1]).toBe("http://127.0.0.1:3000");
    expect(args.filter((arg) => arg === "-u")).toHaveLength(1);
    expect(args[args.indexOf("-t") + 1]).toBe("/scanners/nuclei-templates");
    // Never follows redirects, updates itself, or calls out of band.
    for (const required of ["-duc", "-ni", "-jsonl", "-silent"]) expect(args).toContain(required);
    for (const forbidden of [
      "-fr",
      "-follow-redirects",
      "-fhr",
      "-ut",
      "-update-templates",
      "-l",
    ]) {
      expect(args).not.toContain(forbidden);
    }
    const excluded = args[args.indexOf("-etags") + 1]!.split(",");
    for (const tag of ["dos", "fuzz", "intrusive", "bruteforce"]) expect(excluded).toContain(tag);
    expect(args[args.indexOf("-rl") + 1]).toBe("150");
    // No CVE-per-product checks: measured 69 s with them against 25 s without, same real findings.
    expect(args[args.indexOf("-tags") + 1]).toBe("tech,exposure,misconfig");
  });
});
