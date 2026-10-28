// FILE: openThreadTabsStore.ts
// Purpose: Persist which threads are open as tabs, in tab order. The single source of
//          truth for "open threads": the chat header strip and the editor rail both read
//          it; the active tab is never stored (it is always the thread on screen).
// Layer: UI state store
// Exports: useOpenThreadTabsStore

import type { ScopedThreadId } from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage, withLegacyKeyFallback, type SyncStateStorage } from "./lib/storage";
import {
  addOpenThreadTab,
  moveOpenThreadTab,
  normalizeOpenThreadTabIds,
  pruneOpenThreadTabs,
  removeOpenThreadTab,
} from "./openThreadTabs.logic";

interface OpenThreadTabsStoreState {
  /** Tabs of every host. Only this computer's render until remote threads get a UI. */
  threadIds: readonly ScopedThreadId[];
  openThreadTab: (threadId: ScopedThreadId) => void;
  closeThreadTab: (threadId: ScopedThreadId) => void;
  moveThreadTab: (threadId: ScopedThreadId, overThreadId: ScopedThreadId) => void;
  pruneThreadTabs: (isKept: (threadId: ScopedThreadId) => boolean) => void;
}

const OPEN_THREAD_TABS_STORAGE_KEY = "saint:open-thread-tabs:v2";
// v1 held raw thread ids. Read once as local threads, then left alone for a rollback.
const LEGACY_OPEN_THREAD_TABS_STORAGE_KEY = "saint:open-thread-tabs:v1";
// The editor rail's own per-project chat tabs, which this store replaced. Not migrated
// (the rail's tabs were a subset of the threads on screen); dropped on the first write.
const LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY = "saint.editor.railChatTabsByProjectId";

function createOpenThreadTabsStorage(): SyncStateStorage {
  return {
    getItem: (name) => localStorage.getItem(name),
    setItem: (name, value) => {
      localStorage.setItem(name, value);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
    removeItem: (name) => {
      localStorage.removeItem(name);
      localStorage.removeItem(LEGACY_EDITOR_RAIL_CHAT_TABS_STORAGE_KEY);
    },
  };
}

export const useOpenThreadTabsStore = create<OpenThreadTabsStoreState>()(
  persist(
    (set, get) => ({
      threadIds: [],
      // Zustand persist writes even when set returns the same state. Skip set
      // entirely for unchanged tabs, especially on the layout-effect navigation path.
      openThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = addOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      closeThreadTab: (threadId) => {
        const current = get().threadIds;
        const threadIds = removeOpenThreadTab(current, threadId);
        if (threadIds !== current) set({ threadIds });
      },
      moveThreadTab: (threadId, overThreadId) => {
        const current = get().threadIds;
        const threadIds = moveOpenThreadTab(current, threadId, overThreadId);
        if (threadIds !== current) set({ threadIds });
      },
      pruneThreadTabs: (isKept) => {
        const current = get().threadIds;
        const threadIds = pruneOpenThreadTabs(current, isKept);
        if (threadIds !== current) set({ threadIds });
      },
    }),
    {
      name: OPEN_THREAD_TABS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(
              createOpenThreadTabsStorage(),
              LEGACY_OPEN_THREAD_TABS_STORAGE_KEY,
            ),
      ),
      partialize: (state) => ({ threadIds: state.threadIds }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        threadIds: normalizeOpenThreadTabIds(
          (persistedState as { threadIds?: unknown } | undefined)?.threadIds,
        ),
      }),
    },
  ),
);
