// FILE: hostId.ts
// Purpose: Host-qualified identity for multi-host Saint. A `HostId` names the backend
//          (this machine or one SSH host); `ScopedThreadId`/`ScopedProjectId` carry a
//          raw server ID together with its host so two hosts can never collide.
// Layer: Shared contracts. Wire contracts keep raw IDs; scoped IDs live only in the client.

import type { ProjectId, ThreadId } from "@saint/contracts";

export const LOCAL_HOST_ID = "local";
const SSH_HOST_PREFIX = "ssh:";
const HOST_KEY_PATTERN = /^[0-9a-f]{8}$/;
const SCOPE_SEPARATOR = "~";

/** `"local"` or `"ssh:<hostKey>"`. The key is generated once per saved host, never derived from its alias. */
export type HostId = typeof LOCAL_HOST_ID | `${typeof SSH_HOST_PREFIX}${string}`;

declare const scopedBrand: unique symbol;
type Scoped<Kind extends string> = string & { readonly [scopedBrand]: Kind };

/** `"<hostId>~<rawThreadId>"`. Build only with `scopeThread`; never concatenate by hand. */
export type ScopedThreadId = Scoped<"thread">;
/** `"<hostId>~<rawProjectId>"`. Build only with `scopeProject`; never concatenate by hand. */
export type ScopedProjectId = Scoped<"project">;

export interface ThreadRef {
  readonly hostId: HostId;
  readonly threadId: ThreadId;
}

export interface ProjectRef {
  readonly hostId: HostId;
  readonly projectId: ProjectId;
}

export function isHostKey(value: string): boolean {
  return HOST_KEY_PATTERN.test(value);
}

/** 8 random hex chars; stored with the saved host so renaming its alias keeps its data. */
export function generateHostKey(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sshHostId(hostKey: string): HostId {
  if (!isHostKey(hostKey)) throw new Error(`Invalid host key: ${hostKey}`);
  return `${SSH_HOST_PREFIX}${hostKey}`;
}

export function parseHostId(value: string): HostId | null {
  if (value === LOCAL_HOST_ID) return LOCAL_HOST_ID;
  if (value.startsWith(SSH_HOST_PREFIX) && isHostKey(value.slice(SSH_HOST_PREFIX.length))) {
    return value as HostId;
  }
  return null;
}

function scope<Kind extends string>(hostId: HostId, rawId: string): Scoped<Kind> {
  if (rawId.length === 0) throw new Error("Cannot scope an empty ID");
  return `${hostId}${SCOPE_SEPARATOR}${rawId}` as Scoped<Kind>;
}

// Strict: the prefix must be a valid HostId. Raw server IDs never contain a valid host prefix.
function unscope(value: string): { hostId: HostId; rawId: string } | null {
  const at = value.indexOf(SCOPE_SEPARATOR);
  if (at <= 0) return null;
  const hostId = parseHostId(value.slice(0, at));
  const rawId = value.slice(at + 1);
  return hostId && rawId.length > 0 ? { hostId, rawId } : null;
}

export function scopeThread(hostId: HostId, threadId: ThreadId): ScopedThreadId {
  return scope<"thread">(hostId, threadId);
}

export function scopeProject(hostId: HostId, projectId: ProjectId): ScopedProjectId {
  return scope<"project">(hostId, projectId);
}

export function unscopeThread(scoped: ScopedThreadId): ThreadRef {
  const parts = unscope(scoped);
  if (!parts) throw new Error(`Not a scoped thread ID: ${scoped}`);
  return { hostId: parts.hostId, threadId: parts.rawId as ThreadId };
}

export function unscopeProject(scoped: ScopedProjectId): ProjectRef {
  const parts = unscope(scoped);
  if (!parts) throw new Error(`Not a scoped project ID: ${scoped}`);
  return { hostId: parts.hostId, projectId: parts.rawId as ProjectId };
}

/**
 * Lenient parse for URLs, deep links and persisted state written before scoping:
 * a value without a host prefix is a raw local thread ID.
 */
export function parseScopedThreadId(value: string): ScopedThreadId | null {
  if (value.length === 0) return null;
  return unscope(value) ? (value as ScopedThreadId) : scope<"thread">(LOCAL_HOST_ID, value);
}

/** Same compatibility rule as `parseScopedThreadId`, for projects. */
export function parseScopedProjectId(value: string): ScopedProjectId | null {
  if (value.length === 0) return null;
  return unscope(value) ? (value as ScopedProjectId) : scope<"project">(LOCAL_HOST_ID, value);
}

export function hostIdOf(scoped: ScopedThreadId | ScopedProjectId): HostId {
  const parts = unscope(scoped);
  if (!parts) throw new Error(`Not a scoped ID: ${scoped}`);
  return parts.hostId;
}
