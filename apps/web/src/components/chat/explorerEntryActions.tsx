// FILE: explorerEntryActions.tsx
// Purpose: Selection and actions of the Explorer tree, after VS Code's Explorer:
//          Cmd/Ctrl/Shift-click multi-selection, the right-click menu (create,
//          download, copy the path, rename, delete), the Delete/Rename keys, and
//          moving dragged rows into a folder. Paths are the server's, so in a
//          remote window they act on the remote host.
// Layer: Chat workspace-browsing UI behavior
// Exports: useExplorerEntryActions, ExplorerTreeSelection

import type { ProjectFileSystemEntry } from "@saint/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useState,
} from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { isMacPlatform, getNavigatorPlatform } from "~/lib/utils";
import { canDownloadWorkspaceFiles, downloadWorkspaceFiles } from "~/lib/workspaceDownload";
import { ensureNativeApi } from "~/nativeApi";
import { RenameDialog } from "../RenameDialog";
import { toastManager } from "../ui/toast";
import { explorerDropDirectoryFor, setExplorerEntriesDragData } from "./explorerFileDrop";
import {
  EMPTY_EXPLORER_SELECTION,
  type ExplorerSelectableEntry,
  type ExplorerSelectionState,
  explorerActionTargets,
  explorerClickIntent,
  explorerEntryFromElement,
  explorerParentDirectory,
  explorerRenameSelectionEnd,
  explorerTreeKeyAction,
  nextExplorerSelection,
  readVisibleExplorerEntries,
  withoutNestedExplorerEntries,
} from "./explorerSelection";

// What the name dialog is open for.
type NameRequest =
  | {
      readonly action: "create";
      readonly kind: ProjectFileSystemEntry["kind"];
      /** Workspace-relative folder; "" for the workspace root. */
      readonly directory: string;
    }
  | { readonly action: "rename"; readonly entry: ExplorerSelectableEntry };

/** Shown in the multi-item delete confirmation before "…and N more". */
const DELETE_CONFIRM_LISTED_ENTRIES = 10;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// The desktop app reports local paths; Windows ones use backslashes.
function localFolderOf(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}

function directoryLabel(directory: string): string {
  return directory ? `${directory}/` : "the workspace root";
}

/** What the tree rows need from the selection. */
export interface ExplorerTreeSelection {
  /** Multi-selected paths; null while only the open file is selected. */
  readonly selectedPaths: ReadonlySet<string> | null;
  /**
   * Records a row click. True for Cmd/Ctrl/Shift-clicks, which only change the
   * selection; false for a plain click, which opens the file or toggles the folder.
   */
  readonly onRowClick: (
    entry: ExplorerSelectableEntry,
    event: ReactMouseEvent<HTMLElement>,
  ) => boolean;
  /** Drags the selection when the row is part of it, otherwise the row alone. */
  readonly onRowDragStart: (entry: ExplorerSelectableEntry, dataTransfer: DataTransfer) => void;
  /** Escape, Delete (Cmd+Backspace on macOS), and F2 (or Enter on macOS) on the focused row. */
  readonly onTreeKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

/**
 * Selection state, context-menu openers for tree rows and the tree's empty
 * space, the drop-to-move action, and the name dialog the menus open. Render
 * `dialog` once next to the tree.
 */
export function useExplorerEntryActions(input: {
  readonly workspaceRoot: string | null;
  readonly onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  readonly onSelectFile?: (path: string) => void;
  /** File open in the preview: seeds a multi-selection and follows a move or rename. */
  readonly selectedFilePath?: string | null;
}): {
  readonly openEntryMenu: (
    entry: Pick<ProjectFileSystemEntry, "path" | "kind">,
    position: { x: number; y: number },
  ) => void;
  readonly openRootMenu: (position: { x: number; y: number }) => void;
  readonly selection: ExplorerTreeSelection;
  readonly moveEntries: (paths: string[], directory: string) => void;
  /** The header's Download button; null where downloading does not apply (local windows). */
  readonly downloadSelection: { readonly fileCount: number; readonly download: () => void } | null;
  readonly dialog: ReactNode;
} {
  const queryClient = useQueryClient();
  // The request outlives `open` so the dialog keeps its title while closing.
  const [nameRequest, setNameRequestState] = useState<NameRequest | null>(null);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const setNameRequest = (request: NameRequest) => {
    setNameRequestState(request);
    setNameDialogOpen(true);
  };
  const { workspaceRoot, onReferenceInChat, onSelectFile } = input;
  const selectedFilePath = input.selectedFilePath ?? null;
  // Tagged with its workspace and open file: a selection never outlives a root
  // change, and opening another file (from search, a chat link, ...) selects
  // that file instead, as VS Code's Explorer follows the active editor.
  const [selectionState, setSelectionState] = useState<{
    readonly workspaceRoot: string | null;
    readonly openFilePath: string | null;
    readonly selection: ExplorerSelectionState;
  }>({
    workspaceRoot: input.workspaceRoot,
    openFilePath: selectedFilePath,
    selection: EMPTY_EXPLORER_SELECTION,
  });
  const selection =
    selectionState.workspaceRoot === workspaceRoot &&
    selectionState.openFilePath === selectedFilePath
      ? selectionState.selection
      : EMPTY_EXPLORER_SELECTION;
  const selectedEntries = selection.entries;

  const setSelection = (next: ExplorerSelectionState) =>
    setSelectionState({ workspaceRoot, openFilePath: selectedFilePath, selection: next });
  const clearSelection = () => {
    if (selectedEntries.length === 0) return false;
    setSelection({ entries: [], anchor: selection.anchor });
    return true;
  };
  // After a delete or move: drops those entries (and anything inside them),
  // keeping whatever else was selected meanwhile.
  const forgetSelected = (paths: readonly string[]) =>
    setSelectionState((current) => ({
      ...current,
      selection: {
        entries: current.selection.entries.filter(
          (entry) =>
            !paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
        ),
        anchor: current.selection.anchor,
      },
    }));

  const refreshDirectory = (directory: string) =>
    queryClient.invalidateQueries({
      queryKey: projectQueryKeys.listDirectories(workspaceRoot, directory || null, true),
    });

  const deleteEntry = async (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => {
    if (!workspaceRoot) return;
    const api = ensureNativeApi();
    const what = entry.kind === "directory" ? "folder and everything in it" : "file";
    const confirmed = await api.dialogs.confirm(
      `Delete ${entry.path}?\n\nThis ${what} is removed from disk and cannot be restored.`,
    );
    if (!confirmed) return;
    try {
      await api.projects.deleteEntry({ cwd: workspaceRoot, relativePath: entry.path });
      await refreshDirectory(explorerParentDirectory(entry.path));
      toastManager.add({ type: "success", title: `Deleted ${entry.path}` });
      forgetSelected([entry.path]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not delete ${entry.path}`,
        description: errorMessage(error),
      });
    }
  };

  // One confirmation for the whole selection; entries inside a selected folder
  // go with it rather than being listed twice.
  const deleteEntries = async (targets: readonly ExplorerSelectableEntry[]) => {
    const entries = withoutNestedExplorerEntries(targets);
    const [first] = entries;
    if (!workspaceRoot || !first) return;
    if (entries.length === 1) return deleteEntry(first);
    const api = ensureNativeApi();
    const listed = entries
      .slice(0, DELETE_CONFIRM_LISTED_ENTRIES)
      .map((entry) => `${entry.path}${entry.kind === "directory" ? "/" : ""}`)
      .join("\n");
    const more =
      entries.length > DELETE_CONFIRM_LISTED_ENTRIES
        ? `\n…and ${entries.length - DELETE_CONFIRM_LISTED_ENTRIES} more`
        : "";
    const confirmed = await api.dialogs.confirm(
      `Delete ${entries.length} items?\n\n${listed}${more}\n\nThey are removed from disk, folders with everything in them, and cannot be restored.`,
    );
    if (!confirmed) return;
    const deleted: string[] = [];
    for (const entry of entries) {
      try {
        await api.projects.deleteEntry({ cwd: workspaceRoot, relativePath: entry.path });
        deleted.push(entry.path);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not delete ${entry.path}`,
          description: errorMessage(error),
        });
      }
    }
    await Promise.all(
      [...new Set(entries.map((entry) => explorerParentDirectory(entry.path)))].map(
        refreshDirectory,
      ),
    );
    if (deleted.length > 0) {
      toastManager.add({
        type: "success",
        title: deleted.length === 1 ? `Deleted ${deleted[0]}` : `Deleted ${deleted.length} items`,
      });
    }
    forgetSelected(deleted);
  };

  const downloadEntries = async (targets: readonly ExplorerSelectableEntry[]) => {
    if (!workspaceRoot) return;
    const paths = targets.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const skipped = targets.length - paths.length;
    if (skipped > 0) {
      toastManager.add({
        type: "info",
        title: skipped === 1 ? "Skipped 1 folder" : `Skipped ${skipped} folders`,
        description: "Only files can be downloaded.",
      });
    }
    const [firstPath] = paths;
    if (!firstPath) return;
    const toastId = toastManager.add({
      type: "loading",
      title:
        paths.length === 1
          ? `Downloading ${fileNameOf(firstPath)}…`
          : `Downloading ${paths.length} files…`,
      timeout: 0,
    });
    try {
      const result = await downloadWorkspaceFiles({ cwd: workspaceRoot, paths });
      toastManager.close(toastId);
      if (!result) {
        toastManager.add({ type: "error", title: "Downloading needs the Saint desktop app" });
        return;
      }
      const [firstSaved] = result.saved;
      if (firstSaved) {
        toastManager.add({
          type: "success",
          title:
            result.saved.length === 1
              ? `Downloaded ${firstSaved.fileName}`
              : `Downloaded ${result.saved.length} files`,
          description:
            result.saved.length === 1 ? firstSaved.path : `To ${localFolderOf(firstSaved.path)}`,
        });
      }
      for (const failure of result.failures) {
        toastManager.add({
          type: "error",
          title: `Could not download ${failure.fileName}`,
          description: failure.message,
        });
      }
    } catch (error) {
      toastManager.close(toastId);
      toastManager.add({
        type: "error",
        title: "Could not download files",
        description: errorMessage(error),
      });
    }
  };

  // `paths` are only those the drop changes (see explorerMovableEntries).
  const moveEntries = async (paths: string[], directory: string) => {
    if (!workspaceRoot) return;
    const api = ensureNativeApi();
    const moved: string[] = [];
    const movedFrom: string[] = [];
    const changedDirectories = new Set([directory]);
    for (const path of paths) {
      try {
        const result = await api.projects.moveEntry({
          cwd: workspaceRoot,
          relativePath: path,
          destinationDirectory: directory,
        });
        moved.push(result.relativePath);
        movedFrom.push(path);
        changedDirectories.add(explorerParentDirectory(path));
        // Keep the preview on the moved file, also when its folder moved.
        if (selectedFilePath === path || selectedFilePath?.startsWith(`${path}/`)) {
          onSelectFile?.(`${result.relativePath}${selectedFilePath.slice(path.length)}`);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not move ${path}`,
          description: errorMessage(error),
        });
      }
    }
    await Promise.all([...changedDirectories].map(refreshDirectory));
    const [firstMoved] = moved;
    if (firstMoved) {
      toastManager.add({
        type: "success",
        title:
          moved.length === 1
            ? `Moved ${fileNameOf(firstMoved)} to ${directoryLabel(directory)}`
            : `Moved ${moved.length} items to ${directoryLabel(directory)}`,
      });
    }
    forgetSelected(movedFrom);
  };

  const canDownload = canDownloadWorkspaceFiles();

  const openEntryMenu = (
    entry: Pick<ProjectFileSystemEntry, "path" | "kind">,
    position: { x: number; y: number },
  ) => {
    const targets = explorerActionTargets(selectedEntries, entry);
    const deleteCount = withoutNestedExplorerEntries(targets).length;
    const fileCount = targets.filter((target) => target.kind === "file").length;
    const directory = explorerDropDirectoryFor(entry);
    void showFileReferenceContextMenu({
      path: entry.path,
      position,
      onReferenceInChat,
      workspaceRoot,
      ...(workspaceRoot
        ? {
            explorerActions: {
              onNewFile: () => setNameRequest({ action: "create", kind: "file", directory }),
              onNewFolder: () => setNameRequest({ action: "create", kind: "directory", directory }),
              onRename: () => setNameRequest({ action: "rename", entry }),
              onDelete: () => void deleteEntries(targets),
              ...(deleteCount > 1 ? { deleteLabel: `Delete ${deleteCount} items…` } : {}),
              ...(canDownload && fileCount > 0
                ? {
                    download: {
                      label: fileCount === 1 ? "Download" : `Download ${fileCount} files`,
                      onDownload: () => void downloadEntries(targets),
                    },
                  }
                : {}),
            },
          }
        : {}),
    });
  };

  // Empty space below the rows: only creation applies, in the workspace root.
  const openRootMenu = (position: { x: number; y: number }) => {
    if (!workspaceRoot) return;
    void ensureNativeApi()
      .contextMenu.show(
        [
          { id: "new-file" as const, label: "New File…" },
          { id: "new-folder" as const, label: "New Folder…" },
        ],
        position,
      )
      .then((clicked) => {
        if (clicked === "new-file")
          setNameRequest({ action: "create", kind: "file", directory: "" });
        if (clicked === "new-folder")
          setNameRequest({ action: "create", kind: "directory", directory: "" });
      });
  };

  const create = async (
    request: Extract<NameRequest, { action: "create" }>,
    root: string,
    name: string,
  ) => {
    const relativePath = request.directory ? `${request.directory}/${name}` : name;
    try {
      const result = await ensureNativeApi().projects.createEntry({
        cwd: root,
        relativePath,
        kind: request.kind,
      });
      await refreshDirectory(explorerParentDirectory(result.relativePath));
      if (request.kind === "file") onSelectFile?.(result.relativePath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: request.kind === "file" ? "Could not create file" : "Could not create folder",
        description: errorMessage(error),
      });
      // Keeps the dialog open so the name can be corrected.
      throw error;
    }
  };

  const rename = async (entry: ExplorerSelectableEntry, root: string, name: string) => {
    if (name === fileNameOf(entry.path)) return;
    try {
      const result = await ensureNativeApi().projects.renameEntry({
        cwd: root,
        relativePath: entry.path,
        newName: name,
      });
      await refreshDirectory(explorerParentDirectory(entry.path));
      forgetSelected([entry.path]);
      // Keep the preview on the renamed file, also when its folder was renamed.
      if (selectedFilePath === entry.path || selectedFilePath?.startsWith(`${entry.path}/`)) {
        onSelectFile?.(`${result.relativePath}${selectedFilePath.slice(entry.path.length)}`);
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not rename ${entry.path}`,
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const saveName = async (name: string) => {
    if (!workspaceRoot || !nameRequest) return;
    if (nameRequest.action === "create") return create(nameRequest, workspaceRoot, name);
    return rename(nameRequest.entry, workspaceRoot, name);
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const action = explorerTreeKeyAction(event, isMacPlatform(getNavigatorPlatform()));
    if (action === null) return;
    if (action === "clear") {
      if (clearSelection()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const focused = explorerEntryFromElement(event.target);
    if (!focused || !workspaceRoot) return;
    // Also keeps Enter on macOS from opening the row.
    event.preventDefault();
    event.stopPropagation();
    if (action === "rename") setNameRequest({ action: "rename", entry: focused });
    else void deleteEntries(explorerActionTargets(selectedEntries, focused));
  };

  const selectedPaths =
    selectedEntries.length > 0 ? new Set(selectedEntries.map((entry) => entry.path)) : null;
  const treeSelection: ExplorerTreeSelection = {
    selectedPaths,
    onRowClick: (entry, event) => {
      const intent = explorerClickIntent(event, isMacPlatform(getNavigatorPlatform()));
      setSelection(
        nextExplorerSelection(selection, {
          intent,
          entry,
          visibleEntries: intent === "open" ? [] : readVisibleExplorerEntries(event.currentTarget),
          openFilePath: selectedFilePath,
        }),
      );
      return intent !== "open";
    },
    onRowDragStart: (entry, dataTransfer) => {
      if (!workspaceRoot) return;
      const dragged = selectedPaths?.has(entry.path) ? selectedEntries : [entry];
      setExplorerEntriesDragData(dataTransfer, {
        cwd: workspaceRoot,
        paths: dragged.map((target) => target.path),
      });
    },
    onTreeKeyDown,
  };

  // The header button acts on the multi-selection, or else on the open file.
  const downloadTargets: readonly ExplorerSelectableEntry[] =
    selectedEntries.length > 0
      ? selectedEntries
      : selectedFilePath
        ? [{ path: selectedFilePath, kind: "file" }]
        : [];
  const downloadSelection = canDownload
    ? {
        fileCount: downloadTargets.filter((entry) => entry.kind === "file").length,
        download: () => void downloadEntries(downloadTargets),
      }
    : null;

  const createRequest = nameRequest?.action === "create" ? nameRequest : null;
  const renameRequest = nameRequest?.action === "rename" ? nameRequest : null;
  const renameDirectory = renameRequest ? explorerParentDirectory(renameRequest.entry.path) : "";
  const dialog = (
    <RenameDialog
      open={nameDialogOpen}
      title={
        renameRequest ? "Rename" : createRequest?.kind === "directory" ? "New Folder" : "New File"
      }
      description={
        renameRequest
          ? `In ${directoryLabel(renameDirectory)}. An existing name is never replaced.`
          : `In ${directoryLabel(createRequest?.directory ?? "")}. Use / to create nested folders.`
      }
      initialValue={renameRequest ? fileNameOf(renameRequest.entry.path) : ""}
      initialSelectionEnd={
        renameRequest ? explorerRenameSelectionEnd(renameRequest.entry) : undefined
      }
      placeholder={createRequest?.kind === "directory" ? "folder-name" : "file-name.ext"}
      saveLabel={renameRequest ? "Rename" : "Create"}
      isValueValid={(value) =>
        renameRequest
          ? !value.includes("/") && value !== "." && value !== ".."
          : !value.startsWith("/") &&
            !value.split("/").some((part) => part === "." || part === "..")
      }
      onOpenChange={(open) => {
        if (!open) setNameDialogOpen(false);
      }}
      onSave={saveName}
    />
  );

  return {
    openEntryMenu,
    openRootMenu,
    selection: treeSelection,
    moveEntries: (paths, directory) => void moveEntries(paths, directory),
    downloadSelection,
    dialog,
  };
}
