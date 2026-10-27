// FILE: explorerFileDrop.ts
// Purpose: Drops onto the Explorer tree: local files dragged in from the OS are
//          uploaded into the folder under the pointer (remote SSH windows, where a
//          local path means nothing on the host), and the tree's own rows are
//          moved into that folder (every window).
// Layer: Chat workspace-browsing UI behavior
// Exports: useExplorerFileDrop, setExplorerEntriesDragData, endExplorerEntriesDrag,
//          EXPLORER_DROP_DIRECTORY_ATTRIBUTE, EXPLORER_DROP_TARGET_CLASS_NAME

import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent as ReactDragEvent, useState } from "react";

import { remoteWindowHost } from "~/env";
import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { uploadFilesToWorkspace } from "~/lib/workspaceUpload";
import { toastManager } from "../ui/toast";
import { explorerMovableEntries } from "./explorerSelection";

/**
 * Rows carry the folder a drop on them lands in: a folder row its own path, a
 * file row its parent ("" for the workspace root).
 */
export const EXPLORER_DROP_DIRECTORY_ATTRIBUTE = "data-explorer-drop-dir";

// Same tint the chat pane shows while a file is dragged over the composer.
export const EXPLORER_DROP_TARGET_CLASS_NAME = "bg-info/8 ring-1 ring-inset ring-info/30";

export function explorerDropDirectoryFor(entry: {
  readonly path: string;
  readonly kind: string;
}): string {
  if (entry.kind === "directory") return entry.path;
  const slash = entry.path.lastIndexOf("/");
  return slash === -1 ? "" : entry.path.slice(0, slash);
}

// Rows dragged inside the Explorer carry this next to their composer file
// reference, so the tree can tell its own drags apart and move them.
const EXPLORER_ENTRIES_DRAG_TYPE = "application/x-saint-explorer-entries";

interface ExplorerEntriesDrag {
  readonly cwd: string;
  readonly paths: readonly string[];
}

// dragover can read a drag's types but not its data, so the drag in progress is
// kept here to skip the tint over folders a drop would not change.
let activeEntriesDrag: ExplorerEntriesDrag | null = null;

export function setExplorerEntriesDragData(
  dataTransfer: DataTransfer,
  drag: ExplorerEntriesDrag,
): void {
  dataTransfer.setData(EXPLORER_ENTRIES_DRAG_TYPE, JSON.stringify(drag));
  // Copy keeps the composer accepting the row as a reference.
  dataTransfer.effectAllowed = "copyMove";
  activeEntriesDrag = drag;
}

export function endExplorerEntriesDrag(): void {
  activeEntriesDrag = null;
}

function readEntriesDrag(dataTransfer: DataTransfer): ExplorerEntriesDrag | null {
  try {
    const value = JSON.parse(dataTransfer.getData(EXPLORER_ENTRIES_DRAG_TYPE)) as {
      readonly cwd?: unknown;
      readonly paths?: unknown;
    };
    return typeof value.cwd === "string" &&
      Array.isArray(value.paths) &&
      value.paths.every((path) => typeof path === "string")
      ? { cwd: value.cwd, paths: value.paths as string[] }
      : null;
  } catch {
    return null;
  }
}

function isExplorerEntriesDrag(event: ReactDragEvent): boolean {
  return event.dataTransfer.types.includes(EXPLORER_ENTRIES_DRAG_TYPE);
}

// OS file drags carry "Files"; rows dragged out of the Explorer itself carry a
// file reference and must keep going to the composer.
function isOsFileDrag(event: ReactDragEvent): boolean {
  const types = event.dataTransfer.types;
  return types.includes("Files") && !types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE);
}

function dropDirectoryAt(event: ReactDragEvent): string {
  const row = (event.target as Element | null)?.closest?.(`[${EXPLORER_DROP_DIRECTORY_ATTRIBUTE}]`);
  return row?.getAttribute(EXPLORER_DROP_DIRECTORY_ATTRIBUTE) ?? "";
}

/**
 * Drop handlers for the tree body plus the folder currently targeted (null
 * while nothing is dragged over it, "" for the workspace root). `onMoveEntries`
 * receives only the dragged paths that the drop actually moves.
 */
export function useExplorerFileDrop(
  workspaceRoot: string | null,
  onMoveEntries?: (paths: string[], directory: string) => void,
) {
  const queryClient = useQueryClient();
  const [dropDirectory, setDropDirectory] = useState<string | null>(null);
  const enabled = remoteWindowHost !== null && workspaceRoot !== null;
  const moveEnabled = workspaceRoot !== null && onMoveEntries !== undefined;

  const onDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (moveEnabled && isExplorerEntriesDrag(event)) {
      event.preventDefault();
      event.stopPropagation();
      const next = dropDirectoryAt(event);
      // A drag from another window is checked on drop instead.
      const drag = activeEntriesDrag;
      const moves =
        !drag ||
        (drag.cwd === workspaceRoot && explorerMovableEntries(drag.paths, next).length > 0);
      event.dataTransfer.dropEffect = moves ? "move" : "none";
      const target = moves ? next : null;
      if (target !== dropDirectory) setDropDirectory(target);
      return;
    }
    if (!enabled || !isOsFileDrag(event)) return;
    // Handled here so the chat pane underneath does not also attach the file.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    const next = dropDirectoryAt(event);
    if (next !== dropDirectory) setDropDirectory(next);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!enabled && !moveEnabled) return;
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropDirectory(null);
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (moveEnabled && isExplorerEntriesDrag(event)) {
      event.preventDefault();
      event.stopPropagation();
      setDropDirectory(null);
      const drag = readEntriesDrag(event.dataTransfer);
      endExplorerEntriesDrag();
      if (!drag || drag.cwd !== workspaceRoot) return;
      const directory = dropDirectoryAt(event);
      const paths = explorerMovableEntries(drag.paths, directory);
      if (paths.length > 0) onMoveEntries?.(paths, directory);
      return;
    }
    if (!enabled || !workspaceRoot || !isOsFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropDirectory(null);
    const directory = dropDirectoryAt(event) || null;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const target = directory ? `${directory}/` : "the workspace root";
    void uploadFilesToWorkspace({ cwd: workspaceRoot, directory, files }).then((result) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.listDirectories(workspaceRoot, directory, true),
      });
      if (result.uploaded.length > 0) {
        toastManager.add({
          type: "success",
          title:
            result.uploaded.length === 1
              ? `Uploaded ${result.uploaded[0]}`
              : `Uploaded ${result.uploaded.length} files to ${target}`,
        });
      }
      for (const failure of result.failures) {
        toastManager.add({
          type: "error",
          title: `Could not upload ${failure.name}`,
          description: failure.message,
        });
      }
    });
  };

  return {
    dropDirectory,
    handlers: enabled || moveEnabled ? { onDragOver, onDragLeave, onDrop } : {},
  };
}
