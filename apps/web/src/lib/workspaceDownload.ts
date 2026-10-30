// FILE: workspaceDownload.ts
// Purpose: Saves workspace files from a connected remote host on this computer (Explorer
//          "Download"), through the desktop app's own save dialogs.
// Layer: Web workspace transport
// Exports: downloadWorkspaceFiles, canDownloadWorkspaceFiles

import type { DesktopWorkspaceDownloadResult } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

function downloadBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.remoteSsh?.downloadFiles;
}

/** Only a remote host's files download: this computer's files are already here. */
export function canDownloadWorkspaceFiles(hostId: HostId): boolean {
  return hostId !== LOCAL_HOST_ID && downloadBridge() !== undefined;
}

/**
 * One Save dialog for a single file, one folder dialog for several. Resolves
 * null when the desktop app cannot download (a browser or an older build).
 */
export async function downloadWorkspaceFiles(input: {
  /** The host's SSH name, as the desktop app knows it. */
  readonly host: string;
  readonly cwd: string;
  /** Workspace-relative file paths. */
  readonly paths: readonly string[];
}): Promise<DesktopWorkspaceDownloadResult | null> {
  const download = downloadBridge();
  if (!download) return null;
  return download({
    host: input.host,
    items: input.paths.map((path) => ({
      cwd: input.cwd,
      path,
      fileName: path.slice(path.lastIndexOf("/") + 1),
    })),
  });
}
