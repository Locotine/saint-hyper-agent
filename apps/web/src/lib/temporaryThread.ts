// FILE: temporaryThread.ts
// Purpose: Isolates temporary-thread auto-delete decisions from route lifecycle effects.
// Layer: Web route/domain helpers
// Exports: switch-aware resolver for temporary thread cleanup

import type { ThreadId } from "@saint/contracts";
import { scopeLocalThread, type ScopedThreadId } from "@saint/shared/hostId";
import type { DraftThreadState } from "../composerDraftStore";

export function resolveTemporaryThreadIdToDelete(input: {
  previousThreadId: ThreadId | null;
  nextThreadId: ThreadId | null;
  previousThreadWasTemporary?: boolean;
  draftThreadsByThreadId: Record<ScopedThreadId, DraftThreadState | undefined>;
}): ThreadId | null {
  const previousThreadId = input.previousThreadId;
  if (!previousThreadId || previousThreadId === input.nextThreadId) {
    return null;
  }
  const previousDraftThread = input.draftThreadsByThreadId[scopeLocalThread(previousThreadId)];
  if (input.previousThreadWasTemporary !== true && previousDraftThread?.isTemporary !== true) {
    return null;
  }
  return previousThreadId;
}
