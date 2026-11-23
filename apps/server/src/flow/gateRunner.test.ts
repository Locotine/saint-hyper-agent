import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shouldResampleGate,
  captureGateBaseline,
  matchProtectedPaths,
  protectedPathPattern,
  runFlowGate,
} from "./gateRunner";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saint-gate-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "test", "auth.spec.ts"), "expect(1)\n");
  fs.writeFileSync(path.join(dir, "src.ts"), "export {}\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

describe("protected paths", () => {
  it("matches ** across directories and * within one", () => {
    expect(protectedPathPattern("test/**").test("test/a/b.ts")).toBe(true);
    expect(protectedPathPattern("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(matchProtectedPaths(["flows/x.yaml", "src/a.ts", "test/a.ts"], ["test/**"])).toEqual([
      "flows/x.yaml",
      "test/a.ts",
    ]);
  });
});

describe("runFlowGate", () => {
  it("passes on exit 0, fails on non-zero and on timeout", async () => {
    const cwd = repo();
    const baseline = await captureGateBaseline(cwd);
    const pass = await runFlowGate({ gate: { id: "g1", cmd: "echo ok" }, cwd, baseline });
    expect(pass).toMatchObject({ passed: true, exitCode: 0, protectedEdits: [] });
    expect(pass.output).toContain("ok");

    const fail = await runFlowGate({
      gate: { id: "g2", cmd: "echo boom >&2; exit 3" },
      cwd,
      baseline,
    });
    expect(fail).toMatchObject({ passed: false, exitCode: 3 });
    expect(fail.output).toContain("boom");

    const slow = await runFlowGate({
      gate: { id: "g3", cmd: "sleep 5", timeoutMs: 200 },
      cwd,
      baseline,
    });
    expect(slow).toMatchObject({ passed: false, timedOut: true });
  });

  it("flags test edits made after the baseline but not edits made before it", async () => {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "test", "auth.spec.ts"), "expect(2) // earlier step\n");
    const baseline = await captureGateBaseline(cwd);
    const gate = { id: "g7", cmd: "true", protectedPaths: ["test/**"] };

    expect((await runFlowGate({ gate, cwd, baseline })).protectedEdits).toEqual([]);

    fs.writeFileSync(path.join(cwd, "test", "auth.spec.ts"), "// skipped\n");
    fs.writeFileSync(path.join(cwd, "src.ts"), "export const a = 1\n");
    expect((await runFlowGate({ gate, cwd, baseline })).protectedEdits).toEqual([
      "test/auth.spec.ts",
    ]);
  });

  it("strips Saint control-plane tokens and provider API keys from gate environments", async () => {
    const cwd = repo();
    const baseline = await captureGateBaseline(cwd);
    vi.stubEnv("SAINT_AUTH_TOKEN", "host-secret-token");
    vi.stubEnv("SAINT_RUST_PTY_TOKEN", "pty-secret-token");
    vi.stubEnv("SAINT_BROWSER_HOST_CAPABILITY", "browser-secret-cap");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    try {
      const result = await runFlowGate({
        gate: {
          id: "g-env",
          cmd: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({auth:process.env.SAINT_AUTH_TOKEN??null,pty:process.env.SAINT_RUST_PTY_TOKEN??null,browser:process.env.SAINT_BROWSER_HOST_CAPABILITY??null,api:process.env.ANTHROPIC_API_KEY??null}))'`,
        },
        cwd,
        baseline,
      });
      expect(result.passed).toBe(true);
      expect(JSON.parse(result.output.trim())).toEqual({
        auth: null,
        pty: null,
        browser: null,
        api: null,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ignores core.fsmonitor configured in .git/config during baseline/diff checks", async () => {
    const cwd = repo();
    const marker = path.join(cwd, "fsmonitor-ran.txt");
    execFileSync("git", ["config", "core.fsmonitor", `touch ${JSON.stringify(marker)}`], {
      cwd,
      stdio: "ignore",
    });
    const baseline = await captureGateBaseline(cwd);
    await runFlowGate({ gate: { id: "g-git", cmd: "true" }, cwd, baseline });
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("gate resampling", () => {
  it("re-runs about one pass in ten, never a failure, and honours the rate", () => {
    expect(shouldResampleGate({}, true, () => 0.05)).toBe(true);
    expect(shouldResampleGate({}, true, () => 0.5)).toBe(false);
    expect(shouldResampleGate({}, false, () => 0)).toBe(false);
    expect(shouldResampleGate({ resampleRate: 0 }, true, () => 0)).toBe(false);
    expect(shouldResampleGate({ resampleRate: 1 }, true, () => 0.99)).toBe(true);
  });
});
