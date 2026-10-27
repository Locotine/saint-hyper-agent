// FILE: providerTranscripts.ts
// Purpose: Finds a provider session's native transcript file (Claude Code's
//          `projects/*/<session>.jsonl`, Codex's `sessions/**/rollout-*-<thread>.jsonl`)
//          from the resume cursor Saint keeps for the thread, so a transcript
//          handoff can point the next agent at the full history.
// Layer: Provider utility
// Exports: resolveProviderTranscriptPath, ProviderTranscriptHomes

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Home folders to search, most specific first; blanks are ignored. */
export interface ProviderTranscriptHomes {
  /** Claude config dirs (each holds `projects/`). */
  readonly claudeConfigDirs: readonly (string | null | undefined)[];
  /** Codex homes (each holds `sessions/`). */
  readonly codexHomes: readonly (string | null | undefined)[];
}

// Codex nests rollouts as sessions/YYYY/MM/DD/; stop well past that.
const CODEX_SESSIONS_MAX_DEPTH = 5;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/u;

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && SAFE_ID_PATTERN.test(field) ? field : null;
}

function uniqueDirs(dirs: readonly (string | null | undefined)[]): string[] {
  return [...new Set(dirs.map((dir) => dir?.trim() ?? "").filter((dir) => dir.length > 0))];
}

async function isFile(candidate: string): Promise<boolean> {
  return (await fs.stat(candidate).catch(() => null))?.isFile() ?? false;
}

async function findClaudeTranscript(
  configDirs: readonly string[],
  sessionId: string,
): Promise<string | null> {
  for (const configDir of configDirs) {
    const projectsRoot = path.join(configDir, "projects");
    const projects = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = path.join(projectsRoot, project.name, `${sessionId}.jsonl`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function findCodexRollout(
  dir: string,
  suffix: string,
  depth: number,
): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  // Newest folders first: date-named folders sort by name.
  for (const entry of entries.toSorted((a, b) => b.name.localeCompare(a.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
      return entryPath;
    }
    if (entry.isDirectory() && depth > 0) {
      const found = await findCodexRollout(entryPath, suffix, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The transcript file of a thread's provider session, or null when the
 * provider keeps none Saint can locate (or the session never started).
 */
export async function resolveProviderTranscriptPath(input: {
  readonly provider: string;
  readonly resumeCursor: unknown;
  readonly homes?: Partial<ProviderTranscriptHomes>;
}): Promise<string | null> {
  const home = os.homedir();
  if (input.provider === "claudeAgent") {
    const sessionId = stringField(input.resumeCursor, "resume");
    if (!sessionId) return null;
    return findClaudeTranscript(
      uniqueDirs([
        ...(input.homes?.claudeConfigDirs ?? []),
        process.env.CLAUDE_CONFIG_DIR,
        path.join(home, ".claude"),
      ]),
      sessionId,
    );
  }
  if (input.provider === "codex") {
    const threadId = stringField(input.resumeCursor, "threadId");
    if (!threadId) return null;
    for (const codexHome of uniqueDirs([
      ...(input.homes?.codexHomes ?? []),
      process.env.CODEX_HOME,
      path.join(home, ".codex"),
    ])) {
      const found = await findCodexRollout(
        path.join(codexHome, "sessions"),
        `-${threadId}.jsonl`,
        CODEX_SESSIONS_MAX_DEPTH,
      );
      if (found) return found;
    }
  }
  return null;
}
