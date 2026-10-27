import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProviderTranscriptPath } from "./providerTranscripts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saint-transcripts-"));
  tempDirs.push(dir);
  return dir;
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveProviderTranscriptPath", () => {
  it("finds a Claude session file under any project folder", async () => {
    const configDir = makeTempDir();
    const transcript = path.join(configDir, "projects", "-Users-me-app", "abc-123.jsonl");
    touch(transcript);
    await expect(
      resolveProviderTranscriptPath({
        provider: "claudeAgent",
        resumeCursor: { threadId: "t", resume: "abc-123" },
        homes: { claudeConfigDirs: [configDir] },
      }),
    ).resolves.toBe(transcript);
  });

  it("finds a Codex rollout by thread id in dated folders", async () => {
    const codexHome = makeTempDir();
    const rollout = path.join(
      codexHome,
      "sessions",
      "2026",
      "10",
      "26",
      "rollout-2026-10-26T10-00-00-0199aaaa-bbbb.jsonl",
    );
    touch(rollout);
    touch(path.join(codexHome, "sessions", "2026", "10", "25", "rollout-x-other.jsonl"));
    await expect(
      resolveProviderTranscriptPath({
        provider: "codex",
        resumeCursor: { threadId: "0199aaaa-bbbb" },
        homes: { codexHomes: [codexHome] },
      }),
    ).resolves.toBe(rollout);
  });

  it("returns null without a usable session id or for other providers", async () => {
    const configDir = makeTempDir();
    for (const input of [
      { provider: "claudeAgent", resumeCursor: null },
      { provider: "claudeAgent", resumeCursor: { resume: "../escape" } },
      { provider: "claudeAgent", resumeCursor: { resume: "missing" } },
      { provider: "cursor", resumeCursor: { threadId: "x" } },
    ]) {
      await expect(
        resolveProviderTranscriptPath({
          ...input,
          homes: { claudeConfigDirs: [configDir], codexHomes: [configDir] },
        }),
      ).resolves.toBeNull();
    }
  });
});
