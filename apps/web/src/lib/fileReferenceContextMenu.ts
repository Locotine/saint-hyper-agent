// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows, file previews, and chat file
//          links (editor explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu, getRevealInFolderLabel

import type { ContextMenuItem } from "@saint/contracts";
import { joinWorkspaceRelativePath } from "@saint/shared/path";

import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { contextMenuGroup } from "~/lib/contextMenuGroup";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export function getRevealInFolderLabel(platform: string): string {
  if (isWindowsPlatform(platform)) {
    return "Open in Explorer";
  }
  if (isMacPlatform(platform)) {
    return "Reveal in Finder";
  }
  return "Show in folder";
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(input: {
  path: string;
  /** Absolute path to reveal in the platform file manager. Omit when the
   * surface only knows a repository-relative path. */
  revealPath?: string;
  position: { x: number; y: number };
  /** Line/column range from source views, or a quoted snippet from surfaces
   * without stable source lines (rendered markdown preview). */
  selection?: Omit<ChatFileReference, "path"> | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  /** Root `path` is relative to; adds "Copy path › Full path" (the host's path in a remote window). */
  workspaceRoot?: string | null;
  /**
   * File-tree actions; each receives nothing and acts on the clicked entry or
   * selection. Their presence switches to the Explorer's VS Code-like order.
   */
  explorerActions?: {
    readonly onNewFile: () => void;
    readonly onNewFolder: () => void;
    readonly onRename: () => void;
    readonly onDelete: () => void;
    /** Delete's label when it acts on several entries ("Delete 3 items…"). */
    readonly deleteLabel?: string;
    /** Remote windows: saves the targeted files on this computer. */
    readonly download?: { readonly label: string; readonly onDownload: () => void };
  };
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const revealPath =
    input.revealPath &&
    typeof window !== "undefined" &&
    window.desktopBridge &&
    !window.desktopBridge.remoteWindow
      ? input.revealPath
      : undefined;
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const fullPath = input.workspaceRoot
    ? joinWorkspaceRelativePath(input.workspaceRoot, input.path)
    : null;
  const referenceItems: ContextMenuItem<FileReferenceMenuItemId>[] = [
    ...(input.onReferenceInChat
      ? [
          {
            id: "reference-in-chat" as const,
            label: rangeLabel
              ? `Reference ${rangeLabel} in chat`
              : hasSnippet
                ? "Reference selection in chat"
                : "Reference in chat",
          },
        ]
      : []),
    ...(input.onAskWhyInChat
      ? [
          {
            id: "ask-why-in-chat" as const,
            label: rangeLabel ? `Ask why ${rangeLabel} changed` : "Ask why this changed",
          },
        ]
      : []),
    ...(revealPath
      ? [
          {
            id: "reveal-in-folder" as const,
            label: getRevealInFolderLabel(getNavigatorPlatform()),
          },
        ]
      : []),
  ];
  const copyPathItems = (separatorBefore: boolean) =>
    contextMenuGroup<FileReferenceMenuItemId>(
      {
        id: "copy-path-group",
        label: "Copy path",
        ...(separatorBefore ? { separatorBefore } : {}),
      },
      [
        { id: "copy-path", label: "Relative path", standaloneLabel: "Copy path" },
        ...(fullPath ? [{ id: "copy-full-path" as const, label: "Full path" }] : []),
      ],
    );
  const explorer = input.explorerActions;
  const clicked = await api.contextMenu.show<FileReferenceMenuItemId>(
    explorer
      ? [
          // VS Code's Explorer order: create | download | copy, reference | edit.
          { id: "new-file", label: "New File…" },
          { id: "new-folder", label: "New Folder…" },
          ...(explorer.download
            ? [{ id: "download" as const, label: explorer.download.label, separatorBefore: true }]
            : []),
          ...copyPathItems(true),
          ...referenceItems,
          { id: "rename", label: "Rename…", separatorBefore: true },
          { id: "delete", label: explorer.deleteLabel ?? "Delete…", destructive: true },
        ]
      : [...referenceItems, ...copyPathItems(false)],
    input.position,
  );
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "reveal-in-folder" && revealPath) {
    try {
      await api.shell.showInFolder(revealPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to reveal file",
        description:
          error instanceof Error ? error.message : "An unknown error occurred opening the file.",
      });
    }
    return;
  }
  if (clicked === "copy-path") {
    await copyTextToClipboard(input.path);
    return;
  }
  if (clicked === "copy-full-path" && fullPath) {
    await copyTextToClipboard(fullPath);
    return;
  }
  if (clicked === "download") input.explorerActions?.download?.onDownload();
  if (clicked === "new-file") input.explorerActions?.onNewFile();
  if (clicked === "new-folder") input.explorerActions?.onNewFolder();
  if (clicked === "rename") input.explorerActions?.onRename();
  if (clicked === "delete") input.explorerActions?.onDelete();
}

type FileReferenceMenuItemId =
  | "reference-in-chat"
  | "ask-why-in-chat"
  | "reveal-in-folder"
  | "copy-path-group"
  | "copy-path"
  | "copy-full-path"
  | "download"
  | "new-file"
  | "new-folder"
  | "rename"
  | "delete";
