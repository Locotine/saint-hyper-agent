// FILE: projectInstructionsStore.ts
// Purpose: Persist per-project instructions and merge them into thread notes when requested.
// Layer: Web UI state store
// Exports: useProjectInstructionsStore, mergeProjectInstructionsIntoThreadNotes

import type { ScopedProjectId } from "@saint/shared/hostId";
import { clampThreadNotes } from "@saint/shared/pinnedMessages";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import { sanitizeStringKeyedRecord, scopeProjectKeyedRecord } from "./persistedRecord";

const PROJECT_INSTRUCTIONS_STORAGE_KEY = "saint:project-instructions:v2";
// v1 was keyed by raw project ids. Read once as local projects, then left alone for a rollback.
const LEGACY_PROJECT_INSTRUCTIONS_STORAGE_KEY = "saint:project-instructions:v1";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function threadNotesContainInstructionBlock(threadNotes: string, instructions: string): boolean {
  const current = threadNotes.replace(/\r\n/g, "\n").trim();
  if (current.length === 0) {
    return false;
  }
  const normalizedInstructions = instructions.replace(/\r\n/g, "\n").trim();
  const exactBlockPattern = new RegExp(
    `(?:^|\\n\\n)${escapeRegExp(normalizedInstructions)}(?:\\n\\n|$)`,
  );
  return exactBlockPattern.test(current);
}

interface ProjectInstructionsStore {
  /** Freeform instructions keyed by orchestration project id. */
  instructionsByProjectId: Record<ScopedProjectId, string>;
  /** Set or replace a project's instructions; empty strings clear persisted clutter. */
  setInstructions: (projectId: ScopedProjectId, instructions: string) => void;
  /** Clear a project's instructions. */
  clearInstructions: (projectId: ScopedProjectId) => void;
}

export const useProjectInstructionsStore = create<ProjectInstructionsStore>()(
  persist(
    (set) => ({
      instructionsByProjectId: {},
      setInstructions: (projectId, instructions) =>
        set((state) => {
          const next = { ...state.instructionsByProjectId };
          const clamped = clampThreadNotes(instructions);
          if (clamped.trim().length === 0) {
            delete next[projectId];
          } else {
            next[projectId] = clamped;
          }
          return { instructionsByProjectId: next };
        }),
      clearInstructions: (projectId) =>
        set((state) => {
          const next = { ...state.instructionsByProjectId };
          delete next[projectId];
          return { instructionsByProjectId: next };
        }),
    }),
    {
      name: PROJECT_INSTRUCTIONS_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_PROJECT_INSTRUCTIONS_STORAGE_KEY),
      ),
      merge: (persisted, current) => ({
        ...current,
        instructionsByProjectId: scopeProjectKeyedRecord(
          sanitizeStringKeyedRecord(
            (persisted as { instructionsByProjectId?: unknown } | undefined)
              ?.instructionsByProjectId,
            (value) => (typeof value === "string" ? value : null),
          ),
        ),
      }),
    },
  ),
);

// Appends project instructions without clobbering thread notes a user already wrote.
export function mergeProjectInstructionsIntoThreadNotes(input: {
  readonly threadNotes: string;
  readonly projectInstructions: string;
}): string {
  const instructions = input.projectInstructions.trim();
  if (instructions.length === 0) {
    return input.threadNotes;
  }
  const current = input.threadNotes.trim();
  if (current.length === 0) {
    return clampThreadNotes(instructions);
  }
  if (threadNotesContainInstructionBlock(current, instructions)) {
    return input.threadNotes;
  }
  return clampThreadNotes(`${input.threadNotes.trimEnd()}\n\n${instructions}`);
}
