import type { ThreadEnvironmentMode } from "@saint/contracts";
import type { ScopedProjectId } from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import {
  isPlainObject,
  sanitizeStringKeyedRecord,
  scopeProjectKeyedRecord,
} from "./persistedRecord";

interface ProjectEnvironmentStoreState {
  envModeByProjectId: Partial<Record<ScopedProjectId, ThreadEnvironmentMode>>;
  setProjectEnvMode: (projectId: ScopedProjectId, envMode: ThreadEnvironmentMode) => void;
}

// v1 was keyed by raw project ids. Read once as local projects, then left alone for a rollback.
const storage =
  typeof localStorage !== "undefined"
    ? withLegacyKeyFallback(localStorage, "saint:project-environment:v1")
    : createMemoryStorage();

export const useProjectEnvironmentStore = create<ProjectEnvironmentStoreState>()(
  persist(
    (set) => ({
      envModeByProjectId: {},
      setProjectEnvMode: (projectId, envMode) =>
        set((state) =>
          state.envModeByProjectId[projectId] === envMode
            ? state
            : { envModeByProjectId: { ...state.envModeByProjectId, [projectId]: envMode } },
        ),
    }),
    {
      name: "saint:project-environment:v2",
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ envModeByProjectId: state.envModeByProjectId }),
      merge: (persisted, current) => ({
        ...current,
        envModeByProjectId: scopeProjectKeyedRecord(
          sanitizeStringKeyedRecord(
            isPlainObject(persisted) ? persisted.envModeByProjectId : undefined,
            (value) => (value === "local" || value === "worktree" ? value : null),
          ),
        ),
      }),
    },
  ),
);
