import { spawn, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTarGzStream } from "./remoteSshBundle";
import {
  buildRemoteInstallScript,
  buildRemoteProbeScript,
  buildRemoteStartScript,
  buildRemoteStopScript,
  buildRemoteUploadCommand,
  hasRemoteReport,
  isRemoteNodeVersionSupported,
  parseRemoteProbeReport,
  parseRemoteStartReport,
  quoteShell,
  remoteTmuxSessionName,
} from "./remoteSshScripts";

const target = {
  remoteRoot: "squad/saint-remote",
  storeRoot: ".saint-remote",
  version: "1.2.3",
  depsHash: "0123456789ab",
};

describe("remote script builders", () => {
  it("quotes shell values", () => {
    expect(quoteShell("a'b")).toBe(`'a'"'"'b'`);
  });

  it("derives a tmux session per install folder", () => {
    expect(remoteTmuxSessionName(".saint-remote")).toBe("saint-remote");
    expect(remoteTmuxSessionName("squad/saint")).toBe("squad-saint");
  });

  it("refuses versions and tokens that are unsafe to embed", () => {
    expect(() => buildRemoteProbeScript({ ...target, version: "1.0; rm -rf ~" })).toThrow();
    expect(() => buildRemoteProbeScript({ ...target, depsHash: "$(id)" })).toThrow();
    expect(() => buildRemoteStartScript(target, { token: "a'b" })).toThrow();
    expect(() =>
      buildRemoteStartScript(target, { token: "abc", devUrl: "http://x/$(id)" }),
    ).toThrow();
  });

  it.runIf(process.platform !== "win32")("produces syntactically valid sh", () => {
    for (const script of [
      buildRemoteProbeScript(target),
      buildRemoteInstallScript(target),
      buildRemoteStartScript(target, { token: "abc123", devUrl: "http://localhost:5733" }),
      buildRemoteStopScript(target),
    ]) {
      const result = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });
});

describe("report parsers", () => {
  it("reads the probe report past login banners", () => {
    const stdout = [
      "Welcome to devbox",
      'SAINT_REMOTE {"kind":"probe","node":"v24.17.0","npm":true,"installed":false,"server":{"info":{"port":4100,"version":"1.2.3"},"token":"abc"}}',
    ].join("\n");
    expect(parseRemoteProbeReport(stdout)).toEqual({
      nodeVersion: "v24.17.0",
      npm: true,
      installed: false,
      depsInstalled: false,
      server: { port: 4100, version: "1.2.3", token: "abc" },
    });
  });

  it("treats a missing node and a malformed server as absent", () => {
    expect(
      parseRemoteProbeReport(
        'SAINT_REMOTE {"kind":"probe","node":"","npm":false,"installed":true,"server":{"info":{"port":"x"}}}',
      ),
    ).toEqual({
      nodeVersion: null,
      npm: false,
      installed: true,
      depsInstalled: false,
      server: null,
    });
    expect(parseRemoteProbeReport("no report")).toBeNull();
  });

  it("reads start and completion reports", () => {
    expect(parseRemoteStartReport('SAINT_REMOTE {"kind":"started","port":4100}')).toEqual({
      port: 4100,
    });
    expect(parseRemoteStartReport('SAINT_REMOTE {"kind":"started","port":0}')).toBeNull();
    expect(hasRemoteReport('SAINT_REMOTE {"kind":"installed"}', "installed")).toBe(true);
    expect(hasRemoteReport('SAINT_REMOTE {"kind":"installed"}', "stopped")).toBe(false);
  });

  it.each([
    ["v22.16.0", true],
    ["v22.23.2", true],
    ["v23.11.0", true],
    ["v24.13.1", true],
    ["v26.0.0", true],
    ["v22.15.1", false],
    ["v23.10.0", false],
    ["v20.19.0", false],
    ["", false],
    [null, false],
  ])("Node %s supported: %s", (version, expected) => {
    expect(isRemoteNodeVersionSupported(version)).toBe(expected);
  });
});

// Runs the real scripts with `sh` against a throwaway HOME. npm and tmux are
// stubs; node is the test runner's own binary, serving a fake server bundle.
describe.runIf(process.platform !== "win32")("remote scripts end to end", () => {
  let home: string;
  let bin: string;

  const run = (script: string, input?: Buffer | string, env: Record<string, string> = {}) =>
    spawnSync("sh", input === undefined ? ["-s"] : ["-c", script], {
      input: input ?? script,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });

  beforeEach(() => {
    home = FS.mkdtempSync(Path.join(OS.tmpdir(), "saint-remote-ssh-"));
    bin = Path.join(home, "stub-bin");
    FS.mkdirSync(bin);
    FS.symlinkSync(process.execPath, Path.join(bin, "node"));
    FS.writeFileSync(
      Path.join(bin, "npm"),
      [
        "#!/bin/sh",
        'echo "$*" >>"$HOME/npm-runs"',
        "mkdir -p node_modules/@pierre/diffs node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
        'printf "old\\n" >node_modules/@pierre/diffs/index.js',
        ": >node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
        "here=$(node -p 'process.platform + \"-\" + process.arch')",
        'mkdir -p "node_modules/node-pty/prebuilds/$here" node_modules/node-pty/prebuilds/win32-x64',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    FS.writeFileSync(
      Path.join(bin, "tmux"),
      [
        "#!/bin/sh",
        'if [ "$1" = new-session ]; then shift 4; nohup sh -c "$1" >/dev/null 2>&1 & fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    run(buildRemoteStopScript(target));
    FS.rmSync(home, { recursive: true, force: true });
  });

  it("uploads, installs with patches, starts, reuses, and stops a server", async () => {
    const probe = parseRemoteProbeReport(run(buildRemoteProbeScript(target)).stdout);
    expect(probe).toMatchObject({ npm: true, installed: false, server: null });
    expect(probe?.nodeVersion).toMatch(/^v\d+\./);

    const server = [
      'import { createServer } from "node:http";',
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
      "const token = process.env.SAINT_AUTH_TOKEN;",
      'createServer((req, res) => { res.end(req.url === "/health" ? token : "x"); }).listen(port, "127.0.0.1");',
    ].join("\n");
    const patch = ["--- a/index.js", "+++ b/index.js", "@@ -1 +1 @@", "-old", "+patched", ""].join(
      "\n",
    );
    const chunks: Buffer[] = [];
    for await (const chunk of createTarGzStream([
      { path: "dist/index.mjs", contents: Buffer.from(server) },
      { path: "package.json", contents: Buffer.from("{}") },
      { path: "patches/index.tsv", contents: Buffer.from("@pierre/diffs\tdiffs.patch\n") },
      { path: "patches/diffs.patch", contents: Buffer.from(patch) },
    ])) {
      chunks.push(chunk as Buffer);
    }
    const upload = run(buildRemoteUploadCommand(target), Buffer.concat(chunks));
    expect(upload.stderr).toBe("");
    expect(upload.status).toBe(0);

    const install = run(buildRemoteInstallScript(target));
    expect(install.status).toBe(0);
    expect(hasRemoteReport(install.stdout, "installed")).toBe(true);
    const installDir = Path.join(home, target.storeRoot, "versions", target.version);
    // node_modules links to the shared dependency folder for this ABI.
    const link = FS.readlinkSync(Path.join(installDir, "node_modules"));
    expect(link).toMatch(
      new RegExp(`^\\.\\./\\.\\./deps/${target.depsHash}-[a-z]+-[^/]+-node\\d+/node_modules$`, "u"),
    );
    expect(
      FS.readFileSync(Path.join(installDir, "node_modules/@pierre/diffs/index.js"), "utf8"),
    ).toBe("patched\n");
    expect(FS.readFileSync(Path.join(home, "npm-runs"), "utf8")).toContain("--omit=optional");
    // Only this platform's node-pty prebuilds stay.
    expect(FS.readdirSync(Path.join(installDir, "node_modules/node-pty/prebuilds"))).toEqual([
      `${process.platform}-${process.arch}`,
    ]);
    // The host's `claude` runs agents, so the SDK's bundled binary is dropped.
    expect(FS.existsSync(Path.join(installDir, "node_modules/@anthropic-ai"))).toBe(true);
    expect(
      FS.existsSync(Path.join(installDir, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64")),
    ).toBe(false);
    expect(FS.existsSync(Path.join(home, target.remoteRoot, "staging"))).toBe(false);

    const start = run(buildRemoteStartScript(target, { token: "tok123" }));
    expect(start.stderr).toBe("");
    const started = parseRemoteStartReport(start.stdout);
    expect(started).not.toBeNull();
    const health = await fetch(`http://127.0.0.1:${started?.port}/health`);
    expect(await health.text()).toBe("tok123");
    const runDir = Path.join(home, target.remoteRoot, "run");
    expect(FS.statSync(Path.join(runDir, "token")).mode & 0o077).toBe(0);
    const serverScript = FS.readFileSync(Path.join(runDir, "server.sh"), "utf8");
    expect(serverScript).not.toContain("tok123");
    expect(serverScript).toContain("export SAINT_PROVIDERS=codex,claudeAgent");
    expect(serverScript).toContain("export SAINT_PROVIDER_RUNTIME_IDLE_STOP_MS=180000");
    expect(serverScript).toContain("export SAINT_IDLE_EXIT_MS=600000");
    expect(serverScript).toContain("exec node --max-old-space-size=1024 --max-semi-space-size=8 ");

    const reprobe = parseRemoteProbeReport(run(buildRemoteProbeScript(target)).stdout);
    expect(reprobe).toMatchObject({
      installed: true,
      depsInstalled: true,
      server: { port: started?.port, version: target.version, token: "tok123" },
    });

    expect(hasRemoteReport(run(buildRemoteStopScript(target)).stdout, "stopped")).toBe(true);
    expect(parseRemoteProbeReport(run(buildRemoteProbeScript(target)).stdout)?.server).toBeNull();
  }, 90_000);

  it("fails the install when a patch no longer applies", async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of createTarGzStream([
      { path: "package.json", contents: Buffer.from("{}") },
      { path: "patches/index.tsv", contents: Buffer.from("@pierre/diffs\tdiffs.patch\n") },
      {
        path: "patches/diffs.patch",
        contents: Buffer.from("--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-other\n+patched\n"),
      },
    ])) {
      chunks.push(chunk as Buffer);
    }
    expect(run(buildRemoteUploadCommand(target), Buffer.concat(chunks)).status).toBe(0);
    const install = run(buildRemoteInstallScript(target));
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("Could not apply diffs.patch");
    expect(
      FS.existsSync(Path.join(home, target.storeRoot, "versions", target.version, ".installed")),
    ).toBe(false);
  });

  it("shares one install across folders and keeps only versions a server runs", async () => {
    const server = [
      'import { createServer } from "node:http";',
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
      'createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");',
    ].join("\n");
    const chunks: Buffer[] = [];
    for await (const chunk of createTarGzStream([
      { path: "dist/index.mjs", contents: Buffer.from(server) },
      { path: "package.json", contents: Buffer.from("{}") },
    ])) {
      chunks.push(chunk as Buffer);
    }
    expect(run(buildRemoteUploadCommand(target), Buffer.concat(chunks)).status).toBe(0);
    expect(hasRemoteReport(run(buildRemoteInstallScript(target)).stdout, "installed")).toBe(true);

    // A second folder finds the version already installed in the shared store.
    const other = { ...target, remoteRoot: "other/saint-remote" };
    const otherProbe = parseRemoteProbeReport(run(buildRemoteProbeScript(other)).stdout);
    expect(otherProbe).toMatchObject({ installed: true, server: null });

    // A stale store version and a pre-store per-folder install both go on start.
    const store = Path.join(home, target.storeRoot, "versions");
    FS.mkdirSync(Path.join(store, "1.0.0", "dist"), { recursive: true });
    FS.mkdirSync(Path.join(home, other.remoteRoot, "versions", "1.0.0"), { recursive: true });
    const start = run(buildRemoteStartScript(other, { token: "tok456" }));
    expect(start.stderr).toBe("");
    expect(parseRemoteStartReport(start.stdout)).not.toBeNull();
    expect(FS.readdirSync(store)).toEqual([target.version]);
    expect(FS.existsSync(Path.join(home, other.remoteRoot, "versions"))).toBe(false);

    // A version another folder's server still runs survives a start.
    const busyEntry = Path.join(store, "1.1.0", "dist", "index.mjs");
    FS.mkdirSync(Path.dirname(busyEntry), { recursive: true });
    FS.writeFileSync(busyEntry, "setInterval(() => {}, 1000);");
    const busy = spawn(process.execPath, [busyEntry, "--mode", "web"], { stdio: "ignore" });
    try {
      expect(run(buildRemoteStartScript(other, { token: "tok789" })).status).toBe(0);
      expect(FS.readdirSync(store).toSorted()).toEqual(["1.1.0", target.version]);
    } finally {
      busy.kill();
    }
    run(buildRemoteStopScript(other));
  }, 90_000);

  const bundle = async (entries: Array<{ path: string; contents: string }>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of createTarGzStream(
      entries.map((entry) => ({ path: entry.path, contents: Buffer.from(entry.contents) })),
    )) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  };
  const okServer = [
    'import { createServer } from "node:http";',
    'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
    'createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");',
  ].join("\n");
  const install = async (scriptTarget: typeof target, server = okServer) => {
    const upload = run(
      buildRemoteUploadCommand(scriptTarget),
      await bundle([
        { path: "dist/index.mjs", contents: server },
        { path: "package.json", contents: "{}" },
      ]),
    );
    expect(upload.status).toBe(0);
    const result = run(buildRemoteInstallScript(scriptTarget));
    expect(result.status).toBe(0);
    expect(hasRemoteReport(result.stdout, "installed")).toBe(true);
  };
  const npmRuns = () =>
    FS.existsSync(Path.join(home, "npm-runs"))
      ? FS.readFileSync(Path.join(home, "npm-runs"), "utf8").trim().split("\n").length
      : 0;

  it("stops an earlier install of the folder that is still running", async () => {
    const staging = Path.join(home, target.remoteRoot, "staging");
    FS.mkdirSync(staging, { recursive: true });
    const orphan = spawn("sh", ["-s"], { stdio: ["pipe", "ignore", "ignore"] });
    orphan.stdin.write("sleep 60\n");
    const exited = new Promise((resolve) => orphan.once("exit", resolve));
    FS.writeFileSync(Path.join(staging, "install.pid"), String(orphan.pid));
    try {
      await install(target);
      await expect(exited).resolves.not.toBeUndefined();
      expect(FS.existsSync(Path.join(staging, "install.pid"))).toBe(false);
    } finally {
      orphan.kill("SIGKILL");
    }
  });

  it("reuses installed dependencies for a new version and moves links on a new hash", async () => {
    await install(target);
    expect(npmRuns()).toBe(1);

    // A rebuild with the same npm manifest installs no dependencies again.
    const next = { ...target, version: "1.2.4" };
    expect(parseRemoteProbeReport(run(buildRemoteProbeScript(next)).stdout)).toMatchObject({
      installed: false,
      depsInstalled: true,
    });
    await install(next);
    expect(npmRuns()).toBe(1);

    // New dependencies for an installed version relink it in place.
    const relinked = { ...target, depsHash: "fedcba987654" };
    expect(parseRemoteProbeReport(run(buildRemoteProbeScript(relinked)).stdout)).toMatchObject({
      installed: false,
      depsInstalled: false,
    });
    await install(relinked);
    expect(npmRuns()).toBe(2);
    const versionDir = Path.join(home, target.storeRoot, "versions", target.version);
    expect(FS.readlinkSync(Path.join(versionDir, "node_modules"))).toContain("/fedcba987654-");
    expect(parseRemoteProbeReport(run(buildRemoteProbeScript(relinked)).stdout)?.installed).toBe(
      true,
    );
  }, 90_000);

  it("removes dependency folders no version links once they are an hour old", async () => {
    await install(target);
    const depsStore = Path.join(home, target.storeRoot, "deps");
    const stale = Path.join(depsStore, "aaaaaaaaaaaa-linux-x64-node1");
    const fresh = Path.join(depsStore, "bbbbbbbbbbbb-linux-x64-node1");
    FS.mkdirSync(stale);
    FS.mkdirSync(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    FS.utimesSync(stale, old, old);
    const start = run(buildRemoteStartScript(target, { token: "tok1" }));
    expect(start.stderr).toBe("");
    const left = FS.readdirSync(depsStore);
    expect(left).not.toContain(Path.basename(stale));
    expect(left).toContain(Path.basename(fresh));
    expect(left.some((name) => name.startsWith(`${target.depsHash}-`))).toBe(true);
  }, 90_000);

  it("runs a version from the read-only shared store without installing", async () => {
    // An administrator's install, copied as is into the shared store.
    await install(target);
    const shared = Path.join(home, "shared-store");
    FS.cpSync(Path.join(home, target.storeRoot), shared, {
      recursive: true,
      verbatimSymlinks: true,
    });
    FS.rmSync(Path.join(home, target.storeRoot), { recursive: true, force: true });
    const env = { SAINT_REMOTE_SHARED_STORE: shared };

    const probe = parseRemoteProbeReport(
      run(buildRemoteProbeScript(target), undefined, env).stdout,
    );
    expect(probe).toMatchObject({ installed: true, server: null });
    const start = run(buildRemoteStartScript(target, { token: "tok2" }), undefined, env);
    expect(start.stderr).toBe("");
    expect(parseRemoteStartReport(start.stdout)).not.toBeNull();
    const serverScript = FS.readFileSync(
      Path.join(home, target.remoteRoot, "run", "server.sh"),
      "utf8",
    );
    expect(serverScript).toContain(`${shared}/versions/${target.version}/dist/index.mjs`);
    expect(FS.existsSync(Path.join(shared, "versions", target.version))).toBe(true);

    // A relative or unset path is ignored.
    const relative = { SAINT_REMOTE_SHARED_STORE: "shared-store" };
    expect(
      parseRemoteProbeReport(run(buildRemoteProbeScript(target), undefined, relative).stdout)
        ?.installed,
    ).toBe(false);
    run(buildRemoteStopScript(target), undefined, env);
  }, 90_000);

  it("treats a pid file whose process is not a Saint server as no server", async () => {
    await install(target);
    const runDir = Path.join(home, target.remoteRoot, "run");
    FS.mkdirSync(runDir, { recursive: true });
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      FS.writeFileSync(Path.join(runDir, "server.pid"), String(other.pid));
      FS.writeFileSync(Path.join(runDir, "server.json"), '{"port":4100,"version":"1.2.3"}');
      FS.writeFileSync(Path.join(runDir, "token"), "tok");
      expect(parseRemoteProbeReport(run(buildRemoteProbeScript(target)).stdout)?.server).toBeNull();
    } finally {
      other.kill();
    }
  }, 90_000);
});

describe("createTarGzStream", () => {
  it("emits a gzip stream that ends with two zero blocks", async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of createTarGzStream(
      [{ path: "a.txt", contents: Buffer.from("hi") }],
      0,
    )) {
      chunks.push(chunk as Buffer);
    }
    const tar = Zlib.gunzipSync(Buffer.concat(chunks));
    expect(tar.length).toBe(512 * 4);
    expect(tar.subarray(0, 5).toString()).toBe("a.txt");
    expect(tar.subarray(512, 514).toString()).toBe("hi");
  });
});
