// FILE: desktopStorageMigration.ts
// Purpose: Reads and acknowledges a validated browser-storage handoff from older desktop builds.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import type { SaintStorageSnapshot } from "@saint/contracts";

export const SAINT_STORAGE_SNAPSHOT_FILE_NAME = "saint-storage-origin-v1.json";
export const SAINT_STORAGE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES = 2_048;
export const SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH = 512;
export const SAINT_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH = 16 * 1024 * 1024;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSaintStorageKey(key: string): boolean {
  return key.startsWith("saint:") || key.startsWith("saint.");
}

export function validateSaintStorageSnapshot(value: unknown): SaintStorageSnapshot | null {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.entries)) {
    return null;
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) {
    return null;
  }

  const entries = Object.entries(value.entries);
  if (entries.length > SAINT_STORAGE_SNAPSHOT_MAX_ENTRIES) {
    return null;
  }
  for (const [key, entryValue] of entries) {
    if (
      !isSaintStorageKey(key) ||
      key.length === 0 ||
      key.length > SAINT_STORAGE_SNAPSHOT_MAX_KEY_LENGTH ||
      typeof entryValue !== "string" ||
      entryValue.length > SAINT_STORAGE_SNAPSHOT_MAX_VALUE_LENGTH
    ) {
      return null;
    }
  }

  const snapshot = value as unknown as SaintStorageSnapshot;
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SAINT_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  return snapshot;
}

export function resolveSaintStorageSnapshotPath(userDataPath: string): string {
  return Path.join(userDataPath, SAINT_STORAGE_SNAPSHOT_FILE_NAME);
}

export function readSaintStorageSnapshot(snapshotPath: string): SaintStorageSnapshot | null {
  try {
    const stats = FS.statSync(snapshotPath);
    if (!stats.isFile() || stats.size > SAINT_STORAGE_SNAPSHOT_MAX_BYTES) {
      return null;
    }
    return validateSaintStorageSnapshot(JSON.parse(FS.readFileSync(snapshotPath, "utf8")));
  } catch {
    return null;
  }
}

export async function acknowledgeSaintStorageSnapshot(snapshotPath: string): Promise<void> {
  await FS.promises.rm(snapshotPath, { force: true }).catch(() => undefined);
}
