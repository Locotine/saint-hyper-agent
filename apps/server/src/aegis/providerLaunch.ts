// FILE: providerLaunch.ts
// Purpose: The seam between provider adapters and Aegis at process launch. Each provider
//          session asks for its launch plan (OS sandbox launcher, per-session egress proxy env)
//          and reports the pid it spawned, so the kill switch can stop the whole tree.
// Layer: Server Aegis domain (process boundary)

import type { ProcessSandboxLauncher } from "@saint/shared/platformProcess";

import type { ProviderChildKind } from "../providerChildEnvironment.ts";

export interface ProviderLaunchInput {
  readonly threadId: string;
  readonly provider: ProviderChildKind;
  readonly cwd: string | undefined;
  /** The child environment; provider home overrides in it stay writable in the sandbox. */
  readonly env: NodeJS.ProcessEnv;
  /** Loopback ports the provider serves on (e.g. `opencode serve`), reached from Saint. */
  readonly inboundPorts?: ReadonlyArray<number>;
}

export interface ProviderLaunch {
  /** Pass as `sandbox` to the shared process runtime; undefined runs unsandboxed. */
  readonly sandbox: ProcessSandboxLauncher | undefined;
  /** Merge over the child environment (per-session proxy, TMPDIR, decoy HOME on macOS). */
  readonly env: Readonly<Record<string, string>>;
  /** Report the spawned process; its session resources are released when it exits. */
  readonly attach: (child: LaunchedChild) => void;
}

export interface LaunchedChild {
  readonly pid?: number | undefined;
  once(event: "exit", listener: () => void): unknown;
}

type Planner = (input: ProviderLaunchInput) => Promise<ProviderLaunch>;

const pidsByThread = new Map<string, Set<number>>();
let planner: Planner | null = null;

/** Installed by Aegis while it runs. */
export function setProviderLaunchPlanner(next: Planner | null): void {
  planner = next;
}

/** Records a provider pid for its thread until the process exits. */
export function trackProviderProcess(threadId: string, child: LaunchedChild): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const pids = pidsByThread.get(threadId) ?? new Set<number>();
  pids.add(pid);
  pidsByThread.set(threadId, pids);
  child.once("exit", () => {
    pids.delete(pid);
    if (pids.size === 0 && pidsByThread.get(threadId) === pids) pidsByThread.delete(threadId);
  });
}

export function providerProcessIds(threadId: string): ReadonlyArray<number> {
  return [...(pidsByThread.get(threadId) ?? [])];
}

export async function planProviderLaunch(input: ProviderLaunchInput): Promise<ProviderLaunch> {
  const launch = planner ? await planner(input) : null;
  return {
    sandbox: launch?.sandbox,
    env: launch?.env ?? {},
    attach: (child) => {
      trackProviderProcess(input.threadId, child);
      launch?.attach(child);
    },
  };
}
