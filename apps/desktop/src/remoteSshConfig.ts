// FILE: remoteSshConfig.ts
// Purpose: Validates SSH remote targets and lists host aliases from the user's ssh config.
// Layer: Desktop remote SSH utility
// Exports: parseSshConfigHosts, isValidSshTarget, normalizeRemoteRoot, defaultRemoteRoot,
//          createRemoteClientId, parseRemoteClientId, clientRemoteRoot, compareInstallVersions,
//          saved-host parse/remember/serialize helpers

import { isHostKey } from "@saint/shared/hostId";
import { isRemoteClientId } from "@saint/shared/remoteClientId";

/**
 * Concrete `Host` aliases from an OpenSSH config file. Patterns (`*`, `?`) and
 * negations cannot be connected to by name, so they are skipped. `Include`d
 * files are not followed; their hosts can still be typed by hand.
 */
export function parseSshConfigHosts(contents: string): string[] {
  const hosts: string[] = [];
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    const match = /^host\s*(?:=\s*|\s)(.+)$/iu.exec(line);
    if (!match?.[1]) continue;
    for (const alias of match[1].split(/\s+/u)) {
      if (!alias || /[*?!]/u.test(alias) || !isValidSshTarget(alias)) continue;
      if (!hosts.includes(alias)) hosts.push(alias);
    }
  }
  return hosts;
}

/**
 * An ssh destination: `alias`, `host`, `user@host`, or a bracketed IPv6
 * address. A leading `-` would be parsed as an ssh option, so it is refused.
 */
export function isValidSshTarget(value: string): boolean {
  return /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9_.@%:-]{0,252})$/u.test(value);
}

/**
 * The remote install folder, relative to the remote `$HOME`. Only plain path
 * segments are allowed so the value can be embedded in remote shell scripts.
 * Returns null when the folder is absolute, escapes `$HOME`, or has unsafe
 * characters.
 */
export function normalizeRemoteRoot(value: string): string | null {
  const trimmed = value.trim().replace(/^~\//u, "").replace(/\/+$/u, "");
  if (!trimmed || !/^[A-Za-z0-9._/-]+$/u.test(trimmed)) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return trimmed;
}

/** `~/.saint` -> `.saint-remote`, `~/.saint-beta` -> `.saint-beta-remote`. */
export function defaultRemoteRoot(homeDirectoryName: string): string {
  return `${homeDirectoryName.replace(/^\.?/u, ".")}-remote`;
}

/**
 * Names this desktop install on remote hosts: the local user name for
 * readability plus random hex so two machines with the same user name never
 * share a folder. Created once and kept in the desktop's state folder.
 */
export function createRemoteClientId(localUserName: string, randomHex: string): string {
  const name =
    localUserName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^[-_]+|-+$/gu, "")
      .slice(0, 32) || "user";
  return `${name}-${randomHex.toLowerCase().slice(0, 8)}`;
}

/** A stored client id, or null when the file content is not one. */
export function parseRemoteClientId(contents: string): string | null {
  const id = contents.trim();
  return isRemoteClientId(id) ? id : null;
}

/**
 * This client's own folder under the shared one, which a desktop used by default before the
 * default became the shared folder itself. Hosts where it still holds data keep using it.
 */
export function clientRemoteRoot(storeRoot: string, clientId: string): string {
  return `${storeRoot}/clients/${clientId}`;
}

export interface SavedRemoteSshHost {
  readonly host: string;
  readonly remoteRoot: string | null;
  /** Stable identity (`@saint/shared/hostId`); absent in files written before multi-host. */
  readonly hostKey?: string;
  /** False once the user disconnected the host: it stays saved but is not reconnected at launch. */
  readonly autoConnect?: false;
}

/** Saved hosts from the desktop's JSON file; invalid entries are dropped. */
export function parseSavedRemoteSshHosts(contents: string): SavedRemoteSshHost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) return [];
  const saved: SavedRemoteSshHost[] = [];
  for (const entry of hosts) {
    const host = (entry as { host?: unknown } | null)?.host;
    const rawRoot = (entry as { remoteRoot?: unknown } | null)?.remoteRoot;
    if (typeof host !== "string" || !isValidSshTarget(host)) continue;
    if (saved.some((existing) => existing.host === host)) continue;
    const remoteRoot = typeof rawRoot === "string" ? normalizeRemoteRoot(rawRoot) : null;
    const rawKey = (entry as { hostKey?: unknown }).hostKey;
    const autoConnect = (entry as { autoConnect?: unknown }).autoConnect === false;
    saved.push({
      host,
      remoteRoot,
      ...(typeof rawKey === "string" && isHostKey(rawKey) ? { hostKey: rawKey } : {}),
      ...(autoConnect ? { autoConnect: false as const } : {}),
    });
  }
  return saved;
}

/** Puts `host` first (most recent), replacing an older entry for the same host. */
export function rememberRemoteSshHost(
  saved: readonly SavedRemoteSshHost[],
  host: SavedRemoteSshHost,
): SavedRemoteSshHost[] {
  const hostKey = host.hostKey ?? saved.find((existing) => existing.host === host.host)?.hostKey;
  return [
    hostKey ? { ...host, hostKey } : host,
    ...saved.filter((existing) => existing.host !== host.host),
  ];
}

export function serializeSavedRemoteSshHosts(saved: readonly SavedRemoteSshHost[]): string {
  return `${JSON.stringify({ version: 1, hosts: saved }, null, 2)}\n`;
}

function splitInstallVersion(version: string) {
  const core = version.replace(/-[0-9a-f]{12}$/u, "");
  const dash = core.indexOf("-");
  const numbers = (dash === -1 ? core : core.slice(0, dash)).split(".").map(Number);
  return { numbers, pre: dash === -1 ? null : core.slice(dash + 1).split(".") };
}

/**
 * Orders two remote install folder names (`<app version>-<12 hex of the bundle>`): negative when `a`
 * is older than `b`. Only the app version counts, so two builds of one version compare equal.
 */
export function compareInstallVersions(a: string, b: string): number {
  const left = splitInstallVersion(a);
  const right = splitInstallVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (Number.isNaN(diff)) return 0;
    if (diff !== 0) return diff;
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const bothNumeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    const diff = bothNumeric ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0;
    if (diff !== 0) return diff;
  }
  return 0;
}
