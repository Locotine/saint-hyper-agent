import { spawnSync } from "node:child_process";
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
  nodeMajorVersion,
  parseRemoteProbeReport,
  parseRemoteStartReport,
  quoteShell,
  remoteTmuxSessionName,
} from "./remoteSshScripts";

const target = { remoteRoot: "squad/synara-remote", version: "1.2.3" };

describe("remote script builders", () => {
  it("quotes shell values", () => {
    expect(quoteShell("a'b")).toBe(`'a'"'"'b'`);
  });

  it("derives a tmux session per install folder", () => {
    expect(remoteTmuxSessionName(".synara-remote")).toBe("synara-remote");
    expect(remoteTmuxSessionName("squad/synara")).toBe("squad-synara");
  });

  it("refuses versions and tokens that are unsafe to embed", () => {
    expect(() => buildRemoteProbeScript({ remoteRoot: "x", version: "1.0; rm -rf ~" })).toThrow();
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
      'SYNARA_REMOTE {"kind":"probe","node":"v24.17.0","npm":true,"installed":false,"server":{"info":{"port":4100,"version":"1.2.3"},"token":"abc"}}',
    ].join("\n");
    expect(parseRemoteProbeReport(stdout)).toEqual({
      nodeVersion: "v24.17.0",
      npm: true,
      installed: false,
      server: { port: 4100, version: "1.2.3", token: "abc" },
    });
  });

  it("treats a missing node and a malformed server as absent", () => {
    expect(
      parseRemoteProbeReport(
        'SYNARA_REMOTE {"kind":"probe","node":"","npm":false,"installed":true,"server":{"info":{"port":"x"}}}',
      ),
    ).toEqual({ nodeVersion: null, npm: false, installed: true, server: null });
    expect(parseRemoteProbeReport("no report")).toBeNull();
  });

  it("reads start and completion reports", () => {
    expect(parseRemoteStartReport('SYNARA_REMOTE {"kind":"started","port":4100}')).toEqual({
      port: 4100,
    });
    expect(parseRemoteStartReport('SYNARA_REMOTE {"kind":"started","port":0}')).toBeNull();
    expect(hasRemoteReport('SYNARA_REMOTE {"kind":"installed"}', "installed")).toBe(true);
    expect(hasRemoteReport('SYNARA_REMOTE {"kind":"installed"}', "stopped")).toBe(false);
  });

  it("parses node major versions", () => {
    expect(nodeMajorVersion("v24.13.1")).toBe(24);
    expect(nodeMajorVersion("v18.0.0")).toBe(18);
    expect(nodeMajorVersion(null)).toBeNull();
  });
});

// Runs the real scripts with `sh` against a throwaway HOME. npm and tmux are
// stubs; node is the test runner's own binary, serving a fake server bundle.
describe.runIf(process.platform !== "win32")("remote scripts end to end", () => {
  let home: string;
  let bin: string;

  const run = (script: string, input?: Buffer | string) =>
    spawnSync("sh", input === undefined ? ["-s"] : ["-c", script], {
      input: input ?? script,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 60_000,
    });

  beforeEach(() => {
    home = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-remote-ssh-"));
    bin = Path.join(home, "stub-bin");
    FS.mkdirSync(bin);
    FS.symlinkSync(process.execPath, Path.join(bin, "node"));
    FS.writeFileSync(
      Path.join(bin, "npm"),
      '#!/bin/sh\nmkdir -p node_modules/@pierre/diffs\nprintf "old\\n" >node_modules/@pierre/diffs/index.js\n',
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
    expect(nodeMajorVersion(probe?.nodeVersion ?? null)).toBeGreaterThan(0);

    const server = [
      'import { createServer } from "node:http";',
      'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
      "const token = process.env.SYNARA_AUTH_TOKEN;",
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
    expect(install.stderr).toBe("");
    expect(hasRemoteReport(install.stdout, "installed")).toBe(true);
    const installDir = Path.join(home, target.remoteRoot, "versions", target.version);
    expect(
      FS.readFileSync(Path.join(installDir, "node_modules/@pierre/diffs/index.js"), "utf8"),
    ).toBe("patched\n");

    const start = run(buildRemoteStartScript(target, { token: "tok123" }));
    expect(start.stderr).toBe("");
    const started = parseRemoteStartReport(start.stdout);
    expect(started).not.toBeNull();
    const health = await fetch(`http://127.0.0.1:${started?.port}/health`);
    expect(await health.text()).toBe("tok123");
    const runDir = Path.join(home, target.remoteRoot, "run");
    expect(FS.statSync(Path.join(runDir, "token")).mode & 0o077).toBe(0);
    expect(FS.readFileSync(Path.join(runDir, "server.sh"), "utf8")).not.toContain("tok123");

    const reprobe = parseRemoteProbeReport(run(buildRemoteProbeScript(target)).stdout);
    expect(reprobe).toMatchObject({
      installed: true,
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
      FS.existsSync(Path.join(home, target.remoteRoot, "versions", target.version, ".installed")),
    ).toBe(false);
  });
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
