// FILE: killSwitch.ts
// Purpose: The hard parts of an Aegis kill: stop provider process trees (SIGTERM, then
//          SIGKILL after a short grace) and freeze a worktree read-only, reversibly, from a
//          manifest of the original file modes.
// Layer: Server Aegis domain (process + filesystem boundary)

import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  captureProcessTree,
  isProcessRunning,
  signalProcessTree,
  type CapturedProcessTree,
} from "../terminal/processTreeKiller.ts";

const KILL_GRACE_MS = 700;
const KILL_POLL_MS = 25;

export interface KillTreesResult {
  readonly roots: number;
  readonly forced: number;
  readonly survivors: ReadonlyArray<number>;
}

const anyRunning = async (pids: ReadonlyArray<number>) => {
  const running: number[] = [];
  for (const pid of pids) if (await isProcessRunning(pid)) running.push(pid);
  return running;
};

/** SIGTERM every tree, wait up to the grace period, then SIGKILL whatever is left. */
export async function killProcessTrees(
  rootPids: ReadonlyArray<number>,
  graceMs = KILL_GRACE_MS,
): Promise<KillTreesResult> {
  if (rootPids.length === 0) return { roots: 0, forced: 0, survivors: [] };
  const trees = new Map<number, CapturedProcessTree>();
  await Promise.all(
    rootPids.map(async (pid) => trees.set(pid, await captureProcessTree(pid))),
  );
  const everyPid = [
    ...new Set([
      ...rootPids,
      ...[...trees.values()].flatMap((tree) => tree.descendants.map((entry) => entry.pid)),
    ]),
  ];
  for (const [rootPid, tree] of trees) {
    signalProcessTree({ rootPid, signal: "SIGTERM", tree, includeRootTree: true });
  }
  const deadline = Date.now() + graceMs;
  let running = await anyRunning(everyPid);
  while (running.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
    running = await anyRunning(running);
  }
  if (running.length === 0) return { roots: rootPids.length, forced: 0, survivors: [] };
  for (const [rootPid, tree] of trees) {
    signalProcessTree({ rootPid, signal: "SIGKILL", tree, includeRootTree: true });
  }
  for (const pid of running) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
  return {
    roots: rootPids.length,
    forced: running.length,
    survivors: await anyRunning(running),
  };
}

export interface FreezeManifest {
  readonly root: string;
  readonly entries: ReadonlyArray<readonly [relativePath: string, mode: number]>;
}

/** Records every file and folder mode, then removes write permission from all of them. */
export async function freezeWorktree(
  root: string,
  manifestPath: string,
): Promise<{ readonly files: number }> {
  const entries: Array<readonly [string, number]> = [];
  const walk = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return;
    entries.push([relative, stat.mode & 0o7777]);
    if (!stat.isDirectory()) return;
    const children = await readdir(absolute);
    await Promise.all(children.map((child) => walk(path.join(relative, child))));
  };
  await walk("");
  // The manifest is saved before any mode changes, so Unfreeze can always undo a partial freeze.
  await writeFile(manifestPath, JSON.stringify({ root, entries } satisfies FreezeManifest));
  // Only write bits go, so folders stay searchable and the order does not matter.
  await Promise.all(
    entries.map(([relative, mode]) =>
      chmod(path.join(root, relative), mode & ~0o222).catch(() => undefined),
    ),
  );
  return { files: entries.length };
}

/** Restores the modes recorded by `freezeWorktree`. */
export async function unfreezeWorktree(manifestPath: string): Promise<{ readonly files: number }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FreezeManifest;
  await Promise.all(
    manifest.entries.map(([relative, mode]) =>
      chmod(path.join(manifest.root, relative), mode).catch(() => undefined),
    ),
  );
  return { files: manifest.entries.length };
}
