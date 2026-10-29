import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { freezeWorktree, killProcessTrees, unfreezeWorktree } from "./killSwitch";

const base = mkdtempSync(path.join(os.tmpdir(), "saint-kill-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === "win32")("kill switch", () => {
  it("kills a process tree, including a child that ignores SIGTERM, in under 2 s", async () => {
    const root = spawn("/bin/sh", [
      "-c",
      `sh -c 'trap "" TERM; while :; do sleep 0.1; done' & sleep 60 & wait`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const startedAt = performance.now();
    const result = await killProcessTrees([root.pid!]);
    const elapsed = performance.now() - startedAt;
    expect(result.survivors).toEqual([]);
    expect(result.forced).toBeGreaterThan(0);
    expect(alive(root.pid!)).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("freezes a worktree read-only and restores every mode", async () => {
    const tree = path.join(base, "wt");
    mkdirSync(path.join(tree, "src"), { recursive: true });
    writeFileSync(path.join(tree, "src", "a.ts"), "a");
    writeFileSync(path.join(tree, "run.sh"), "#!/bin/sh", { mode: 0o755 });
    const before = statSync(path.join(tree, "run.sh")).mode & 0o7777;
    const manifest = path.join(base, "fz.json");
    const { files } = await freezeWorktree(tree, manifest);
    expect(files).toBe(4);
    expect(statSync(path.join(tree, "src", "a.ts")).mode & 0o222).toBe(0);
    expect(statSync(path.join(tree, "src")).mode & 0o222).toBe(0);
    expect(() => writeFileSync(path.join(tree, "src", "b.ts"), "b")).toThrow();
    await unfreezeWorktree(manifest);
    expect(statSync(path.join(tree, "run.sh")).mode & 0o7777).toBe(before);
    writeFileSync(path.join(tree, "src", "b.ts"), "b");
  });
});
