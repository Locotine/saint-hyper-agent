import { parseScopedProjectId, type ScopedProjectId } from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";

const LATEST_PROJECT_STORAGE_KEY = "saint:latest-project:v2";
// v1 held a raw project id. Read once as a local project, then left alone for a rollback.
const LEGACY_LATEST_PROJECT_STORAGE_KEY = "saint:latest-project:v1";

interface LatestProjectStore {
  latestProjectId: ScopedProjectId | null;
  setLatestProjectId: (projectId: ScopedProjectId) => void;
  clearLatestProjectId: (projectId?: ScopedProjectId) => void;
}

export const useLatestProjectStore = create<LatestProjectStore>()(
  persist(
    (set) => ({
      latestProjectId: null,
      setLatestProjectId: (projectId) => set({ latestProjectId: projectId }),
      clearLatestProjectId: (projectId) =>
        set((state) => {
          if (projectId && state.latestProjectId !== projectId) {
            return state;
          }
          if (state.latestProjectId === null) {
            return state;
          }
          return { latestProjectId: null };
        }),
    }),
    {
      name: LATEST_PROJECT_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_LATEST_PROJECT_STORAGE_KEY),
      ),
      // Guard against a corrupt persisted value (non-string) reaching consumers
      // that treat it as a project id.
      merge: (persisted, current) => {
        const persistedId = (persisted as { latestProjectId?: unknown } | undefined)
          ?.latestProjectId;
        return {
          ...current,
          latestProjectId:
            typeof persistedId === "string" ? parseScopedProjectId(persistedId) : null,
        };
      },
    },
  ),
);
