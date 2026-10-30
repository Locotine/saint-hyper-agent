// FILE: gateRunner.ts
// Purpose: Deterministic verification gates. Saint runs the node's gate command itself (the
//          agent's "tests pass" is never taken on trust) and flags edits to protected paths —
//          gate scripts and tests — made since the node started.
// Layer: Server flow domain (process boundary)

import type { FlowGateSpec } from "@saint/contracts";

import { runProcess } from "../processRunner.ts";

export const FLOW_GATE_DEFAULT_TIMEOUT_MS = 20 * 60_000;
const GATE_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
/** Share of passing gate runs re-run at once to catch flaky or gamed passes. */
export const FLOW_GATE_DEFAULT_RESAMPLE_RATE = 0.1;

/** Whether this pass is re-run; `random` is injectable for tests. */
export function shouldResampleGate(
  gate: Pick<FlowGateSpec, "resampleRate">,
  passed: boolean,
  random: () => number = Math.random,
): boolean {
  return passed && random() < (gate.resampleRate ?? FLOW_GATE_DEFAULT_RESAMPLE_RATE);
}

/** Always protected: the flow definitions that decide what a gate is. */
export const FLOW_ALWAYS_PROTECTED = ["flows/**"];

export interface FlowGateResult {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly protectedEdits: ReadonlyArray<string>;
}

/** `**` crosses directories, `*` stays within one; anything else is literal. */
export function protectedPathPattern(glob: string): RegExp {
  const source = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`);
}

export function matchProtectedPaths(
  changed: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const patterns = [...FLOW_ALWAYS_PROTECTED, ...globs].map(protectedPathPattern);
  return changed.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  runProcess("git", args, { cwd, allowNonZeroExit: true, timeoutMs: 60_000 });

/**
 * A commit object for the current working tree (or HEAD when clean), without touching the
 * index, stash list or files. Null outside a git repository.
 */
export async function captureGateBaseline(cwd: string): Promise<string | null> {
  const stash = await git(cwd, ["stash", "create"]);
  if (stash.code === 0 && stash.stdout.trim()) return stash.stdout.trim();
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  return head.code === 0 ? head.stdout.trim() : null;
}

/** Tracked files that differ from the baseline, plus untracked files. */
export async function changedSinceBaseline(
  cwd: string,
  baseline: string | null,
): Promise<ReadonlyArray<string>> {
  if (!baseline) return [];
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", baseline]),
    // ponytail: untracked files count even if they existed before the node; track an untracked
    // baseline if this holds too many nodes for review.
    git(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function runFlowGate(input: {
  readonly gate: FlowGateSpec;
  readonly cwd: string;
  readonly baseline: string | null;
  readonly signal?: AbortSignal;
  /** Aegis sandbox argv for the command; it replaces the plain shell. */
  readonly sandbox?: {
    readonly file: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Record<string, string>;
    readonly attach?: (child: import("node:child_process").ChildProcess) => void;
  } | null;
  /** Sees the gate process (sandboxed or not), so a kill can stop it. */
  readonly onSpawn?: (child: import("node:child_process").ChildProcess) => void;
}): Promise<FlowGateResult> {
  const shell =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", input.gate.cmd] : ["-lc", input.gate.cmd];
  const startedAt = Date.now();
  const sandbox = input.sandbox ?? null;
  const result = await runProcess(sandbox?.file ?? shell, sandbox ? [...sandbox.args] : args, {
    cwd: input.cwd,
    ...(sandbox ? { env: { ...process.env, ...sandbox.env } } : {}),
    onSpawn: (child) => {
      sandbox?.attach?.(child);
      input.onSpawn?.(child);
    },
    timeoutMs: input.gate.timeoutMs ?? FLOW_GATE_DEFAULT_TIMEOUT_MS,
    allowNonZeroExit: true,
    outputMode: "truncate",
    maxBufferBytes: GATE_OUTPUT_LIMIT_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const durationMs = Date.now() - startedAt;
  const protectedEdits = matchProtectedPaths(
    await changedSinceBaseline(input.cwd, input.baseline),
    input.gate.protectedPaths ?? [],
  );
  return {
    passed: !result.timedOut && result.code === 0,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    protectedEdits,
  };
}
