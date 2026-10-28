// FILE: workspaceDownload.ts
// Purpose: Explorer "Download". No desktop bridge offers downloads, so it is
//          never available.
// Layer: Web workspace transport
// Exports: downloadWorkspaceFiles, canDownloadWorkspaceFiles

import type { DesktopWorkspaceDownloadResult } from "@saint/contracts";

// ponytail: kept only for explorerEntryActions.tsx; delete with its Download action.
export function canDownloadWorkspaceFiles(): boolean {
  return false;
}

export async function downloadWorkspaceFiles(_input: {
  readonly cwd: string;
  /** Workspace-relative file paths. */
  readonly paths: readonly string[];
}): Promise<DesktopWorkspaceDownloadResult | null> {
  return null;
}
