// FILE: persistedRecord.ts
// Purpose: Shared helpers for validating untrusted persisted (localStorage) state.
// Layer: Web UI state utilities
// Exports: plain-object guard, a string-keyed record sanitizer used by stores, and the
//          re-keying that upgrades raw-id records to host-scoped ids.

import {
  parseScopedProjectId,
  parseScopedThreadId,
  type ScopedProjectId,
  type ScopedThreadId,
} from "@saint/shared/hostId";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys that must never be copied from untrusted persisted input: assigning
// `__proto__` (and friends) via bracket notation can mutate the object
// prototype instead of creating a data key (prototype pollution).
const UNSAFE_RECORD_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

// Rebuilds a `Record<string, T>` from untrusted persisted input: keeps only own
// string keys whose value survives `sanitizeEntry`, dropping anything that maps
// to `null`. Returns an empty record when the input is not a plain object, so a
// corrupt blob can never reach consumers as a malformed map.
export function sanitizeStringKeyedRecord<T>(
  value: unknown,
  sanitizeEntry: (rawEntry: unknown) => T | null,
): Record<string, T> {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: Record<string, T> = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    if (UNSAFE_RECORD_KEYS.has(key)) {
      continue;
    }
    const sanitized = sanitizeEntry(rawEntry);
    if (sanitized !== null) {
      result[key] = sanitized;
    }
  }
  return result;
}

// Records saved before host scoping are keyed by raw ids: those are this computer's.
// Already-scoped keys pass through, so re-reading the new format is a no-op.
export function scopeThreadKeyedRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<ScopedThreadId, T> {
  const result: Record<ScopedThreadId, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const scoped = parseScopedThreadId(key);
    if (scoped !== null) result[scoped] = value;
  }
  return result;
}

export function scopeProjectKeyedRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<ScopedProjectId, T> {
  const result: Record<ScopedProjectId, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const scoped = parseScopedProjectId(key);
    if (scoped !== null) result[scoped] = value;
  }
  return result;
}
