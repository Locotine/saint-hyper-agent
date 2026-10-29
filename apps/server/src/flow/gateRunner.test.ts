import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
});
