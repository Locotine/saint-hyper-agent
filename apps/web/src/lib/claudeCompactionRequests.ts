import type { ClientOrchestrationCommand, CommandId } from "@saint/contracts";
import { scopeThread, type HostId, type ScopedThreadId } from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { scopeThreadKeyedRecord } from "../persistedRecord";
import { createMemoryStorage, withLegacyKeyFallback } from "./storage";

type CompactionCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

// Keep the original command until its acceptance is observed. Reusing its
// receipt makes a manual retry safe even after a lost RPC and route remount.
// Session storage also preserves that identity across a page reload.
export const useClaudeCompactionRequests = create<{
  /** Keyed by the thread's host: the command is retried against the host it was sent to. */
  requests: Partial<Record<ScopedThreadId, CompactionCommand>>;
  remember: (hostId: HostId, command: CompactionCommand) => void;
  forget: (threadId: ScopedThreadId, commandId: CommandId) => void;
}>()(
  persist(
    (set) => ({
      requests: {},
      remember: (hostId, command) =>
        set((state) => ({
          requests: { ...state.requests, [scopeThread(hostId, command.threadId)]: command },
        })),
      forget: (threadId, commandId) =>
        set((state) => {
          if (state.requests[threadId]?.commandId !== commandId) return state;
          const requests = { ...state.requests };
          delete requests[threadId];
          return { requests };
        }),
    }),
    {
      name: "saint:claude-compaction-requests:v2",
      // The unversioned key held raw thread ids; read once as local threads.
      storage: createJSONStorage(() =>
        typeof sessionStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(sessionStorage, "saint:claude-compaction-requests"),
      ),
      partialize: (state) => ({ requests: state.requests }),
      merge: (persisted, current) => ({
        ...current,
        requests: scopeThreadKeyedRecord(
          (persisted as { requests?: Record<string, CompactionCommand> } | undefined)?.requests ??
            {},
        ),
      }),
    },
  ),
);
