// FILE: workspaceReplace.ts
// Purpose: "Replace across files" for the workspace code search: the same case-insensitive
//          literal match the server's content search uses, applied file by file through the
//          ordinary read/write file RPCs (so it works on this computer and on a connected host).
// Layer: Web lib

import type { HostId } from "@saint/shared/hostId";

import { projectApiFor } from "./projectReactQuery";

const REPLACE_READ_MAX_BYTES = 1_000_000;

export function replaceAllCaseInsensitive(
  contents: string,
  query: string,
  replacement: string,
): { contents: string; count: number } {
  let count = 0;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  // A function replacer keeps `$&` / `$1` in the replacement literal.
  const next = contents.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { contents: next, count };
}

export interface WorkspaceReplaceSummary {
  filesChanged: number;
  occurrences: number;
  /** Files left untouched: too large, linked, changed on disk meanwhile, or unwritable. */
  skipped: string[];
}

export async function replaceInWorkspaceFiles(input: {
  hostId: HostId;
  cwd: string;
  relativePaths: readonly string[];
  query: string;
  replacement: string;
}): Promise<WorkspaceReplaceSummary> {
  const api = projectApiFor(input.hostId);
  const summary: WorkspaceReplaceSummary = { filesChanged: 0, occurrences: 0, skipped: [] };
  for (const relativePath of input.relativePaths) {
    try {
      const file = await api.projects.readFile({
        cwd: input.cwd,
        relativePath,
        maxBytes: REPLACE_READ_MAX_BYTES,
      });
      if (file.truncated || file.symlink || !file.version) {
        summary.skipped.push(relativePath);
        continue;
      }
      const { contents, count } = replaceAllCaseInsensitive(
        file.contents,
        input.query,
        input.replacement,
      );
      if (count === 0) continue;
      await api.projects.writeFile({
        cwd: input.cwd,
        relativePath,
        contents,
        expectedVersion: file.version,
        ...(file.encoding ? { encoding: file.encoding } : {}),
        ...(file.lineEnding ? { lineEnding: file.lineEnding } : {}),
      });
      summary.filesChanged += 1;
      summary.occurrences += count;
    } catch {
      summary.skipped.push(relativePath);
    }
  }
  return summary;
}
