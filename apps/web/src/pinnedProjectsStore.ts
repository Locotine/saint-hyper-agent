// FILE: pinnedProjectsStore.ts
// Purpose: Persists sidebar project pin ids with the shared pin ordering cap.
// Layer: UI state store
// Exports: usePinnedProjectsStore

import { MAX_PINNED_PROJECTS, type ProjectId } from "@saint/contracts";
import {
  parseScopedProjectId,
  unscopeProject,
  type HostId,
  type ScopedProjectId,
} from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import { normalizePinnedIds, pinId, unpinId } from "./pinning.logic";

interface PinnedProjectsStoreState {
  /** Pins of every host, sharing one cap. */
  pinnedProjectIds: ScopedProjectId[];
  pinProject: (projectId: ScopedProjectId) => boolean;
  unpinProject: (projectId: ScopedProjectId) => void;
  /** Drops `hostId`'s pins missing from its fresh snapshot; other hosts' pins are kept. */
  prunePinnedProjects: (hostId: HostId, projectIds: readonly ProjectId[]) => void;
}

const PINNED_PROJECTS_STORAGE_KEY = "saint:pinned-projects:v2";
// v1 held raw project ids. Read once as local projects, then left alone for a rollback.
const LEGACY_PINNED_PROJECTS_STORAGE_KEY = "saint:pinned-projects:v1";

function scopePersistedProjectIds(ids: readonly unknown[]): ScopedProjectId[] {
  return ids.flatMap((id) => {
    const scoped = typeof id === "string" ? parseScopedProjectId(id) : null;
    return scoped === null ? [] : [scoped];
  });
}
const PINNED_PROJECTS_OPTIONS = { maxCount: MAX_PINNED_PROJECTS } as const;

export const usePinnedProjectsStore = create<PinnedProjectsStoreState>()(
  persist(
    (set, get) => ({
      pinnedProjectIds: [],
      pinProject: (projectId) => {
        if (projectId.length === 0) return false;
        const result = pinId(get().pinnedProjectIds, projectId, PINNED_PROJECTS_OPTIONS);
        if (result.rejected) {
          return false;
        }
        if (result.changed) {
          set({ pinnedProjectIds: result.pinnedIds });
        }
        return true;
      },
      unpinProject: (projectId) => {
        if (projectId.length === 0) return;
        set((state) => {
          const result = unpinId(state.pinnedProjectIds, projectId);
          if (!result.changed) {
            return state;
          }
          return {
            pinnedProjectIds: result.pinnedIds,
          };
        });
      },
      prunePinnedProjects: (hostId, projectIds) => {
        set((state) => {
          const kept = new Set(projectIds);
          const nextPinnedProjectIds = state.pinnedProjectIds
            .filter((id) => {
              const ref = unscopeProject(id);
              return ref.hostId !== hostId || kept.has(ref.projectId);
            })
            .slice(0, MAX_PINNED_PROJECTS);
          return nextPinnedProjectIds.length === state.pinnedProjectIds.length &&
            nextPinnedProjectIds.every((id, index) => id === state.pinnedProjectIds[index])
            ? state
            : { pinnedProjectIds: nextPinnedProjectIds };
        });
      },
    }),
    {
      name: PINNED_PROJECTS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_PINNED_PROJECTS_STORAGE_KEY),
      ),
      partialize: (state) => ({
        pinnedProjectIds: normalizePinnedIds(state.pinnedProjectIds, PINNED_PROJECTS_OPTIONS),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<PinnedProjectsStoreState, "pinnedProjectIds">>
              | undefined
          )?.pinnedProjectIds ?? [];
        return {
          ...currentState,
          pinnedProjectIds: normalizePinnedIds(
            scopePersistedProjectIds(candidate),
            PINNED_PROJECTS_OPTIONS,
          ),
        };
      },
    },
  ),
);
