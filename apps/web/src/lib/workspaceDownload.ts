// FILE: workspaceDownload.ts
// Purpose: Saves workspace files and folders (as .zip) from the local or connected
//          remote host onto this computer or browser.
// Layer: Web workspace transport
// Exports: downloadWorkspaceFiles, canDownloadWorkspaceFiles, folderNameOfWorkspaceRoot,
//          parentWorkspaceRoot, joinChildWorkspaceRoot

import type { DesktopWorkspaceDownloadResult } from "@saint/contracts";
import { WORKSPACE_DOWNLOAD_ROUTE_PATH } from "@saint/shared/binaryTransfer";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { downloadUrlAsBlob } from "./browserDownload";
import { resolveHostHttpUrl } from "./wsHttpUrl";

function downloadBridge() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.remoteSsh?.downloadFiles;
}

export function folderNameOfWorkspaceRoot(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  return name.replace(/:$/, "") || "workspace";
}

export function parentWorkspaceRoot(cwd: string): string | null {
  const usesBackslash = cwd.includes("\\") && !cwd.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const normalized = cwd.replace(/[\\/]+$/, "");
  if (!normalized || normalized === "/") return null;
  if (/^[A-Za-z]:$/.test(normalized)) return null;
  const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSlash === -1) return null;
  if (lastSlash === 0) return "/";
  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${sep}`;
  }
  return parent;
}

export function joinChildWorkspaceRoot(cwd: string, relativeDirectory: string): string {
  const usesBackslash = cwd.includes("\\") && !cwd.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const base = cwd.replace(/[\\/]+$/, "");
  const child = relativeDirectory
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .replaceAll("/", sep)
    .replaceAll("\\", sep);
  if (!child) return cwd;
  return `${base}${sep}${child}`;
}

function downloadFileNameForEntry(
  cwd: string,
  entry: { readonly path: string; readonly kind: "file" | "directory" },
): string {
  if (entry.path === "." || entry.path === "") {
    return `${folderNameOfWorkspaceRoot(cwd)}.zip`;
  }
  const base = entry.path.slice(entry.path.lastIndexOf("/") + 1);
  return `${base}${entry.kind === "directory" ? ".zip" : ""}`;
}

/** Both local and remote hosts can download files and folders (as .zip). */
export function canDownloadWorkspaceFiles(_hostId: HostId): boolean {
  return typeof window !== "undefined";
}

/**
 * Downloads workspace files or folders (zipped by the server). Uses the desktop native
 * save dialog when a remote SSH bridge is active, or falls back to direct HTTP download
 * (which works on both local desktop/browser and remote connections).
 */
export async function downloadWorkspaceFiles(input: {
  /** The host's SSH name, when downloading via the desktop remote SSH bridge. */
  readonly host?: string | null;
  readonly hostId?: HostId;
  readonly cwd: string;
  /** Workspace-relative files and folders ("." for the entire current workspace root). */
  readonly entries: ReadonlyArray<{ readonly path: string; readonly kind: "file" | "directory" }>;
}): Promise<DesktopWorkspaceDownloadResult | null> {
  const download = downloadBridge();
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  if (hostId !== LOCAL_HOST_ID && input.host && download) {
    return download({
      host: input.host,
      items: input.entries.map((entry) => ({
        cwd: input.cwd,
        path: entry.path,
        fileName: downloadFileNameForEntry(input.cwd, entry),
      })),
    });
  }

  const saved: Array<{ path: string; fileName: string }> = [];
  const failures: Array<{ fileName: string; message: string }> = [];

  for (const entry of input.entries) {
    const fileName = downloadFileNameForEntry(input.cwd, entry);
    const params = new URLSearchParams({
      cwd: input.cwd,
      path: entry.path || ".",
    });
    const url = resolveHostHttpUrl(hostId, `${WORKSPACE_DOWNLOAD_ROUTE_PATH}?${params.toString()}`);
    try {
      await downloadUrlAsBlob({ url, filename: fileName });
      saved.push({ path: fileName, fileName });
    } catch (error) {
      failures.push({
        fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { canceled: false, saved, failures };
}
