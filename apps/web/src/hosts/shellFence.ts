// FILE: shellFence.ts
// Purpose: The shell snapshot fence shared by this computer's EventRouter and every remote
//          host's pump. A shell stream delivers a snapshot and then events after it; events that
//          arrive first wait for the snapshot, and events the snapshot already covers are dropped.
// Layer: Web host connections
// Exports: createShellFence, ShellFence, ShellFenceTarget

import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@saint/contracts";

/** The two store actions the fence drives. */
export interface ShellFenceTarget {
  readonly syncServerShellSnapshot: (snapshot: OrchestrationShellSnapshot) => void;
  readonly applyShellEvent: (event: OrchestrationShellStreamEvent) => void;
}

export interface ShellFence {
  /** Highest sequence applied; -1 while no snapshot has landed. */
  readonly sequence: number;
  /**
   * Takes a snapshot, then the buffered events newer than it. A queried snapshot is refused when
   * it is older than what the fence already holds; a stream snapshot (`force`) is always taken.
   * `afterSync` runs after the store took the snapshot and before the buffered events.
   */
  applySnapshot: (
    snapshot: OrchestrationShellSnapshot,
    options?: { readonly force?: boolean; readonly afterSync?: () => void },
  ) => boolean;
  /** True when the event was applied; false when it was buffered or already covered. */
  applyEvent: (
    event: OrchestrationShellStreamEvent,
    options?: { readonly onApply?: () => void },
  ) => boolean;
  /** Closes the fence and forgets buffered events (a new subscription re-bases it). */
  reset: () => void;
}

/** Events that may arrive ahead of the snapshot; the oldest are dropped past this. */
export const SHELL_PENDING_EVENT_LIMIT = 1_024;

export function createShellFence(
  target: ShellFenceTarget,
  options: { readonly pendingLimit?: number } = {},
): ShellFence {
  const limit = Math.max(1, Math.floor(options.pendingLimit ?? SHELL_PENDING_EVENT_LIMIT));
  let sequence = -1;
  let pending: OrchestrationShellStreamEvent[] = [];

  const flush = (snapshotSequence: number) => {
    const next = pending
      .filter((event) => event.sequence > snapshotSequence)
      .toSorted((left, right) => left.sequence - right.sequence);
    pending = [];
    for (const event of next) {
      sequence = Math.max(sequence, event.sequence);
      target.applyShellEvent(event);
    }
  };

  return {
    get sequence() {
      return sequence;
    },
    applySnapshot(snapshot, snapshotOptions) {
      if (!snapshotOptions?.force && sequence >= 0 && snapshot.snapshotSequence < sequence) {
        return false;
      }
      sequence = snapshot.snapshotSequence;
      target.syncServerShellSnapshot(snapshot);
      snapshotOptions?.afterSync?.();
      flush(snapshot.snapshotSequence);
      return true;
    },
    applyEvent(event, eventOptions) {
      if (sequence < 0) {
        if (pending.length >= limit) pending.splice(0, pending.length - limit + 1);
        pending.push(event);
        return false;
      }
      if (event.sequence <= sequence) return false;
      sequence = event.sequence;
      eventOptions?.onApply?.();
      target.applyShellEvent(event);
      return true;
    },
    reset() {
      sequence = -1;
      pending = [];
    },
  };
}
