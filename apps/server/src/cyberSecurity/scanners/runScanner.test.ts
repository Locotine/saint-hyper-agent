import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runScanner, sandboxReadOnlyMounts, UNSANDBOXED_NOTE } from "./runScanner.ts";
import { applicableScanners, SCANNERS } from "./registry.ts";

// The OS sandbox has its own tests; here no sandbox exists, which is also what Windows and a host
// without bwrap or sandbox-exec look like, so the scanner runs plain and the fake binary is reachable.
vi.mock("../../aegis/sandbox.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../aegis/sandbox.ts")>()),
  detectSandbox: () => null,
  sandboxLauncher: vi.fn(),
}));

const inventory = {
  languages: ["JavaScript"],
  frameworks: [],
  surfaces: ["container", "supply-chain"],
  manifests: ["Dockerfile"],
};
const gitleaks = SCANNERS.find((scanner) => scanner.id === "gitleaks")!;
const osv = SCANNERS.find((scanner) => scanner.id === "osv-scanner")!;

let dir = "";
let root = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "saint-scanner-test-"));
  root = path.join(dir, "proj");
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const scratchRoot = () => path.join(dir, "scratch");

/**
 * A scanner stand-in written in JavaScript, so the same fake runs on every platform: an
 * executable script with a node shebang on POSIX, a `.cmd` shim around a `.cjs` file on Windows.
 */
async function fakeBinary(name: string, source: string) {
  if (process.platform === "win32") {
    await writeFile(path.join(dir, `${name}.cjs`), source);
    await writeFile(
      path.join(dir, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
  } else {
    const file = path.join(dir, name);
    await writeFile(file, `#!/usr/bin/env node\n${source}\n`);
    await chmod(file, 0o755);
  }
  vi.stubEnv("SAINT_SCANNER_DIR", dir);
}

/** The value after `flag` in the arguments the fake was started with. */
const ARG = `const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1];`;

describe("runScanner", () => {
  it("runs the shipped binary and reads the report it writes", async () => {
    await fakeBinary(
      "gitleaks",
      `${ARG}
require("node:fs").writeFileSync(arg("--report-path"), JSON.stringify([
  { RuleID: "generic-api-key", File: ${JSON.stringify(path.join(root, "a.txt"))}, StartLine: 3, Description: "key" },
]));`,
    );
    const outcome = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(outcome.status).toBe("done");
    expect(outcome.findings).toEqual([
      expect.objectContaining({ file: "a.txt", line: 3, category: "secrets" }),
    ]);
  });

  it("says it ran without an OS sandbox, whatever the outcome", async () => {
    await fakeBinary("gitleaks", "process.exit(0);");
    const clean = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(clean).toMatchObject({
      status: "done",
      summary: `No findings.; ${UNSANDBOXED_NOTE}`,
      findings: [],
    });
    // Linux is the one platform where the person can fix a missing sandbox (install bubblewrap),
    // so only there is it raised for the dialog.
    if (process.platform === "linux") expect(clean.attention).toMatch(/bubblewrap.*apt install/u);
    else expect(clean.attention).toBeUndefined();
    expect(UNSANDBOXED_NOTE).toContain("advisory");

    await fakeBinary("gitleaks", `console.error("boom"); process.exit(3);`);
    const broken = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(broken.status).toBe("failed");
    expect(broken.summary).toContain("boom");
    expect(broken.summary).toContain(UNSANDBOXED_NOTE);
  });

  it("starts the scanner with a minimal environment, without the server's tokens", async () => {
    vi.stubEnv("SAINT_AUTH_TOKEN", "server-token");
    vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
    await fakeBinary(
      "gitleaks",
      `${ARG}
const keys = Object.keys(process.env).map((key) => key.toLowerCase());
require("node:fs").writeFileSync(arg("--report-path"), JSON.stringify([
  { RuleID: JSON.stringify({ keys, hasPath: keys.includes("path") }), File: "x", StartLine: 1 },
]));`,
    );
    const outcome = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    const seen = JSON.parse(outcome.findings[0]!.title.replace("Secret in source: ", ""));
    expect(seen.hasPath).toBe(true);
    expect(seen.keys).not.toContain("saint_auth_token");
    expect(seen.keys).not.toContain("github_token");
    expect(seen.keys).toEqual(expect.arrayContaining(["ci", "no_color"]));
  });

  it("is unavailable when the binary is not installed", async () => {
    vi.stubEnv("SAINT_SCANNER_DIR", dir);
    vi.stubEnv("PATH", dir);
    const outcome = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.summary).toContain("not installed");
  });

  it("does not start a scanner that needs the network while offline", async () => {
    await fakeBinary("osv-scanner", "process.exit(2);");
    const outcome = await runScanner(osv, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(outcome).toEqual(expect.objectContaining({ status: "unavailable", findings: [] }));
    expect(outcome.summary).toContain("online");
  });

  it("reports why a network scanner stayed offline", async () => {
    await fakeBinary("osv-scanner", "process.exit(2);");
    const outcome = await runScanner(osv, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
      offlineReason: "Online scanning needs autonomy L2 or higher; it is L1.",
    });
    expect(outcome.summary).toBe("Online scanning needs autonomy L2 or higher; it is L1.");
  });

  it("runs a network scanner without an OS sandbox through the proxy, and says the limits are advisory", async () => {
    vi.stubEnv("SAINT_AUTH_TOKEN", "server-token");
    await fakeBinary(
      "osv-scanner",
      `const env = process.env;
const seen = { proxy: Boolean(env.HTTPS_PROXY || env.https_proxy), token: env.SAINT_AUTH_TOKEN ?? null };
process.stdout.write(JSON.stringify({ results: [{ source: { path: "package-lock.json" }, packages: [
  { package: { name: "left-pad", version: "1.0.0" }, vulnerabilities: [{ id: "GHSA-1", summary: JSON.stringify(seen) }] },
] }] }));`,
    );
    const outcome = await runScanner(osv, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: true,
    });
    expect(outcome.status).toBe("done");
    expect(JSON.parse(outcome.findings[0]!.detail)).toEqual({ proxy: true, token: null });
    expect(outcome.summary).toContain(UNSANDBOXED_NOTE);
  });

  it("fails when the scanner errors without producing a report", async () => {
    await fakeBinary("gitleaks", `console.error("boom"); process.exit(3);`);
    const outcome = await runScanner(gitleaks, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("boom");
  });
});

describe("runScanner for a dynamic scanner", () => {
  const nuclei = SCANNERS.find((scanner) => scanner.id === "nuclei")!;
  const dynamic = (templates: string) => ({
    target: { url: "http://127.0.0.1:3000", port: 3000, bridgeHost: "127.0.0.1" as const },
    templates,
  });

  it("does not run without a target", async () => {
    await fakeBinary("nuclei", `process.stderr.write("should-not-run"); process.exit(9);`);
    const outcome = await runScanner(nuclei, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: true,
    });
    expect(outcome).toMatchObject({ status: "unavailable", summary: "No running app to scan." });
  });

  it("runs without an OS sandbox against the one guarded target, with the safe flags, and says so", async () => {
    vi.stubEnv("SAINT_AUTH_TOKEN", "server-token");
    const templates = path.join(dir, "templates");
    await mkdir(templates, { recursive: true });
    const record = path.join(dir, "invocation.json");
    await fakeBinary(
      "nuclei",
      `${ARG}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.SAINT_AUTH_TOKEN ?? null,
  cwd: process.cwd(),
}));
fs.writeFileSync(arg("-o"), JSON.stringify({
  "template-id": "exposed-env",
  info: { name: "Exposed .env", severity: "high", description: "served", tags: ["exposure"] },
  "matched-at": "http://127.0.0.1:3000/.env",
}) + "\\n");`,
    );
    const outcome = await runScanner(nuclei, {
      root,
      inventory,
      scratchRoot: scratchRoot(),
      online: false,
      dynamic: dynamic(templates),
    });
    expect(outcome.status).toBe("done");
    expect(outcome.findings).toEqual([expect.objectContaining({ category: expect.any(String) })]);
    expect(outcome.summary).toContain(UNSANDBOXED_NOTE);

    const ran = JSON.parse(await readFile(record, "utf8")) as {
      args: string[];
      token: string | null;
      cwd: string;
    };
    const flag = (name: string) => ran.args[ran.args.indexOf(name) + 1];
    // Held to the one target and to no network features, by its arguments alone.
    expect(flag("-u")).toBe("http://127.0.0.1:3000");
    expect(flag("-t")).toBe(templates);
    expect(ran.args).toEqual(expect.arrayContaining(["-duc", "-ni"]));
    expect(ran.args.filter((arg) => arg === "-u")).toHaveLength(1);
    expect(ran.token).toBeNull();
    expect(ran.cwd.startsWith(scratchRoot())).toBe(true);
  });
});

describe("sandboxReadOnlyMounts", () => {
  const base = { root: "/p/app", binary: "/state/cyber-security/tools/trivy-1/trivy" };

  it("mounts the folder of a fetched or shipped executable so a sandbox can start it", () => {
    expect(sandboxReadOnlyMounts({ ...base, toolsDir: "/state/cyber-security/tools" })).toEqual([
      "/p/app",
      "/state/cyber-security/tools/trivy-1",
    ]);
    expect(
      sandboxReadOnlyMounts({
        root: "/p/app",
        binary: "/home/u/.saint/scanners/v1/trivy",
        shippedDir: "/home/u/.saint/scanners/v1",
        templates: "/home/u/.saint/scanners/v1/nuclei-templates",
      }),
    ).toEqual([
      "/p/app",
      "/home/u/.saint/scanners/v1/nuclei-templates",
      "/home/u/.saint/scanners/v1",
    ]);
  });

  it("adds nothing for a binary found on PATH, which the sandbox already sees", () => {
    expect(
      sandboxReadOnlyMounts({
        root: "/p/app",
        binary: "/usr/local/bin/trivy",
        toolsDir: "/state/cyber-security/tools",
      }),
    ).toEqual(["/p/app"]);
  });
});

describe("a scanner that is not installed", () => {
  const input = () => ({
    root,
    inventory,
    scratchRoot: scratchRoot(),
    toolsDir: path.join(dir, "tools"),
    online: true,
  });

  it("is not downloaded unless the run allows it, and says why", async () => {
    vi.stubEnv("SAINT_SCANNER_DIR", path.join(dir, "empty"));
    vi.stubEnv("PATH", path.join(dir, "empty"));
    const outcome = await runScanner(gitleaks, {
      ...input(),
      download: false,
      offlineReason: "Online scanning needs autonomy L2 or higher; it is L1.",
    });
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(outcome.summary).toContain("autonomy L2");
  });

  it("asks the person to allow github.com when the download cannot be made", async () => {
    vi.stubEnv("SAINT_SCANNER_DIR", path.join(dir, "empty"));
    vi.stubEnv("PATH", path.join(dir, "empty"));
    const outcome = await runScanner(gitleaks, {
      ...input(),
      download: true,
      downloadBytes: async () => {
        throw new Error("getaddrinfo ENOTFOUND github.com");
      },
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.attention).toMatch(/reach github\.com.*install gitleaks and put it on PATH/u);
  });

  it("discards a download that does not match its pin and is a failure, not a request", async () => {
    vi.stubEnv("SAINT_SCANNER_DIR", path.join(dir, "empty"));
    vi.stubEnv("PATH", path.join(dir, "empty"));
    const outcome = await runScanner(gitleaks, {
      ...input(),
      download: true,
      downloadBytes: async () => Buffer.from("not the release"),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("pinned checksum");
    expect(outcome.attention).toBeUndefined();
  });
});

describe("applicableScanners", () => {
  it("always runs the secret and config scanners and the rest only for their surfaces", () => {
    const ids = (surfaces: string[]) =>
      applicableScanners({ ...inventory, surfaces }).map((scanner) => scanner.id);
    expect(ids([])).toEqual(["gitleaks", "trivy"]);
    expect(ids(["web"])).toEqual(["gitleaks", "trivy", "nuclei"]);
    expect(ids(["container", "supply-chain"])).toEqual([
      "gitleaks",
      "hadolint",
      "osv-scanner",
      "trivy",
    ]);
  });
});
