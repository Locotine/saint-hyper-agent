// FILE: workspaceUpload.ts
// Purpose: Uploads local files dropped onto the Explorer into a workspace folder on
//          the server of the host the Explorer shows, reporting live upload progress.
// Layer: Web workspace transport
// Exports: uploadFilesToWorkspace, WORKSPACE_UPLOAD_LIMIT_LABEL, WorkspaceUploadProgress,
//          useWorkspaceUploadProgress

import type { HostId } from "@saint/shared/hostId";
import {
  WORKSPACE_UPLOAD_MAX_BYTES,
  WORKSPACE_UPLOAD_ROUTE_PATH,
} from "@saint/shared/binaryTransfer";
import { useSyncExternalStore } from "react";

import { resolveHostHttpUrl } from "./wsHttpUrl";

export const WORKSPACE_UPLOAD_LIMIT_LABEL = `${Math.round(WORKSPACE_UPLOAD_MAX_BYTES / (1024 * 1024))}MB`;

export interface WorkspaceUploadResult {
  /** Workspace-relative paths written, in drop order. */
  readonly uploaded: string[];
  readonly failures: Array<{ readonly name: string; readonly message: string }>;
}

export interface WorkspaceUploadProgress {
  readonly cwd: string;
  readonly totalFiles: number;
  readonly completedFiles: number;
  readonly currentFileName: string;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

const uploadProgressByCwd = new Map<string, WorkspaceUploadProgress>();
const activeUploadIdByCwd = new Map<string, number>();
let nextUploadId = 0;
const uploadProgressListeners = new Set<() => void>();

function notifyUploadProgress(cwd: string, progress: WorkspaceUploadProgress | null): void {
  if (progress === null) {
    uploadProgressByCwd.delete(cwd);
  } else {
    uploadProgressByCwd.set(cwd, progress);
  }
  for (const listener of uploadProgressListeners) {
    listener();
  }
}

function subscribeUploadProgress(listener: () => void): () => void {
  uploadProgressListeners.add(listener);
  return () => {
    uploadProgressListeners.delete(listener);
  };
}

export function useWorkspaceUploadProgress(cwd: string | null): WorkspaceUploadProgress | null {
  return useSyncExternalStore(
    subscribeUploadProgress,
    () => (cwd ? (uploadProgressByCwd.get(cwd) ?? null) : null),
    () => null,
  );
}

/**
 * Sends each file in turn; one failure does not stop the rest. A taken name is
 * never replaced: the server writes `name (1).ext` instead.
 */
export async function uploadFilesToWorkspace(input: {
  readonly cwd: string;
  /** Workspace-relative folder; null for the workspace root. */
  readonly directory: string | null;
  readonly files: readonly File[];
  readonly hostId: HostId;
  readonly onProgress?: (progress: WorkspaceUploadProgress | null) => void;
}): Promise<WorkspaceUploadResult> {
  const result: WorkspaceUploadResult = { uploaded: [], failures: [] };
  const totalFiles = input.files.length;
  const totalBytes = input.files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  let completedFiles = 0;
  let completedBytes = 0;

  const uploadId = ++nextUploadId;
  activeUploadIdByCwd.set(input.cwd, uploadId);

  const emitProgress = (currentFileName: string, currentFileLoadedBytes: number) => {
    const loadedBytes = Math.min(totalBytes, completedBytes + currentFileLoadedBytes);
    const percent =
      totalBytes > 0
        ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
        : totalFiles > 0
          ? Math.min(100, Math.round((completedFiles / totalFiles) * 100))
          : 100;
    const snapshot: WorkspaceUploadProgress = {
      cwd: input.cwd,
      totalFiles,
      completedFiles,
      currentFileName,
      loadedBytes,
      totalBytes,
      percent,
    };
    if (activeUploadIdByCwd.get(input.cwd) === uploadId) {
      notifyUploadProgress(input.cwd, snapshot);
    }
    input.onProgress?.(snapshot);
  };

  try {
    for (const file of input.files) {
      emitProgress(file.name, 0);
      if (file.size > WORKSPACE_UPLOAD_MAX_BYTES) {
        result.failures.push({
          name: file.name,
          message: `Larger than ${WORKSPACE_UPLOAD_LIMIT_LABEL}.`,
        });
        completedFiles += 1;
        completedBytes += Math.max(0, file.size);
        emitProgress(file.name, 0);
        continue;
      }
      const params = new URLSearchParams({ cwd: input.cwd, name: file.name });
      if (input.directory) params.set("directory", input.directory);
      try {
        const response = await fetch(
          resolveHostHttpUrl(input.hostId, `${WORKSPACE_UPLOAD_ROUTE_PATH}?${params.toString()}`),
          { method: "POST", credentials: "include", body: file },
        );
        const payload = (await response.json().catch(() => null)) as {
          readonly relativePath?: unknown;
          readonly error?: unknown;
        } | null;
        if (!response.ok || typeof payload?.relativePath !== "string") {
          throw new Error(
            typeof payload?.error === "string"
              ? payload.error
              : `Upload failed with status ${response.status}.`,
          );
        }
        result.uploaded.push(payload.relativePath);
      } catch (error) {
        // A dropped folder has no readable body, so fetch rejects it here.
        result.failures.push({
          name: file.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      completedFiles += 1;
      completedBytes += Math.max(0, file.size);
      emitProgress(file.name, 0);
    }
  } finally {
    if (activeUploadIdByCwd.get(input.cwd) === uploadId) {
      activeUploadIdByCwd.delete(input.cwd);
      notifyUploadProgress(input.cwd, null);
    }
    input.onProgress?.(null);
  }
  return result;
}
