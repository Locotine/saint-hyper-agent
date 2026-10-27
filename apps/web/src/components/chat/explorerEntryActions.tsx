// FILE: explorerEntryActions.tsx
// Purpose: Right-click actions of the Explorer tree: copy the full path, create a
//          file or folder, and delete an entry. Paths are the server's, so in a
//          remote window they act on the remote host.
// Layer: Chat workspace-browsing UI behavior
// Exports: useExplorerEntryActions

import type { ProjectFileSystemEntry } from "@saint/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import type { ChatFileReference } from "~/lib/chatReferences";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { RenameDialog } from "../RenameDialog";
import { toastManager } from "../ui/toast";
import { explorerDropDirectoryFor } from "./explorerFileDrop";

interface CreateRequest {
  readonly kind: ProjectFileSystemEntry["kind"];
  /** Workspace-relative folder; "" for the workspace root. */
  readonly directory: string;
}

function parentDirectoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Context-menu openers for tree rows and the tree's empty space, plus the
 * name dialog they open. Render `dialog` once next to the tree.
 */
export function useExplorerEntryActions(input: {
  readonly workspaceRoot: string | null;
  readonly onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  readonly onSelectFile?: (path: string) => void;
}): {
  readonly openEntryMenu: (
    entry: Pick<ProjectFileSystemEntry, "path" | "kind">,
    position: { x: number; y: number },
  ) => void;
  readonly openRootMenu: (position: { x: number; y: number }) => void;
  readonly dialog: ReactNode;
} {
  const queryClient = useQueryClient();
  const [createRequest, setCreateRequest] = useState<CreateRequest | null>(null);
  const { workspaceRoot, onReferenceInChat, onSelectFile } = input;

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
      await refreshDirectory(parentDirectoryOf(entry.path));
      toastManager.add({ type: "success", title: `Deleted ${entry.path}` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not delete ${entry.path}`,
        description: errorMessage(error),
      });
    }
  };

  const explorerActions = (
    directory: string,
    entry?: Pick<ProjectFileSystemEntry, "path" | "kind">,
  ) =>
    workspaceRoot
      ? {
          onNewFile: () => setCreateRequest({ kind: "file", directory }),
          onNewFolder: () => setCreateRequest({ kind: "directory", directory }),
          onDelete: () => {
            if (entry) void deleteEntry(entry);
          },
        }
      : undefined;

  const openEntryMenu = (
    entry: Pick<ProjectFileSystemEntry, "path" | "kind">,
    position: { x: number; y: number },
  ) => {
    const actions = explorerActions(explorerDropDirectoryFor(entry), entry);
    void showFileReferenceContextMenu({
      path: entry.path,
      position,
      onReferenceInChat,
      workspaceRoot,
      ...(actions ? { explorerActions: actions } : {}),
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
        if (clicked === "new-file") setCreateRequest({ kind: "file", directory: "" });
        if (clicked === "new-folder") setCreateRequest({ kind: "directory", directory: "" });
      });
  };

  const create = async (name: string) => {
    if (!workspaceRoot || !createRequest) return;
    const relativePath = createRequest.directory ? `${createRequest.directory}/${name}` : name;
    try {
      const result = await ensureNativeApi().projects.createEntry({
        cwd: workspaceRoot,
        relativePath,
        kind: createRequest.kind,
      });
      await refreshDirectory(parentDirectoryOf(result.relativePath));
      if (createRequest.kind === "file") onSelectFile?.(result.relativePath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: createRequest.kind === "file" ? "Could not create file" : "Could not create folder",
        description: errorMessage(error),
      });
      // Keeps the dialog open so the name can be corrected.
      throw error;
    }
  };

  const dialog = (
    <RenameDialog
      open={createRequest !== null}
      title={createRequest?.kind === "directory" ? "New Folder" : "New File"}
      description={`In ${createRequest?.directory ? `${createRequest.directory}/` : "the workspace root"}. Use / to create nested folders.`}
      initialValue=""
      placeholder={createRequest?.kind === "directory" ? "folder-name" : "file-name.ext"}
      saveLabel="Create"
      isValueValid={(value) =>
        !value.startsWith("/") && !value.split("/").some((part) => part === "." || part === "..")
      }
      onOpenChange={(open) => {
        if (!open) setCreateRequest(null);
      }}
      onSave={create}
    />
  );

  return { openEntryMenu, openRootMenu, dialog };
}
