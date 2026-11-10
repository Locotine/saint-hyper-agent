// FILE: editorViewState.ts
// Purpose: Persists per-thread editor workspace view state (expanded explorer
//          directories, center mode, and split editor groups) so re-entering
//          the editor view restores it.
// Layer: Web UI state persistence

const EDITOR_VIEW_STATE_STORAGE_KEY = "saint.editor.viewStateByThreadId";
const MAX_PERSISTED_THREADS = 50;
export const MIN_SPLIT_GROUP_SIZE_PERCENT = 15;

export type EditorSplitDirection = "horizontal" | "vertical";
export type EditorSplitDropZone = "left" | "right" | "top" | "bottom" | "center";

export interface EditorSplitGroup {
  readonly id: string;
  readonly openFilePaths: ReadonlyArray<string>;
  readonly selectedFilePath: string | null;
}

export interface EditorSplitLayoutState {
  readonly groups: ReadonlyArray<EditorSplitGroup>;
  readonly activeGroupId: string;
  readonly direction: EditorSplitDirection;
  readonly sizes: ReadonlyArray<number>;
}

export interface EditorViewStateSnapshot {
  expandedDirectories: ReadonlyArray<string>;
  centerMode: "file" | "diff";
  splitLayout?: EditorSplitLayoutState | null;
}

interface PersistedEditorViewState extends EditorViewStateSnapshot {
  updatedAt: number;
}

type PersistedEditorViewStateMap = Record<string, PersistedEditorViewState>;

function normalizeSizes(count: number, rawSizes?: ReadonlyArray<number>): ReadonlyArray<number> {
  if (count <= 0) return [];
  if (count === 1) return [100];
  const valid =
    rawSizes &&
    rawSizes.length === count &&
    rawSizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
  if (!valid) {
    const equal = 100 / count;
    return Array.from({ length: count }, () => equal);
  }
  const total = rawSizes.reduce((sum, item) => sum + item, 0);
  if (total <= 0) {
    const equal = 100 / count;
    return Array.from({ length: count }, () => equal);
  }
  return rawSizes.map((item) => (item / total) * 100);
}

export function normalizeEditorSplitLayout(raw: unknown): EditorSplitLayoutState | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<EditorSplitLayoutState>;
  if (!Array.isArray(candidate.groups) || candidate.groups.length === 0) {
    return null;
  }
  const groups: EditorSplitGroup[] = [];
  for (const item of candidate.groups) {
    if (typeof item !== "object" || item === null) continue;
    const group = item as Partial<EditorSplitGroup>;
    if (typeof group.id !== "string" || group.id.trim().length === 0) continue;
    const openFilePaths = Array.isArray(group.openFilePaths)
      ? group.openFilePaths.filter(
          (path, index, arr): path is string =>
            typeof path === "string" && path.length > 0 && arr.indexOf(path) === index,
        )
      : [];
    const selectedFilePath =
      typeof group.selectedFilePath === "string" && openFilePaths.includes(group.selectedFilePath)
        ? group.selectedFilePath
        : (openFilePaths[0] ?? null);
    groups.push({
      id: group.id,
      openFilePaths,
      selectedFilePath,
    });
  }
  if (groups.length === 0) {
    return null;
  }
  const nonEmptyGroups =
    groups.length > 1 ? groups.filter((group) => group.openFilePaths.length > 0) : groups;
  const finalGroups = nonEmptyGroups.length > 0 ? nonEmptyGroups : [groups[0]!];
  const activeGroupId =
    typeof candidate.activeGroupId === "string" &&
    finalGroups.some((group) => group.id === candidate.activeGroupId)
      ? candidate.activeGroupId
      : finalGroups[0]!.id;
  const direction: EditorSplitDirection =
    candidate.direction === "vertical" ? "vertical" : "horizontal";
  return {
    groups: finalGroups,
    activeGroupId,
    direction,
    sizes: normalizeSizes(finalGroups.length, candidate.sizes),
  };
}

export function createInitialEditorSplitLayout(
  initialFilePath: string | null = null,
): EditorSplitLayoutState {
  return {
    groups: [
      {
        id: "group-1",
        openFilePaths: initialFilePath ? [initialFilePath] : [],
        selectedFilePath: initialFilePath,
      },
    ],
    activeGroupId: "group-1",
    direction: "horizontal",
    sizes: [100],
  };
}

function nextSplitGroupId(groups: ReadonlyArray<EditorSplitGroup>): string {
  let index = 1;
  const used = new Set(groups.map((group) => group.id));
  while (used.has(`group-${index}`)) {
    index += 1;
  }
  return `group-${index}`;
}

export function syncPrimaryFileIntoSplitLayout(
  layout: EditorSplitLayoutState,
  filePath: string | null,
): EditorSplitLayoutState {
  if (!filePath) return layout;
  const activeGroup =
    layout.groups.find((group) => group.id === layout.activeGroupId) ?? layout.groups[0];
  if (!activeGroup) {
    return createInitialEditorSplitLayout(filePath);
  }
  if (activeGroup.selectedFilePath === filePath && activeGroup.openFilePaths.includes(filePath)) {
    return layout;
  }
  return selectFileInSplitGroup(layout, activeGroup.id, filePath);
}

export function selectFileInSplitGroup(
  layout: EditorSplitLayoutState,
  groupId: string,
  filePath: string,
): EditorSplitLayoutState {
  const targetExists = layout.groups.some((group) => group.id === groupId);
  const resolvedGroupId = targetExists ? groupId : (layout.groups[0]?.id ?? "group-1");
  const groups = layout.groups.map((group) => {
    if (group.id !== resolvedGroupId) return group;
    const openFilePaths = group.openFilePaths.includes(filePath)
      ? group.openFilePaths
      : [...group.openFilePaths, filePath];
    return {
      ...group,
      openFilePaths,
      selectedFilePath: filePath,
    };
  });
  return {
    ...layout,
    groups,
    activeGroupId: resolvedGroupId,
  };
}

export function closeFileInSplitGroup(
  layout: EditorSplitLayoutState,
  groupId: string,
  filePath: string,
): EditorSplitLayoutState {
  const groupIndex = layout.groups.findIndex((group) => group.id === groupId);
  if (groupIndex === -1) return layout;
  const group = layout.groups[groupIndex]!;
  const tabIndex = group.openFilePaths.indexOf(filePath);
  if (tabIndex === -1) return layout;

  const nextOpenPaths = group.openFilePaths.filter((path) => path !== filePath);
  if (nextOpenPaths.length === 0 && layout.groups.length > 1) {
    const remainingGroups = layout.groups.filter((item) => item.id !== groupId);
    const remainingRawSizes = layout.sizes.filter((_, idx) => idx !== groupIndex);
    const nextActiveGroup =
      layout.activeGroupId === groupId
        ? (remainingGroups[Math.min(groupIndex, remainingGroups.length - 1)]?.id ??
          remainingGroups[0]!.id)
        : layout.activeGroupId;
    return {
      ...layout,
      groups: remainingGroups,
      activeGroupId: nextActiveGroup,
      sizes: normalizeSizes(remainingGroups.length, remainingRawSizes),
    };
  }

  const nextSelected =
    group.selectedFilePath === filePath
      ? (nextOpenPaths[Math.min(tabIndex, nextOpenPaths.length - 1)] ?? null)
      : group.selectedFilePath;
  const nextGroups = layout.groups.map((item) =>
    item.id === groupId
      ? {
          ...item,
          openFilePaths: nextOpenPaths,
          selectedFilePath: nextSelected,
        }
      : item,
  );
  return {
    ...layout,
    groups: nextGroups,
  };
}

export function moveTabBetweenSplitGroups(
  layout: EditorSplitLayoutState,
  sourceGroupId: string,
  filePath: string,
  targetGroupId: string,
  targetIndex?: number,
): EditorSplitLayoutState {
  if (sourceGroupId === targetGroupId) {
    const group = layout.groups.find((item) => item.id === sourceGroupId);
    if (!group) return layout;
    const currentIndex = group.openFilePaths.indexOf(filePath);
    if (currentIndex === -1) {
      return selectFileInSplitGroup(layout, targetGroupId, filePath);
    }
    if (targetIndex === undefined || targetIndex === currentIndex) {
      return { ...layout, activeGroupId: targetGroupId };
    }
    const nextPaths = [...group.openFilePaths];
    nextPaths.splice(currentIndex, 1);
    const clampedIndex = Math.max(0, Math.min(nextPaths.length, targetIndex));
    nextPaths.splice(clampedIndex, 0, filePath);
    return {
      ...layout,
      activeGroupId: targetGroupId,
      groups: layout.groups.map((item) =>
        item.id === sourceGroupId
          ? { ...item, openFilePaths: nextPaths, selectedFilePath: filePath }
          : item,
      ),
    };
  }

  const withAdded = layout.groups.map((group) => {
    if (group.id !== targetGroupId) return group;
    const withoutFile = group.openFilePaths.filter((path) => path !== filePath);
    const insertAt =
      targetIndex === undefined
        ? withoutFile.length
        : Math.max(0, Math.min(withoutFile.length, targetIndex));
    const nextOpenPaths = [
      ...withoutFile.slice(0, insertAt),
      filePath,
      ...withoutFile.slice(insertAt),
    ];
    return {
      ...group,
      openFilePaths: nextOpenPaths,
      selectedFilePath: filePath,
    };
  });

  const intermediate: EditorSplitLayoutState = {
    ...layout,
    groups: withAdded,
    activeGroupId: targetGroupId,
  };
  return closeFileInSplitGroup(intermediate, sourceGroupId, filePath);
}

export function dropFileOnSplitZone(
  layout: EditorSplitLayoutState,
  targetGroupId: string,
  zone: EditorSplitDropZone,
  filePath: string,
  sourceGroupId?: string | null,
): EditorSplitLayoutState {
  if (!filePath) return layout;
  if (zone === "center") {
    if (sourceGroupId && sourceGroupId !== targetGroupId) {
      return moveTabBetweenSplitGroups(layout, sourceGroupId, filePath, targetGroupId);
    }
    return selectFileInSplitGroup(layout, targetGroupId, filePath);
  }

  const direction: EditorSplitDirection =
    zone === "left" || zone === "right" ? "horizontal" : "vertical";
  let baseLayout = layout;

  if (sourceGroupId) {
    const sourceGroup = baseLayout.groups.find((group) => group.id === sourceGroupId);
    const shouldMoveFromSource =
      sourceGroup !== undefined &&
      sourceGroup.openFilePaths.includes(filePath) &&
      (sourceGroup.openFilePaths.length > 1 || baseLayout.groups.length > 1);
    if (
      shouldMoveFromSource &&
      !(baseLayout.groups.length === 1 && sourceGroup.openFilePaths.length === 1)
    ) {
      baseLayout = closeFileInSplitGroup(baseLayout, sourceGroupId, filePath);
    }
  }

  const resolvedTargetIndex = Math.max(
    0,
    baseLayout.groups.findIndex((group) => group.id === targetGroupId),
  );
  const newGroupId = nextSplitGroupId(baseLayout.groups);
  const newGroup: EditorSplitGroup = {
    id: newGroupId,
    openFilePaths: [filePath],
    selectedFilePath: filePath,
  };
  const insertIndex =
    zone === "left" || zone === "top" ? resolvedTargetIndex : resolvedTargetIndex + 1;
  const nextGroups = [
    ...baseLayout.groups.slice(0, insertIndex),
    newGroup,
    ...baseLayout.groups.slice(insertIndex),
  ];

  const currentSizes = normalizeSizes(baseLayout.groups.length, baseLayout.sizes);
  const targetSize = currentSizes[resolvedTargetIndex] ?? 100 / nextGroups.length;
  const halfSize = targetSize / 2;
  const nextRawSizes = [...currentSizes];
  nextRawSizes.splice(resolvedTargetIndex, 1, halfSize, halfSize);

  return {
    groups: nextGroups,
    activeGroupId: newGroupId,
    direction,
    sizes: normalizeSizes(nextGroups.length, nextRawSizes),
  };
}

export function resizeSplitGroups(
  layout: EditorSplitLayoutState,
  dividerIndex: number,
  deltaPercent: number,
): EditorSplitLayoutState {
  if (dividerIndex < 0 || dividerIndex >= layout.groups.length - 1) {
    return layout;
  }
  const sizes = [...normalizeSizes(layout.groups.length, layout.sizes)];
  const leftSize = sizes[dividerIndex]!;
  const rightSize = sizes[dividerIndex + 1]!;
  const combined = leftSize + rightSize;
  const minSize = Math.min(MIN_SPLIT_GROUP_SIZE_PERCENT, combined / 2);
  const nextLeft = Math.max(minSize, Math.min(combined - minSize, leftSize + deltaPercent));
  const nextRight = combined - nextLeft;
  sizes[dividerIndex] = nextLeft;
  sizes[dividerIndex + 1] = nextRight;
  return {
    ...layout,
    sizes,
  };
}

export function resolveSplitDropZoneFromPoint(
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  clientX: number,
  clientY: number,
): EditorSplitDropZone {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  const edgeThreshold = 0.25;
  const distLeft = relX;
  const distRight = 1 - relX;
  const distTop = relY;
  const distBottom = 1 - relY;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist > edgeThreshold) {
    return "center";
  }
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  if (minDist === distTop) return "top";
  return "bottom";
}

function readPersistedMap(): PersistedEditorViewStateMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PersistedEditorViewStateMap;
  } catch {
    return {};
  }
}

export function readEditorViewState(threadId: string): EditorViewStateSnapshot | null {
  const entry = readPersistedMap()[threadId];
  if (!entry) {
    return null;
  }
  const splitLayout = normalizeEditorSplitLayout(entry.splitLayout);
  return {
    expandedDirectories: Array.isArray(entry.expandedDirectories)
      ? entry.expandedDirectories.filter((path): path is string => typeof path === "string")
      : [],
    centerMode: entry.centerMode === "file" ? "file" : "diff",
    ...(splitLayout ? { splitLayout } : {}),
  };
}

export function storeEditorViewState(threadId: string, snapshot: EditorViewStateSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const map = readPersistedMap();
    const previous = map[threadId];
    const nextSplitLayout =
      snapshot.splitLayout !== undefined
        ? normalizeEditorSplitLayout(snapshot.splitLayout)
        : normalizeEditorSplitLayout(previous?.splitLayout);
    map[threadId] = {
      expandedDirectories: snapshot.expandedDirectories,
      centerMode: snapshot.centerMode,
      ...(nextSplitLayout ? { splitLayout: nextSplitLayout } : {}),
      updatedAt: Date.now(),
    };
    const entries = Object.entries(map);
    if (entries.length > MAX_PERSISTED_THREADS) {
      entries
        .toSorted((left, right) => (left[1]?.updatedAt ?? 0) - (right[1]?.updatedAt ?? 0))
        .slice(0, entries.length - MAX_PERSISTED_THREADS)
        .forEach(([staleThreadId]) => {
          delete map[staleThreadId];
        });
    }
    window.localStorage.setItem(EDITOR_VIEW_STATE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort preference persistence only.
  }
}

export function storeEditorSplitLayout(
  threadId: string,
  splitLayout: EditorSplitLayoutState | null,
): void {
  const existing = readEditorViewState(threadId);
  storeEditorViewState(threadId, {
    expandedDirectories: existing?.expandedDirectories ?? [],
    centerMode: existing?.centerMode ?? "file",
    splitLayout,
  });
}
