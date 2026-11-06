// FILE: dockExplorerBrowseStore.ts
// Purpose: Per-thread browse state for the right-dock Explorer pane — the
//          selected file, expanded directories, and search query. The pane's
//          subtree unmounts when the user switches threads, so component-local
//          state was destroyed on every switch even though the dock's pane list
//          (persisted per thread in rightDockStore) restores the Explorer tab.
//          Keying the browse state by thread here lets a remounted pane reopen
//          exactly where the user left it.
// Layer: Web UI state store

import type { ThreadId } from "@saint/contracts";
import { create } from "zustand";

export interface DockExplorerBrowseState {
  selectedFilePath: string | null;
  /** Files open as preview tabs, in tab order; the selected one is among them. */
  openFilePaths: readonly string[];
  expandedDirectories: ReadonlySet<string>;
  searchQuery: string;
  /** Custom browsed folder root when the user navigates up (`..`) or into a folder; null for the project workspace root. */
  activeRootPath: string | null;
  /** History stack of previously visited roots for the Back button. */
  rootHistory: readonly string[];
}

// Shared immutable snapshot returned for threads with no recorded state, so a
// selector never hands React a fresh object per render.
export const EMPTY_DOCK_EXPLORER_BROWSE_STATE: DockExplorerBrowseState = {
  selectedFilePath: null,
  openFilePaths: [],
  expandedDirectories: new Set<string>(),
  searchQuery: "",
  activeRootPath: null,
  rootHistory: [],
};
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE);
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE.expandedDirectories);
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE.openFilePaths);
Object.freeze(EMPTY_DOCK_EXPLORER_BROWSE_STATE.rootHistory);

interface DockExplorerBrowseStore {
  browseStateByThreadId: Record<string, DockExplorerBrowseState>;
  /** Shows a file, opening a tab for it when it has none. */
  selectFile: (threadId: ThreadId, path: string | null) => void;
  /** Closes a file's tab; closing the shown one shows its neighbour, or nothing. */
  closeFile: (threadId: ThreadId, path: string) => void;
  setSearchQuery: (threadId: ThreadId, query: string) => void;
  toggleDirectory: (threadId: ThreadId, path: string) => void;
  expandDirectories: (threadId: ThreadId, paths: readonly string[]) => void;
  navigateRoot: (threadId: ThreadId, nextRoot: string, currentEffectiveRoot: string) => void;
  navigateBackRoot: (threadId: ThreadId, projectWorkspaceRoot: string | null) => void;
  resetRoot: (threadId: ThreadId) => void;
}

export const useDockExplorerBrowseStore = create<DockExplorerBrowseStore>()((set) => {
  const update = (
    threadId: ThreadId,
    patch: (state: DockExplorerBrowseState) => Partial<DockExplorerBrowseState>,
  ) =>
    set((store) => {
      const previous = store.browseStateByThreadId[threadId] ?? EMPTY_DOCK_EXPLORER_BROWSE_STATE;
      const next = patch(previous);
      const changed = (Object.keys(next) as (keyof DockExplorerBrowseState)[]).some(
        (key) => next[key] !== previous[key],
      );
      if (!changed) {
        return {};
      }
      return {
        browseStateByThreadId: {
          ...store.browseStateByThreadId,
          [threadId]: { ...previous, ...next },
        },
      };
    });

  return {
    browseStateByThreadId: {},
    selectFile: (threadId, path) =>
      update(threadId, (current) => ({
        selectedFilePath: path,
        ...(path !== null && !current.openFilePaths.includes(path)
          ? { openFilePaths: [...current.openFilePaths, path] }
          : {}),
      })),
    closeFile: (threadId, path) =>
      update(threadId, (current) => {
        const index = current.openFilePaths.indexOf(path);
        if (index === -1) return {};
        const openFilePaths = current.openFilePaths.filter((entry) => entry !== path);
        if (current.selectedFilePath !== path) return { openFilePaths };
        return {
          openFilePaths,
          selectedFilePath: openFilePaths[Math.min(index, openFilePaths.length - 1)] ?? null,
        };
      }),
    setSearchQuery: (threadId, query) => update(threadId, () => ({ searchQuery: query })),
    toggleDirectory: (threadId, path) =>
      update(threadId, (current) => {
        const expandedDirectories = new Set(current.expandedDirectories);
        if (expandedDirectories.has(path)) {
          expandedDirectories.delete(path);
        } else {
          expandedDirectories.add(path);
        }
        return { expandedDirectories };
      }),
    expandDirectories: (threadId, paths) => {
      if (paths.length === 0) {
        return;
      }
      update(threadId, (current) => ({
        expandedDirectories: new Set([...current.expandedDirectories, ...paths]),
      }));
    },
    navigateRoot: (threadId, nextRoot, currentEffectiveRoot) =>
      update(threadId, (current) => {
        if (!nextRoot || nextRoot === currentEffectiveRoot) {
          return {};
        }
        return {
          activeRootPath: nextRoot,
          rootHistory: [...current.rootHistory, currentEffectiveRoot],
          expandedDirectories: new Set<string>(),
          selectedFilePath: null,
          openFilePaths: [],
        };
      }),
    navigateBackRoot: (threadId, projectWorkspaceRoot) =>
      update(threadId, (current) => {
        if (current.rootHistory.length === 0) {
          return {};
        }
        const previousRoot = current.rootHistory[current.rootHistory.length - 1] ?? null;
        const rootHistory = current.rootHistory.slice(0, -1);
        return {
          activeRootPath: previousRoot === projectWorkspaceRoot ? null : previousRoot,
          rootHistory,
          expandedDirectories: new Set<string>(),
          selectedFilePath: null,
          openFilePaths: [],
        };
      }),
    resetRoot: (threadId) =>
      update(threadId, (current) => {
        if (current.activeRootPath === null && current.rootHistory.length === 0) {
          return {};
        }
        return {
          activeRootPath: null,
          rootHistory: [],
          expandedDirectories: new Set<string>(),
          selectedFilePath: null,
          openFilePaths: [],
        };
      }),
  };
});

// Selector for a single thread's browse state; falls back to the frozen shared
// snapshot so untouched threads do not subscribe to store writes at all.
export function selectDockExplorerBrowseState(
  threadId: ThreadId,
): (store: DockExplorerBrowseStore) => DockExplorerBrowseState {
  return (store) => store.browseStateByThreadId[threadId] ?? EMPTY_DOCK_EXPLORER_BROWSE_STATE;
}
