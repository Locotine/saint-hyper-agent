// FILE: agentProcesses.ts
// Purpose: Which thread each provider process serves, recorded where adapters spawn them, so the
//          host economy can show RSS/CPU per agent.
// Layer: Server economy

const owners = new Map<number, string>();

/** Called by provider adapters right after they spawn a thread's own process. */
export function recordAgentProcess(threadId: string, pid: number | undefined): void {
  if (pid !== undefined && pid > 0) owners.set(pid, threadId);
}

/** pid → thread, pruned to the pids still alive. */
export function agentProcessOwners(livePids: ReadonlySet<number>): ReadonlyMap<number, string> {
  for (const pid of owners.keys()) if (!livePids.has(pid)) owners.delete(pid);
  return owners;
}
