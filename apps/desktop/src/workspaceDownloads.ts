// FILE: workspaceDownloads.ts
// Purpose: Saves files from a connected remote host's workspace on this computer
//          (Explorer "Download"). Main fetches only that host's own tunnelled
//          download route, so the renderer cannot point it at any other URL.
// Layer: Desktop main-process helper
// Exports: resolveWorkspaceDownloadRequests, downloadWorkspaceFiles

import { randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { DesktopWorkspaceDownloadResult } from "@saint/contracts";
import { WORKSPACE_DOWNLOAD_ROUTE_PATH } from "@saint/shared/binaryTransfer";
import { isPlainUploadFileName, uploadFileNameCandidates } from "@saint/shared/uploadFileName";

const MAX_WORKSPACE_DOWNLOAD_ITEMS = 1000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface WorkspaceDownloadRequest {
  readonly url: string;
  readonly fileName: string;
}

export type WorkspaceDownloadDestination =
  /** Chosen in a Save dialog, which already confirmed replacing an existing file. */
  | { readonly kind: "file"; readonly path: string }
  /** Chosen in a folder dialog: a taken name gets " (1)" instead of being replaced. */
  | { readonly kind: "directory"; readonly path: string };

/**
 * Rebuilds every fetch URL from a host's tunnelled backend WebSocket URL
 * (`ws://127.0.0.1:<port>/?token=…`), keeping only the renderer's `cwd`, `path` and
 * plain `fileName`. Null when the backend is not loopback or any item is malformed.
 */
export function resolveWorkspaceDownloadRequests(
  rawItems: unknown,
  backendWsUrl: string | null,
): WorkspaceDownloadRequest[] | null {
  if (!backendWsUrl) return null;
  let backend: URL;
  try {
    backend = new URL(backendWsUrl);
  } catch {
    return null;
  }
  if (backend.protocol !== "ws:" || !LOOPBACK_HOSTNAMES.has(backend.hostname)) return null;
  const origin = `http://${backend.host}`;
  const token = backend.searchParams.get("token");
  if (!Array.isArray(rawItems) || rawItems.length > MAX_WORKSPACE_DOWNLOAD_ITEMS) return null;

  const requests: WorkspaceDownloadRequest[] = [];
  for (const item of rawItems as ReadonlyArray<{
    readonly cwd?: unknown;
    readonly path?: unknown;
    readonly fileName?: unknown;
  } | null>) {
    const { cwd, path, fileName } = item ?? {};
    if (typeof cwd !== "string" || typeof path !== "string" || typeof fileName !== "string") {
      return null;
    }
    if (!cwd || !path || !isPlainUploadFileName(fileName)) return null;
    const target = new URL(WORKSPACE_DOWNLOAD_ROUTE_PATH, origin);
    target.searchParams.set("cwd", cwd);
    target.searchParams.set("path", path);
    if (token) target.searchParams.set("token", token);
    requests.push({ url: target.toString(), fileName });
  }
  return requests;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { readonly error?: unknown } | null;
  return typeof payload?.error === "string"
    ? payload.error
    : `Download failed with status ${response.status}.`;
}

async function writeBody(body: ReadableStream<Uint8Array>, handle: FS.promises.FileHandle) {
  await pipeline(
    Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
    handle.createWriteStream(),
  );
}

// Writes beside the chosen file and renames over it, so a failed download
// leaves an existing file as it was.
async function saveReplacing(body: ReadableStream<Uint8Array>, filePath: string): Promise<string> {
  const temporaryPath = Path.join(
    Path.dirname(filePath),
    `.${Path.basename(filePath)}.${randomUUID()}.download`,
  );
  try {
    await writeBody(body, await FS.promises.open(temporaryPath, "wx"));
    await FS.promises.rename(temporaryPath, filePath);
  } catch (cause) {
    await FS.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw cause;
  }
  return filePath;
}

// Exclusive create ("wx") picks the first free name, so a file that appears
// concurrently is never replaced either.
async function saveWithoutReplacing(
  body: ReadableStream<Uint8Array>,
  directory: string,
  fileName: string,
): Promise<string> {
  for (const candidate of uploadFileNameCandidates(fileName)) {
    const filePath = Path.join(directory, candidate);
    let handle: FS.promises.FileHandle;
    try {
      handle = await FS.promises.open(filePath, "wx");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | null)?.code === "EEXIST") continue;
      throw cause;
    }
    try {
      await writeBody(body, handle);
    } catch (cause) {
      await FS.promises.rm(filePath, { force: true }).catch(() => undefined);
      throw cause;
    }
    return filePath;
  }
  throw new Error(`Too many files are already named like ${fileName}.`);
}

/** Downloads each file in turn; one failure does not stop the rest. */
export async function downloadWorkspaceFiles(input: {
  readonly requests: readonly WorkspaceDownloadRequest[];
  readonly destination: WorkspaceDownloadDestination;
  readonly fetch?: typeof fetch;
}): Promise<DesktopWorkspaceDownloadResult> {
  const fetchFile = input.fetch ?? fetch;
  const saved: Array<{ fileName: string; path: string }> = [];
  const failures: Array<{ fileName: string; message: string }> = [];
  for (const request of input.requests) {
    try {
      const response = await fetchFile(request.url);
      if (!response.ok || !response.body) throw new Error(await responseErrorMessage(response));
      const path =
        input.destination.kind === "file"
          ? await saveReplacing(response.body, input.destination.path)
          : await saveWithoutReplacing(response.body, input.destination.path, request.fileName);
      saved.push({ fileName: request.fileName, path });
    } catch (error) {
      failures.push({
        fileName: request.fileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { canceled: false, saved, failures };
}
