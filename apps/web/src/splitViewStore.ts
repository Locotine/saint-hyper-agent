// FILE: splitViewStore.ts
// Purpose: Persists split chat surfaces as a recursive pane tree (depth-cap 2 = up to 2x2 grid).
// Layer: UI state store
// Exports: pane/split types, tree-aware selectors, and id-based mutation helpers used by sidebar and route surfaces

import { type ProjectId, type ThreadId, type TurnId } from "@saint/contracts";
import {
  LOCAL_HOST_ID,
  parseScopedThreadId,
  scopeThread,
  type HostId,
  type ScopedThreadId,
} from "@saint/shared/hostId";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { type ChatRightPanel } from "./diffRouteSearch";
import { createMemoryStorage, withLegacyKeyFallback } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  canSubdividePane,
  collectLeaves,
  findLeafPaneById,
  findSplitNodeById,
  isLegacySplitViewLike,
  removeLeafByPaneId,
  removeLeafByThreadId as removeLeafByThreadIdInTree,
  replacePaneInTree,
  resolveDefaultFocusLeafId,
  type LegacySplitViewLike,
} from "./splitView.logic";

export type SplitViewId = string;
export type PaneId = string;
export type SplitDirection = "horizontal" | "vertical";
// "first" maps to the top/left side of a split; "second" maps to the bottom/right side.
export type SplitDropSide = "first" | "second";

export interface SplitViewPanePanelState {
  panel: ChatRightPanel | null;
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  hasOpenedPanel: boolean;
  lastOpenPanel: ChatRightPanel;
}

export interface LeafPane {
  kind: "leaf";
  id: PaneId;
  threadId: ThreadId | null;
  panel: SplitViewPanePanelState;
}

export interface SplitNode {
  kind: "split";
  id: PaneId;
  direction: SplitDirection;
  // first = left (horizontal) | top (vertical); second = right | bottom.
  first: Pane;
  second: Pane;
  ratio: number;
}

export type Pane = LeafPane | SplitNode;

export interface SplitView {
  id: SplitViewId;
  /** Every pane's thread lives on this host; leaf and source ids are its raw ids. */
  hostId: HostId;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
  root: Pane;
  focusedPaneId: PaneId;
  createdAt: string;
  updatedAt: string;
}

interface CreateFromThreadInput {
  hostId: HostId;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
}

interface CreateFromDropInput {
  hostId: HostId;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
  droppedThreadId: ThreadId;
  direction: SplitDirection;
  side: SplitDropSide;
}

interface DropThreadOnPaneInput {
  splitViewId: SplitViewId;
  targetPaneId: PaneId;
  direction: SplitDirection;
  side: SplitDropSide;
  threadId: ThreadId;
}

interface RemovePaneFromSplitViewInput {
  splitViewId: SplitViewId;
  paneId: PaneId;
}

interface SplitViewStore {
  hasHydrated: boolean;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<ScopedThreadId, SplitViewId | undefined>;
  createFromThread: (input: CreateFromThreadInput) => SplitViewId;
  createFromDrop: (input: CreateFromDropInput) => SplitViewId;
  removeSplitView: (splitViewId: SplitViewId) => void;
  replacePaneThread: (splitViewId: SplitViewId, paneId: PaneId, threadId: ThreadId | null) => void;
  dropThreadOnPane: (input: DropThreadOnPaneInput) => boolean;
  removePaneFromSplitView: (input: RemovePaneFromSplitViewInput) => boolean;
  setFocusedPane: (splitViewId: SplitViewId, paneId: PaneId) => void;
  setRatioForNode: (splitViewId: SplitViewId, splitNodeId: PaneId, ratio: number) => void;
  setPanePanelState: (
    splitViewId: SplitViewId,
    paneId: PaneId,
    patch: Partial<SplitViewPanePanelState>,
  ) => void;
  /** Removes the thread from `hostId`'s split views only. */
  removeThreadFromSplitViews: (hostId: HostId, threadId: ThreadId) => void;
  setHasHydrated: (hasHydrated: boolean) => void;
}

// Keep the v1 suffix stable while using the Saint namespace; legacy
// `saint:*` and `saint:*` keys are copied over by
// `storageKeyMigration` before this store hydrates, so older payloads still
// flow through the v1 -> v2 schema migration below.
const SPLIT_VIEW_STORAGE_KEY = "saint:split-view-state:v2";
// v1 (schema 2) had no host: every split was this computer's. Read once, then left alone for
// a rollback; schema 3 adds `hostId` and keys the source map by scoped thread id.
const LEGACY_SPLIT_VIEW_STORAGE_KEY = "saint:split-view-state:v1";
const SPLIT_VIEW_STORAGE_VERSION = 3;
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

function createDefaultPanePanelState(): SplitViewPanePanelState {
  return {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser",
  };
}

function createLeafPane(threadId: ThreadId | null): LeafPane {
  return {
    kind: "leaf",
    id: randomUUID(),
    threadId,
    panel: createDefaultPanePanelState(),
  };
}

function createSplitNode(input: {
  direction: SplitDirection;
  first: Pane;
  second: Pane;
  ratio?: number;
}): SplitNode {
  return {
    kind: "split",
    id: randomUUID(),
    direction: input.direction,
    first: input.first,
    second: input.second,
    ratio: clampRatio(input.ratio ?? DEFAULT_RATIO),
  };
}

function buildSplitViewFromThread(input: CreateFromThreadInput): SplitView {
  const now = new Date().toISOString();
  const sourceLeaf = createLeafPane(input.sourceThreadId);
  const emptyLeaf = createLeafPane(null);
  const root = createSplitNode({
    direction: "horizontal",
    first: sourceLeaf,
    second: emptyLeaf,
  });
  return {
    id: randomUUID(),
    hostId: input.hostId,
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: input.ownerProjectId,
    root,
    focusedPaneId: emptyLeaf.id,
    createdAt: now,
    updatedAt: now,
  };
}

function buildSplitViewFromDrop(
  input: CreateFromDropInput,
  existing?: Pick<SplitView, "id" | "createdAt"> | null,
): SplitView {
  const now = new Date().toISOString();
  const sourceLeaf = createLeafPane(input.sourceThreadId);
  const droppedLeaf = createLeafPane(input.droppedThreadId);
  const root = createSplitNode(
    input.side === "first"
      ? { direction: input.direction, first: droppedLeaf, second: sourceLeaf }
      : { direction: input.direction, first: sourceLeaf, second: droppedLeaf },
  );
  return {
    id: existing?.id ?? randomUUID(),
    hostId: input.hostId,
    sourceThreadId: input.sourceThreadId,
    ownerProjectId: input.ownerProjectId,
    root,
    focusedPaneId: droppedLeaf.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function migrateLegacySplitView(legacy: LegacySplitViewLike): SplitView | null {
  const now = new Date().toISOString();
  const leftLeaf: LeafPane = {
    kind: "leaf",
    id: randomUUID(),
    threadId: legacy.leftThreadId ?? null,
    panel: { ...legacy.leftPanel },
  };
  const rightLeaf: LeafPane = {
    kind: "leaf",
    id: randomUUID(),
    threadId: legacy.rightThreadId ?? null,
    panel: { ...legacy.rightPanel },
  };

  if (!leftLeaf.threadId && !rightLeaf.threadId) {
    return null;
  }

  const root = createSplitNode({
    direction: "horizontal",
    first: leftLeaf,
    second: rightLeaf,
    ratio: legacy.ratio,
  });
  return {
    id: legacy.id,
    hostId: LOCAL_HOST_ID,
    sourceThreadId: legacy.sourceThreadId,
    ownerProjectId: legacy.ownerProjectId,
    root,
    focusedPaneId: legacy.focusedPane === "right" ? rightLeaf.id : leftLeaf.id,
    createdAt: legacy.createdAt ?? now,
    updatedAt: legacy.updatedAt ?? now,
  };
}

function migrateLegacyPersistedState(state: unknown): SplitViewStoreState | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const legacyMap = (state as { splitViewsById?: Record<string, unknown> }).splitViewsById;
  if (!legacyMap || typeof legacyMap !== "object") {
    return null;
  }
  const splitViewsById: Record<SplitViewId, SplitView | undefined> = {};
  const splitViewIdBySourceThreadId: Record<ScopedThreadId, SplitViewId | undefined> = {};

  for (const [splitViewId, value] of Object.entries(legacyMap)) {
    if (!isLegacySplitViewLike(value)) {
      continue;
    }
    const migrated = migrateLegacySplitView(value);
    if (!migrated) {
      continue;
    }
    splitViewsById[splitViewId] = migrated;
    splitViewIdBySourceThreadId[sourceKey(migrated)] = splitViewId;
  }

  return {
    splitViewsById,
    splitViewIdBySourceThreadId,
  };
}

function sourceKey(splitView: Pick<SplitView, "hostId" | "sourceThreadId">): ScopedThreadId {
  return scopeThread(splitView.hostId, splitView.sourceThreadId);
}

// Schema 2 splits were all this computer's: give them a host and re-key the source map.
function migrateUnhostedPersistedState(state: unknown): SplitViewStoreState {
  const splitViewsById: Record<SplitViewId, SplitView | undefined> = {};
  const splitViewIdBySourceThreadId: Record<ScopedThreadId, SplitViewId | undefined> = {};
  const persisted = (state ?? {}) as Partial<{
    splitViewsById: Record<string, (Omit<SplitView, "hostId"> & { hostId?: HostId }) | undefined>;
    splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
  }>;
  for (const [splitViewId, splitView] of Object.entries(persisted.splitViewsById ?? {})) {
    if (!splitView) continue;
    splitViewsById[splitViewId] = { ...splitView, hostId: splitView.hostId ?? LOCAL_HOST_ID };
  }
  for (const [key, splitViewId] of Object.entries(persisted.splitViewIdBySourceThreadId ?? {})) {
    const scoped = parseScopedThreadId(key);
    if (scoped !== null) splitViewIdBySourceThreadId[scoped] = splitViewId;
  }
  return { splitViewsById, splitViewIdBySourceThreadId };
}

function resolveUpdatedAt(): string {
  return new Date().toISOString();
}

type SplitViewStoreState = Pick<SplitViewStore, "splitViewsById" | "splitViewIdBySourceThreadId">;

function updateSplitView(
  state: SplitViewStoreState,
  splitViewId: SplitViewId,
  updater: (splitView: SplitView) => SplitView,
): SplitViewStoreState {
  const existing = state.splitViewsById[splitViewId];
  if (!existing) return state;
  const updated = updater(existing);
  if (updated === existing) return state;
  return {
    ...state,
    splitViewsById: {
      ...state.splitViewsById,
      [splitViewId]: updated,
    },
  };
}

// Re-anchor only to threads that are not already the source of another split view.
function resolveNextSourceThreadId(input: {
  hostId: HostId;
  root: Pane;
  splitViewId: SplitViewId;
  splitViewIdBySourceThreadId: Record<ScopedThreadId, SplitViewId | undefined>;
}): ThreadId | null {
  for (const leaf of collectLeaves(input.root)) {
    if (!leaf.threadId) continue;
    const existingSourceSplitId =
      input.splitViewIdBySourceThreadId[scopeThread(input.hostId, leaf.threadId)];
    if (!existingSourceSplitId || existingSourceSplitId === input.splitViewId) {
      return leaf.threadId;
    }
  }
  return null;
}

// --- selectors ---

// Returns the threadId of the focused leaf, falling back to the first non-empty leaf when the
// focused pane is empty (so the UI never shows an "empty" thread when something is open elsewhere).
export function resolveSplitViewFocusedThreadId(splitView: SplitView): ThreadId | null {
  const focused = findLeafPaneById(splitView.root, splitView.focusedPaneId);
  if (focused?.threadId) {
    return focused.threadId;
  }
  for (const leaf of collectLeaves(splitView.root)) {
    if (leaf.threadId) return leaf.threadId;
  }
  return null;
}

// Strict variant: returns the focused leaf's threadId without any fallback (used for routing handoff).
export function resolveSplitViewFocusedPaneThreadId(splitView: SplitView): ThreadId | null {
  return findLeafPaneById(splitView.root, splitView.focusedPaneId)?.threadId ?? null;
}

export function resolveSplitViewThreadIds(splitView: SplitView): ThreadId[] {
  const ids = collectLeaves(splitView.root)
    .map((leaf) => leaf.threadId)
    .filter((threadId): threadId is ThreadId => threadId !== null);
  return [...new Set(ids)];
}

export function resolveSplitViewPaneIdForThread(
  splitView: SplitView,
  threadId: ThreadId | null,
): PaneId | null {
  if (!threadId) return null;
  for (const leaf of collectLeaves(splitView.root)) {
    if (leaf.threadId === threadId) return leaf.id;
  }
  return null;
}

export function selectSplitView(splitViewId: SplitViewId | null) {
  return (store: SplitViewStore) =>
    splitViewId ? (store.splitViewsById[splitViewId] ?? null) : null;
}

// --- store ---

export const useSplitViewStore = create<SplitViewStore>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      splitViewsById: {},
      splitViewIdBySourceThreadId: {},
      setHasHydrated: (hasHydrated) => set({ hasHydrated }),
      createFromThread: (input) => {
        const existingId = get().splitViewIdBySourceThreadId[sourceKey(input)] ?? null;
        if (existingId) {
          return existingId;
        }

        const splitView = buildSplitViewFromThread(input);
        set((state) => ({
          splitViewsById: {
            ...state.splitViewsById,
            [splitView.id]: splitView,
          },
          splitViewIdBySourceThreadId: {
            ...state.splitViewIdBySourceThreadId,
            [sourceKey(input)]: splitView.id,
          },
        }));
        return splitView.id;
      },
      createFromDrop: (input) => {
        const existingId = get().splitViewIdBySourceThreadId[sourceKey(input)] ?? null;
        const existing = existingId ? (get().splitViewsById[existingId] ?? null) : null;
        const splitView = buildSplitViewFromDrop(input, existing);
        set((state) => ({
          splitViewsById: {
            ...state.splitViewsById,
            [splitView.id]: splitView,
          },
          splitViewIdBySourceThreadId: {
            ...state.splitViewIdBySourceThreadId,
            [sourceKey(input)]: splitView.id,
          },
        }));
        return splitView.id;
      },
      removeSplitView: (splitViewId) =>
        set((state) => {
          const existing = state.splitViewsById[splitViewId];
          if (!existing) return state;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };
          delete nextSplitViewsById[splitViewId];
          delete nextSplitViewIdBySourceThreadId[sourceKey(existing)];
          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
      replacePaneThread: (splitViewId, paneId, threadId) =>
        set((state) => {
          const existing = state.splitViewsById[splitViewId];
          if (!existing) return state;
          let nextSourceThreadId: ThreadId | null = existing.sourceThreadId;
          let shouldRemoveSplitView = false;
          const nextState = updateSplitView(state, splitViewId, (splitView) => {
            const leaf = findLeafPaneById(splitView.root, paneId);
            if (!leaf) return splitView;
            if (leaf.threadId === threadId) return splitView;
            const nextLeaf: LeafPane = { ...leaf, threadId };
            const nextRoot = replacePaneInTree(splitView.root, paneId, nextLeaf);
            const hasAnyThread = collectLeaves(nextRoot).some(
              (nextLeaf) => nextLeaf.threadId !== null,
            );
            if (!hasAnyThread) {
              shouldRemoveSplitView = true;
            }
            if (leaf.threadId === splitView.sourceThreadId) {
              nextSourceThreadId = resolveNextSourceThreadId({
                hostId: splitView.hostId,
                root: nextRoot,
                splitViewId,
                splitViewIdBySourceThreadId: state.splitViewIdBySourceThreadId,
              });
              if (nextSourceThreadId === null) {
                shouldRemoveSplitView = true;
              }
            }
            return {
              ...splitView,
              sourceThreadId: nextSourceThreadId ?? splitView.sourceThreadId,
              root: nextRoot,
              updatedAt: resolveUpdatedAt(),
            };
          });
          if (nextState === state) return state;

          if (shouldRemoveSplitView) {
            const nextSplitViewsById = { ...nextState.splitViewsById };
            const nextSplitViewIdBySourceThreadId = { ...nextState.splitViewIdBySourceThreadId };
            delete nextSplitViewsById[splitViewId];
            if (nextSplitViewIdBySourceThreadId[sourceKey(existing)] === splitViewId) {
              delete nextSplitViewIdBySourceThreadId[sourceKey(existing)];
            }
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const updated = nextState.splitViewsById[splitViewId];
          if (
            !updated ||
            nextSourceThreadId === null ||
            nextSourceThreadId === existing.sourceThreadId
          ) {
            return nextState;
          }

          const nextSplitViewIdBySourceThreadId = { ...nextState.splitViewIdBySourceThreadId };
          if (nextSplitViewIdBySourceThreadId[sourceKey(existing)] === splitViewId) {
            delete nextSplitViewIdBySourceThreadId[sourceKey(existing)];
          }
          nextSplitViewIdBySourceThreadId[scopeThread(existing.hostId, nextSourceThreadId)] =
            splitViewId;
          return {
            ...nextState,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
      dropThreadOnPane: ({ splitViewId, targetPaneId, direction, side, threadId }) => {
        const stateBefore = get();
        const splitView = stateBefore.splitViewsById[splitViewId];
        if (!splitView) return false;
        const targetLeaf = findLeafPaneById(splitView.root, targetPaneId);
        if (!targetLeaf) return false;
        if (collectLeaves(splitView.root).some((leaf) => leaf.threadId === threadId)) {
          return false;
        }
        if (!canSubdividePane(splitView.root, targetPaneId, direction)) {
          return false;
        }

        const newLeaf = createLeafPane(threadId);
        const newSplit = createSplitNode(
          side === "first"
            ? { direction, first: newLeaf, second: targetLeaf }
            : { direction, first: targetLeaf, second: newLeaf },
        );

        set((state) =>
          updateSplitView(state, splitViewId, (current) => ({
            ...current,
            root: replacePaneInTree(current.root, targetPaneId, newSplit),
            focusedPaneId: newLeaf.id,
            updatedAt: resolveUpdatedAt(),
          })),
        );
        return true;
      },
      removePaneFromSplitView: ({ splitViewId, paneId }) => {
        const stateBefore = get();
        const splitView = stateBefore.splitViewsById[splitViewId];
        if (!splitView) return false;
        const targetLeaf = findLeafPaneById(splitView.root, paneId);
        if (!targetLeaf) return false;

        set((state) => {
          const current = state.splitViewsById[splitViewId];
          if (!current) return state;
          const currentTargetLeaf = findLeafPaneById(current.root, paneId);
          if (!currentTargetLeaf) return state;

          const result = removeLeafByPaneId(current.root, paneId);
          if (result.removedLeafIds.length === 0) return state;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };

          if (current.sourceThreadId === currentTargetLeaf.threadId) {
            delete nextSplitViewIdBySourceThreadId[sourceKey(current)];
          }

          if (!result.nextRoot) {
            delete nextSplitViewsById[splitViewId];
            delete nextSplitViewIdBySourceThreadId[sourceKey(current)];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const hasAnyThread = collectLeaves(result.nextRoot).some(
            (leaf) => leaf.threadId !== null,
          );
          if (!hasAnyThread) {
            delete nextSplitViewsById[splitViewId];
            delete nextSplitViewIdBySourceThreadId[sourceKey(current)];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }

          const nextSourceThreadId =
            current.sourceThreadId === currentTargetLeaf.threadId
              ? resolveNextSourceThreadId({
                  hostId: current.hostId,
                  root: result.nextRoot,
                  splitViewId,
                  splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
                })
              : current.sourceThreadId;
          if (!nextSourceThreadId) {
            delete nextSplitViewsById[splitViewId];
            return {
              splitViewsById: nextSplitViewsById,
              splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
            };
          }
          if (nextSourceThreadId !== current.sourceThreadId) {
            nextSplitViewIdBySourceThreadId[scopeThread(current.hostId, nextSourceThreadId)] =
              splitViewId;
          }

          const focusedStillPresent = !result.removedLeafIds.includes(current.focusedPaneId);
          nextSplitViewsById[splitViewId] = {
            ...current,
            sourceThreadId: nextSourceThreadId,
            root: result.nextRoot,
            focusedPaneId: focusedStillPresent
              ? current.focusedPaneId
              : resolveDefaultFocusLeafId(result.nextRoot),
            updatedAt: resolveUpdatedAt(),
          };
          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        });
        return true;
      },
      setFocusedPane: (splitViewId, paneId) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            if (splitView.focusedPaneId === paneId) return splitView;
            if (!findLeafPaneById(splitView.root, paneId)) return splitView;
            return {
              ...splitView,
              focusedPaneId: paneId,
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setRatioForNode: (splitViewId, splitNodeId, ratio) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const node = findSplitNodeById(splitView.root, splitNodeId);
            if (!node) return splitView;
            const nextRatio = clampRatio(ratio);
            if (node.ratio === nextRatio) return splitView;
            const nextNode: SplitNode = { ...node, ratio: nextRatio };
            return {
              ...splitView,
              root: replacePaneInTree(splitView.root, splitNodeId, nextNode),
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      setPanePanelState: (splitViewId, paneId, patch) =>
        set((state) =>
          updateSplitView(state, splitViewId, (splitView) => {
            const leaf = findLeafPaneById(splitView.root, paneId);
            if (!leaf) return splitView;
            const nextPanel: SplitViewPanePanelState = { ...leaf.panel, ...patch };
            if (
              leaf.panel.panel === nextPanel.panel &&
              leaf.panel.diffTurnId === nextPanel.diffTurnId &&
              leaf.panel.diffFilePath === nextPanel.diffFilePath &&
              leaf.panel.hasOpenedPanel === nextPanel.hasOpenedPanel &&
              leaf.panel.lastOpenPanel === nextPanel.lastOpenPanel
            ) {
              return splitView;
            }
            const nextLeaf: LeafPane = { ...leaf, panel: nextPanel };
            return {
              ...splitView,
              root: replacePaneInTree(splitView.root, paneId, nextLeaf),
              updatedAt: resolveUpdatedAt(),
            };
          }),
        ),
      removeThreadFromSplitViews: (hostId, threadId) =>
        set((state) => {
          let didChange = false;
          const nextSplitViewsById = { ...state.splitViewsById };
          const nextSplitViewIdBySourceThreadId = { ...state.splitViewIdBySourceThreadId };

          for (const [splitViewId, splitView] of Object.entries(state.splitViewsById)) {
            if (!splitView || splitView.hostId !== hostId) {
              continue;
            }
            const result = removeLeafByThreadIdInTree(splitView.root, threadId);
            if (result.removedLeafIds.length === 0) {
              continue;
            }

            didChange = true;
            if (result.nextRoot === null) {
              delete nextSplitViewsById[splitViewId];
              delete nextSplitViewIdBySourceThreadId[sourceKey(splitView)];
              continue;
            }
            if (!collectLeaves(result.nextRoot).some((leaf) => leaf.threadId !== null)) {
              delete nextSplitViewsById[splitViewId];
              delete nextSplitViewIdBySourceThreadId[sourceKey(splitView)];
              continue;
            }

            const focusedStillPresent = !result.removedLeafIds.includes(splitView.focusedPaneId);
            const nextFocusedPaneId = focusedStillPresent
              ? splitView.focusedPaneId
              : resolveDefaultFocusLeafId(result.nextRoot);
            const nextSourceThreadId =
              splitView.sourceThreadId === threadId
                ? resolveNextSourceThreadId({
                    hostId: splitView.hostId,
                    root: result.nextRoot,
                    splitViewId,
                    splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
                  })
                : splitView.sourceThreadId;

            if (splitView.sourceThreadId === threadId) {
              delete nextSplitViewIdBySourceThreadId[sourceKey(splitView)];
            }
            if (!nextSourceThreadId) {
              delete nextSplitViewsById[splitViewId];
              continue;
            }
            if (nextSourceThreadId !== splitView.sourceThreadId) {
              nextSplitViewIdBySourceThreadId[scopeThread(splitView.hostId, nextSourceThreadId)] =
                splitViewId;
            }

            nextSplitViewsById[splitViewId] = {
              ...splitView,
              sourceThreadId: nextSourceThreadId,
              root: result.nextRoot,
              focusedPaneId: nextFocusedPaneId,
              updatedAt: resolveUpdatedAt(),
            };
          }

          if (!didChange) {
            return state;
          }

          return {
            splitViewsById: nextSplitViewsById,
            splitViewIdBySourceThreadId: nextSplitViewIdBySourceThreadId,
          };
        }),
    }),
    {
      name: SPLIT_VIEW_STORAGE_KEY,
      version: SPLIT_VIEW_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined"
          ? createMemoryStorage()
          : withLegacyKeyFallback(localStorage, LEGACY_SPLIT_VIEW_STORAGE_KEY),
      ),
      partialize: (state) => ({
        splitViewsById: state.splitViewsById,
        splitViewIdBySourceThreadId: state.splitViewIdBySourceThreadId,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...(persistedState as Partial<SplitViewStoreState>),
        hasHydrated: currentState.hasHydrated,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          state?.setHasHydrated(true);
        };
      },
      // Pre-v2 storage used a flat left/right pane shape. We migrate any persisted state to the
      // tree shape; if migration cannot recover anything, we silently drop it instead of crashing.
      migrate: (persistedState, version) => {
        if (version >= SPLIT_VIEW_STORAGE_VERSION) {
          return persistedState as SplitViewStoreState;
        }
        if (version === 2) {
          return migrateUnhostedPersistedState(persistedState);
        }
        return (
          migrateLegacyPersistedState(persistedState) ?? {
            splitViewsById: {},
            splitViewIdBySourceThreadId: {},
          }
        );
      },
    },
  ),
);
