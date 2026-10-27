// FILE: explorerFileDrop.ts
// Purpose: Lets the Explorer tree accept local files dragged in from the OS and
//          upload them into the folder under the pointer. Enabled in remote SSH
//          windows, where a local path means nothing on the host.
// Layer: Chat workspace-browsing UI behavior
// Exports: useExplorerFileDrop, EXPLORER_DROP_DIRECTORY_ATTRIBUTE, EXPLORER_DROP_TARGET_CLASS_NAME

import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent as ReactDragEvent, useState } from "react";

import { remoteWindowHost } from "~/env";
import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { uploadFilesToWorkspace } from "~/lib/workspaceUpload";
import { toastManager } from "../ui/toast";

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
 * while nothing is dragged over it, "" for the workspace root).
 */
export function useExplorerFileDrop(workspaceRoot: string | null) {
  const queryClient = useQueryClient();
  const [dropDirectory, setDropDirectory] = useState<string | null>(null);
  const enabled = remoteWindowHost !== null && workspaceRoot !== null;

  const onDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!enabled || !isOsFileDrag(event)) return;
    // Handled here so the chat pane underneath does not also attach the file.
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    const next = dropDirectoryAt(event);
    if (next !== dropDirectory) setDropDirectory(next);
  };

  const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!enabled) return;
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDropDirectory(null);
    }
  };

  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
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
    handlers: enabled ? { onDragOver, onDragLeave, onDrop } : {},
  };
}
