// FILE: workspaceRefreshBus.ts
// Purpose: Lightweight in-renderer pub/sub for terminal activity that may have changed files or Git state.
// Layer: Web workspace live-refresh coordination
// Exports: emitTerminalWorkspaceActivity, subscribeTerminalWorkspaceActivity

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

export interface TerminalWorkspaceActivityEvent {
  readonly hostId: HostId;
  readonly cwd: string;
}

type TerminalWorkspaceActivityListener = (event: TerminalWorkspaceActivityEvent) => void;

const listeners = new Set<TerminalWorkspaceActivityListener>();

function normalizeComparisonPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 1) return trimmed;
  return trimmed.replace(/[\\/]+$/u, "");
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeComparisonPath(left);
  const b = normalizeComparisonPath(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    a.startsWith(`${b}/`) ||
    a.startsWith(`${b}\\`) ||
    b.startsWith(`${a}/`) ||
    b.startsWith(`${a}\\`)
  );
}

export function emitTerminalWorkspaceActivity(event: TerminalWorkspaceActivityEvent): void {
  if (!event.cwd) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // One surface failing must not prevent other surfaces from refreshing.
    }
  }
}

export function subscribeTerminalWorkspaceActivity(
  hostId: HostId,
  cwd: string | null,
  listener: () => void,
): () => void {
  if (!cwd) return () => undefined;
  const targetHostId = hostId ?? LOCAL_HOST_ID;
  const wrapped: TerminalWorkspaceActivityListener = (event) => {
    if (event.hostId !== targetHostId) return;
    if (pathsOverlap(event.cwd, cwd)) {
      listener();
    }
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}
