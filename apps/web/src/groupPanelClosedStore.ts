// FILE: groupPanelClosedStore.ts
// Purpose: Remembers, per group project, that the user dismissed the Groups
//          panel — so the panel can auto-open on a group's first visit while a
//          deliberate close stays closed on later visits. Kept separate from
//          the Environment panel preference on purpose (W1 regression class):
//          closing Groups must never flip the env default.
// Layer: Web state
import { parseScopedProjectId, type ScopedProjectId } from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import { normalizePinnedIds, pinId, unpinId } from "./pinning.logic";

interface GroupPanelClosedStoreState {
  closedProjectIds: ScopedProjectId[];
  setGroupPanelClosed: (projectId: ScopedProjectId, closed: boolean) => void;
}

const GROUP_PANEL_CLOSED_STORAGE_KEY = "saint:group-panel-closed:v2";
// v1 held raw project ids. Read once as local projects, then left alone for a rollback.
const LEGACY_GROUP_PANEL_CLOSED_STORAGE_KEY = "saint:group-panel-closed:v1";

export const useGroupPanelClosedStore = create<GroupPanelClosedStoreState>()(
  persist(
    (set) => ({
      closedProjectIds: [],
      setGroupPanelClosed: (projectId, closed) => {
        if (projectId.length === 0) return;
        set((state) => {
          const result = closed
            ? pinId(state.closedProjectIds, projectId)
            : unpinId(state.closedProjectIds, projectId);
          if (!result.changed) return state;
          return { closedProjectIds: result.pinnedIds };
        });
      },
    }),
    {
      name: GROUP_PANEL_CLOSED_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_GROUP_PANEL_CLOSED_STORAGE_KEY),
      ),
      partialize: (state) => ({
        closedProjectIds: normalizePinnedIds(state.closedProjectIds),
      }),
      merge: (persistedState, currentState) => {
        const candidate =
          (
            persistedState as
              | Partial<Pick<GroupPanelClosedStoreState, "closedProjectIds">>
              | undefined
          )?.closedProjectIds ?? [];
        return {
          ...currentState,
          closedProjectIds: normalizePinnedIds(
            candidate.flatMap((id) => {
              const scoped = typeof id === "string" ? parseScopedProjectId(id) : null;
              return scoped === null ? [] : [scoped];
            }),
          ),
        };
      },
    },
  ),
);
