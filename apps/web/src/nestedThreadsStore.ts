// FILE: nestedThreadsStore.ts
// Purpose: Remembers which parent threads have their nested sessions open in the sidebar.
// Layer: UI state store
// Exports: useNestedThreadsStore

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "./lib/storage";

interface NestedThreadsStoreState {
  /** Scoped thread ids whose nested sessions are open; everything else stays collapsed. */
  openThreadIds: string[];
  toggleNestedThreads: (scopedThreadId: string) => void;
}

export const useNestedThreadsStore = create<NestedThreadsStoreState>()(
  persist(
    (set) => ({
      openThreadIds: [],
      toggleNestedThreads: (scopedThreadId) =>
        set((state) => ({
          openThreadIds: state.openThreadIds.includes(scopedThreadId)
            ? state.openThreadIds.filter((id) => id !== scopedThreadId)
            : [...state.openThreadIds, scopedThreadId],
        })),
    }),
    {
      name: "saint:sidebar:nested-threads:v1",
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
      ),
      partialize: (state) => ({ openThreadIds: state.openThreadIds }),
    },
  ),
);
