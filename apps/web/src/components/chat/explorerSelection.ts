// FILE: explorerSelection.ts
// Purpose: Multi-selection rules of the Explorer tree (Cmd/Ctrl-click toggles,
//          Shift-click selects a visible range) and the path rules that the
//          selection's Delete, Download, and drag-to-move share. Pure, so it is
//          unit-tested without a DOM.
// Layer: Chat workspace-browsing UI logic
// Exports: explorerClickIntent, nextExplorerSelection, explorerActionTargets,
//          withoutNestedExplorerEntries, explorerMovableEntries, explorerParentDirectory,
//          explorerEntryRowAttributes, readVisibleExplorerEntries, explorerEntryFromElement,
//          explorerTreeKeyAction, explorerRenameSelectionEnd

export interface ExplorerSelectableEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface ExplorerSelectionState {
  /**
   * Selected entries in selection order; empty when the selection is just the
   * open file (a plain click on a file opens it, which selects it).
   */
  readonly entries: readonly ExplorerSelectableEntry[];
  /** Row a Shift-click range starts from: the last row clicked without Shift. */
  readonly anchor: string | null;
}

export const EMPTY_EXPLORER_SELECTION: ExplorerSelectionState = { entries: [], anchor: null };

/** "open": a plain click; "toggle": Cmd-click (macOS) or Ctrl-click; "range": Shift-click. */
export type ExplorerClickIntent = "open" | "toggle" | "range";

export function explorerClickIntent(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean },
  isMac: boolean,
): ExplorerClickIntent {
  if (event.shiftKey) return "range";
  return (isMac ? event.metaKey : event.ctrlKey) ? "toggle" : "open";
}

/**
 * The selection after a click on `entry`. `visibleEntries` are the rendered rows
 * in display order; `openFilePath` (the file shown in the preview) seeds the
 * selection the first time a second row is added, like any file manager.
 */
export function nextExplorerSelection(
  state: ExplorerSelectionState,
  input: {
    readonly intent: ExplorerClickIntent;
    readonly entry: ExplorerSelectableEntry;
    readonly visibleEntries: readonly ExplorerSelectableEntry[];
    readonly openFilePath: string | null;
  },
): ExplorerSelectionState {
  const { entry, intent, visibleEntries } = input;
  // A plain click selects the row alone; for a file, opening it is that selection.
  if (intent === "open") {
    return { entries: entry.kind === "directory" ? [entry] : [], anchor: entry.path };
  }

  if (intent === "toggle") {
    let entries = state.entries;
    if (entries.length === 0) {
      const seedPath = state.anchor ?? input.openFilePath;
      const seed = visibleEntries.find((candidate) => candidate.path === seedPath);
      entries = seed ? [seed] : [];
    }
    const selected = entries.some((candidate) => candidate.path === entry.path);
    return {
      entries: selected
        ? entries.filter((candidate) => candidate.path !== entry.path)
        : [...entries, entry],
      anchor: entry.path,
    };
  }

  const anchorPath = state.anchor ?? input.openFilePath;
  const anchorIndex = visibleEntries.findIndex((candidate) => candidate.path === anchorPath);
  const targetIndex = visibleEntries.findIndex((candidate) => candidate.path === entry.path);
  if (anchorIndex === -1 || targetIndex === -1) return { entries: [entry], anchor: entry.path };
  const [from, to] =
    anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  // The anchor stays put so the next Shift-click re-ranges from the same row.
  return { entries: visibleEntries.slice(from, to + 1), anchor: visibleEntries[anchorIndex]!.path };
}

/**
 * What a right-click acts on: the whole multi-selection when the clicked row
 * is part of it, otherwise only the clicked row.
 */
export function explorerActionTargets(
  selection: readonly ExplorerSelectableEntry[],
  clicked: ExplorerSelectableEntry,
): readonly ExplorerSelectableEntry[] {
  return selection.length > 1 && selection.some((entry) => entry.path === clicked.path)
    ? selection
    : [clicked];
}

function isSameOrInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Drops entries inside a selected folder: acting on the folder covers them. */
export function withoutNestedExplorerEntries<T extends { readonly path: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter(
    (entry) =>
      !entries.some((other) => other.path !== entry.path && isSameOrInside(entry.path, other.path)),
  );
}

/** Workspace-relative parent folder; "" for the workspace root. */
export function explorerParentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Dragged paths that a drop on `destination` ("" for the root) actually moves:
 * not already in that folder, and not the folder itself or one inside it.
 */
export function explorerMovableEntries(paths: readonly string[], destination: string): string[] {
  return withoutNestedExplorerEntries(paths.map((path) => ({ path })))
    .map((entry) => entry.path)
    .filter(
      (path) =>
        explorerParentDirectory(path) !== destination &&
        !(destination !== "" && isSameOrInside(destination, path)),
    );
}

// Tree rows carry their entry so a Shift-click can read the visible range in
// display order, whatever folders are expanded or still loading.
export const EXPLORER_TREE_ATTRIBUTE = "data-explorer-tree";
export const EXPLORER_ENTRY_PATH_ATTRIBUTE = "data-explorer-path";
export const EXPLORER_ENTRY_KIND_ATTRIBUTE = "data-explorer-kind";

export function explorerEntryRowAttributes(entry: ExplorerSelectableEntry) {
  return {
    [EXPLORER_ENTRY_PATH_ATTRIBUTE]: entry.path,
    [EXPLORER_ENTRY_KIND_ATTRIBUTE]: entry.kind,
  };
}

/** Rows of the tree containing `row`, in display order. */
export function readVisibleExplorerEntries(row: Element): ExplorerSelectableEntry[] {
  const tree = row.closest(`[${EXPLORER_TREE_ATTRIBUTE}]`);
  if (!tree) return [];
  return Array.from(tree.querySelectorAll(`[${EXPLORER_ENTRY_PATH_ATTRIBUTE}]`), (element) => ({
    path: element.getAttribute(EXPLORER_ENTRY_PATH_ATTRIBUTE) ?? "",
    kind:
      element.getAttribute(EXPLORER_ENTRY_KIND_ATTRIBUTE) === "directory" ? "directory" : "file",
  }));
}

/** The tree row an event came from (the focused row for key presses). */
export function explorerEntryFromElement(
  element: EventTarget | null,
): ExplorerSelectableEntry | null {
  const row =
    element instanceof Element ? element.closest(`[${EXPLORER_ENTRY_PATH_ATTRIBUTE}]`) : null;
  const path = row?.getAttribute(EXPLORER_ENTRY_PATH_ATTRIBUTE);
  if (!row || !path) return null;
  return {
    path,
    kind: row.getAttribute(EXPLORER_ENTRY_KIND_ATTRIBUTE) === "directory" ? "directory" : "file",
  };
}

export type ExplorerTreeKeyAction = "clear" | "delete" | "rename";

/**
 * VS Code's Explorer keys: Escape clears the selection, Delete (Cmd+Backspace on
 * macOS) deletes it, and F2 (or Enter on macOS) renames the focused row.
 */
export function explorerTreeKeyAction(
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
  },
  isMac: boolean,
): ExplorerTreeKeyAction | null {
  const { key } = event;
  const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
  if (key === "Escape" && !modified) return "clear";
  if (key === "F2" && !modified) return "rename";
  if (isMac) {
    if (key === "Enter" && !modified) return "rename";
    if (
      key === "Backspace" &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      return "delete";
    }
    return null;
  }
  return key === "Delete" && !modified ? "delete" : null;
}

/** How much of a name Rename preselects: a file's name without its extension. */
export function explorerRenameSelectionEnd(entry: ExplorerSelectableEntry): number {
  const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return entry.kind === "file" && dot > 0 ? dot : name.length;
}
