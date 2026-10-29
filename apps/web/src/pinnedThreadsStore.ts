// FILE: pinnedThreadsStore.ts
// Purpose: Persists the globally pinned chat thread ids used by the sidebar.
// Layer: UI state store
// Exports: usePinnedThreadsStore

import { type ThreadId } from "@saint/contracts";
import {
  parseScopedThreadId,
  unscopeThread,
  type HostId,
  type ScopedThreadId,
} from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import { normalizePinnedIds, pinId, unpinId } from "./pinning.logic";

interface PinnedThreadsStoreState {
  /** Pins of every host. */
  pinnedThreadIds: ScopedThreadId[];
  pinThread: (threadId: ScopedThreadId) => void;
  unpinThread: (threadId: ScopedThreadId) => void;
  togglePinnedThread: (threadId: ScopedThreadId) => void;
  /** Drops `hostId`'s pins missing from its fresh snapshot; other hosts' pins are kept. */
  prunePinnedThreads: (hostId: HostId, threadIds: readonly ThreadId[]) => void;
}

const PINNED_THREADS_STORAGE_KEY = "saint:pinned-threads:v2";
// v1 held raw thread ids. Read once as local threads, then left alone for a rollback.
const LEGACY_PINNED_THREADS_STORAGE_KEY = "saint:pinned-threads:v1";

function scopePersistedThreadIds(ids: readonly unknown[]): ScopedThreadId[] {
  return ids.flatMap((id) => {
    const scoped = typeof id === "string" ? parseScopedThreadId(id) : null;
    return scoped === null ? [] : [scoped];
  });
}

export const usePinnedThreadsStore = create<PinnedThreadsStoreState>()(
  persist(
    (set) => ({
      pinnedThreadIds: [],
      pinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          const result = pinId(state.pinnedThreadIds, threadId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedThreadIds: result.pinnedIds,
          };
        });
      },
      unpinThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedThreadIds, threadId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedThreadIds: result.pinnedIds,
          };
        });
      },
      togglePinnedThread: (threadId) => {
        if (threadId.length === 0) return;
        set((state) => {
          if (state.pinnedThreadIds.includes(threadId)) {
            return { pinnedThreadIds: unpinId(state.pinnedThreadIds, threadId).pinnedIds };
          }
          return { pinnedThreadIds: pinId(state.pinnedThreadIds, threadId).pinnedIds };
        });
      },
      prunePinnedThreads: (hostId, threadIds) => {
        set((state) => {
          const kept = new Set(threadIds);
          const nextPinnedThreadIds = state.pinnedThreadIds.filter((id) => {
            const ref = unscopeThread(id);
            return ref.hostId !== hostId || kept.has(ref.threadId);
          });
          return nextPinnedThreadIds.length === state.pinnedThreadIds.length
            ? state
            : { pinnedThreadIds: nextPinnedThreadIds };
        });
      },
    }),
    {
      name: PINNED_THREADS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_PINNED_THREADS_STORAGE_KEY),
      ),
      partialize: (state) => ({
        pinnedThreadIds: normalizePinnedIds(state.pinnedThreadIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (persistedState as Partial<Pick<PinnedThreadsStoreState, "pinnedThreadIds">> | undefined)
            ?.pinnedThreadIds ?? [];
        return {
          ...currentState,
          pinnedThreadIds: normalizePinnedIds(scopePersistedThreadIds(candidate)),
        };
      },
    },
  ),
);
