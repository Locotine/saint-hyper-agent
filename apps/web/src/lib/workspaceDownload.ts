// FILE: workspaceDownload.ts
// Purpose: Saves workspace files from a remote window's host on this computer
//          (Explorer "Download"), through the desktop app's own save dialogs.
// Layer: Web workspace transport
// Exports: downloadWorkspaceFiles, canDownloadWorkspaceFiles

import type { DesktopWorkspaceDownloadResult } from "@saint/contracts";
import { WORKSPACE_DOWNLOAD_ROUTE_PATH } from "@saint/shared/binaryTransfer";

import { resolveWsHttpUrl } from "./wsHttpUrl";

function downloadBridge() {
  return typeof window === "undefined"
    ? undefined
    : window.desktopBridge?.remoteWindow?.downloadFiles;
}

/** Only remote windows download: in a local window the files are already here. */
export function canDownloadWorkspaceFiles(): boolean {
  return downloadBridge() !== undefined;
}

/**
 * One Save dialog for a single file, one folder dialog for several. Resolves
 * null when the desktop app cannot download (a browser or an older build).
 */
export async function downloadWorkspaceFiles(input: {
  readonly cwd: string;
  /** Workspace-relative file paths. */
  readonly paths: readonly string[];
}): Promise<DesktopWorkspaceDownloadResult | null> {
  const download = downloadBridge();
  if (!download) return null;
  return download({
    items: input.paths.map((path) => ({
      url: resolveWsHttpUrl(
        `${WORKSPACE_DOWNLOAD_ROUTE_PATH}?${new URLSearchParams({ cwd: input.cwd, path }).toString()}`,
      ),
      fileName: path.slice(path.lastIndexOf("/") + 1),
    })),
  });
}
