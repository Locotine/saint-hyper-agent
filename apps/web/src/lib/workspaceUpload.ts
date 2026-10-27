// FILE: workspaceUpload.ts
// Purpose: Uploads local files dropped onto the Explorer into a workspace folder on
//          the server (the remote host in a remote window).
// Layer: Web workspace transport
// Exports: uploadFilesToWorkspace, WORKSPACE_UPLOAD_LIMIT_LABEL

import {
  WORKSPACE_UPLOAD_MAX_BYTES,
  WORKSPACE_UPLOAD_ROUTE_PATH,
} from "@saint/shared/binaryTransfer";

import { resolveWsHttpUrl } from "./wsHttpUrl";

export const WORKSPACE_UPLOAD_LIMIT_LABEL = `${Math.round(WORKSPACE_UPLOAD_MAX_BYTES / (1024 * 1024))}MB`;

export interface WorkspaceUploadResult {
  /** Workspace-relative paths written, in drop order. */
  readonly uploaded: string[];
  readonly failures: Array<{ readonly name: string; readonly message: string }>;
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
}): Promise<WorkspaceUploadResult> {
  const result: WorkspaceUploadResult = { uploaded: [], failures: [] };
  for (const file of input.files) {
    if (file.size > WORKSPACE_UPLOAD_MAX_BYTES) {
      result.failures.push({
        name: file.name,
        message: `Larger than ${WORKSPACE_UPLOAD_LIMIT_LABEL}.`,
      });
      continue;
    }
    const params = new URLSearchParams({ cwd: input.cwd, name: file.name });
    if (input.directory) params.set("directory", input.directory);
    try {
      const response = await fetch(
        resolveWsHttpUrl(`${WORKSPACE_UPLOAD_ROUTE_PATH}?${params.toString()}`),
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
  }
  return result;
}
