// FILE: htmlPreviewFiles.ts
// Purpose: Folder-scoped grants for rendered HTML previews. A grant names one HTML
//          file's folder; the preview route serves files inside it, so the page's
//          relative assets load while nothing outside that folder is reachable.
// Layer: Server HTTP utility
// Exports: createHtmlPreviewGrant, resolveHtmlPreviewFile, HTML preview grant limits

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { isHtmlPreviewablePath } from "@saint/shared/localPreviewFiles";

/** A grant lives while the preview keeps loading files, and this long after the last one. */
export const HTML_PREVIEW_GRANT_IDLE_TTL_MS = 30 * 60 * 1000;
const HTML_PREVIEW_GRANT_MAX = 256;

interface HtmlPreviewGrant {
  readonly rootPath: string;
  expiresAtMs: number;
}

const htmlPreviewGrantByToken = new Map<string, HtmlPreviewGrant>();

function pruneHtmlPreviewGrants(nowMs: number): void {
  for (const [token, grant] of htmlPreviewGrantByToken) {
    if (grant.expiresAtMs <= nowMs) htmlPreviewGrantByToken.delete(token);
  }
  // Oldest first (insertion order); a busy client never grows the map without bound.
  for (const token of htmlPreviewGrantByToken.keys()) {
    if (htmlPreviewGrantByToken.size <= HTML_PREVIEW_GRANT_MAX) break;
    htmlPreviewGrantByToken.delete(token);
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export async function createHtmlPreviewGrant(input: {
  readonly requestedPath: string;
  readonly nowMs?: number;
}): Promise<{ readonly grant: string; readonly entryName: string }> {
  const requestedPath = input.requestedPath.trim();
  if (!requestedPath || requestedPath.includes("\0") || !path.isAbsolute(requestedPath)) {
    throw new Error("Only absolute HTML files can be previewed.");
  }
  const realFilePath = await fs.realpath(path.resolve(requestedPath)).catch(() => null);
  if (!realFilePath || !isHtmlPreviewablePath(realFilePath)) {
    throw new Error("HTML file not found.");
  }
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) throw new Error("HTML file not found.");

  const nowMs = input.nowMs ?? Date.now();
  const grant = crypto.randomUUID();
  htmlPreviewGrantByToken.set(grant, {
    rootPath: path.dirname(realFilePath),
    expiresAtMs: nowMs + HTML_PREVIEW_GRANT_IDLE_TTL_MS,
  });
  pruneHtmlPreviewGrants(nowMs);
  return { grant, entryName: path.basename(realFilePath) };
}

/**
 * The file a preview request names, or null. `routePath` is the URL path after
 * the route prefix: `<grant>/<encoded segments>`. Dot segments and hidden
 * entries are refused, and symlinks must stay inside the granted folder.
 */
export async function resolveHtmlPreviewFile(input: {
  readonly routePath: string;
  readonly nowMs?: number;
}): Promise<{ readonly path: string; readonly sizeBytes: number } | null> {
  // Empty segments (`a//b`) stay in and are refused below like any other bad segment.
  const encodedSegments = input.routePath.replace(/^\/+/u, "").split("/");
  const token = encodedSegments.shift();
  if (!token || encodedSegments.length === 0) return null;
  const nowMs = input.nowMs ?? Date.now();
  const grant = htmlPreviewGrantByToken.get(token);
  if (!grant || grant.expiresAtMs <= nowMs) return null;

  const segments: string[] = [];
  for (const encoded of encodedSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment.startsWith(".") ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }

  const realFilePath = await fs.realpath(path.join(grant.rootPath, ...segments)).catch(() => null);
  if (!realFilePath || !isPathInside(realFilePath, grant.rootPath)) return null;
  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat?.isFile()) return null;
  grant.expiresAtMs = nowMs + HTML_PREVIEW_GRANT_IDLE_TTL_MS;
  return { path: realFilePath, sizeBytes: stat.size };
}
