import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeSaintStorageSnapshot,
  readSaintStorageSnapshot,
  SAINT_STORAGE_SNAPSHOT_MAX_BYTES,
  validateSaintStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = () => ({
  version: 1 as const,
  exportedAt: "2026-07-09T00:00:00.000Z",
  entries: {
    "saint:theme": "dark",
    "saint.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("reads a legacy snapshot and removes it after acknowledgement", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "saint-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      FS.writeFileSync(target, `${JSON.stringify(snapshot())}\n`);
      expect(readSaintStorageSnapshot(target)).toEqual(snapshot());

      await acknowledgeSaintStorageSnapshot(target);
      expect(readSaintStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateSaintStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateSaintStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateSaintStorageSnapshot({
        ...snapshot(),
        entries: { "saint:large": "x".repeat(SAINT_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateSaintStorageSnapshot({
        ...snapshot(),
        entries: { "saint:composer-drafts:v1": largeDraft },
      })?.entries["saint:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "saint-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readSaintStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readSaintStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
