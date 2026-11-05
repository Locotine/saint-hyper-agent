// FILE: hostReconnect.ts
// Purpose: Reconnecting a remote host from the web side: the action itself, shared by the sidebar
//          button and the automatic retry, and the pure schedule that decides when to retry.
// Layer: Web host connections
// Exports: reconnectRemoteHost, stepAutoReconnect, AutoReconnectEntry

import type { DesktopRemoteSshHostState } from "@saint/contracts";

import { remoteSshBridge } from "../lib/devLoopbackHosts";

/**
 * Closes a tunnel the desktop still reports as connected (a half-dead one would pass connect's
 * health check), then connects again.
 */
export async function reconnectRemoteHost(input: {
  host: string;
  hostKey: string;
  remoteRoot: string | null;
  hostState: DesktopRemoteSshHostState | null;
}): Promise<void> {
  const bridge = remoteSshBridge();
  if (!bridge) return;
  if (input.hostState?.phase === "connected") await bridge.disconnect(input.host);
  await bridge.connect({
    host: input.host,
    remoteRoot: input.remoteRoot,
    hostKey: input.hostKey,
  });
}

/** Wait before the first automatic try on a stream that went quiet while the tunnel looks fine. */
const STALE_STREAM_GRACE_MS = 20_000;
/** Pause between automatic tries; the last value repeats. */
const AUTO_RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

export interface AutoReconnectEntry {
  /** Only a host that worked in this session is retried; a failed first connect is the user's. */
  readonly everConnected: boolean;
  readonly brokenSince: number | null;
  readonly attempts: number;
  readonly nextAt: number;
}

export const INITIAL_AUTO_RECONNECT_ENTRY: AutoReconnectEntry = {
  everConnected: false,
  brokenSince: null,
  attempts: 0,
  nextAt: 0,
};

/**
 * One tick for one host. Broken means the desktop gave up on the tunnel (`error`), or says
 * `connected` while the host's stream is stale. A user's disconnect (`idle`) and the desktop's own
 * retries (busy phases) are left alone.
 */
export function stepAutoReconnect(
  entry: AutoReconnectEntry,
  input: { now: number; phase: DesktopRemoteSshHostState["phase"]; streamStale: boolean },
): { entry: AutoReconnectEntry; reconnect: boolean } {
  const { now, phase, streamStale } = input;
  if (phase === "connected" && !streamStale) {
    return {
      entry: { everConnected: true, brokenSince: null, attempts: 0, nextAt: 0 },
      reconnect: false,
    };
  }
  const stale = phase === "connected" && streamStale;
  const gaveUp = phase === "error" && entry.everConnected;
  if (!stale && !gaveUp) {
    return { entry: { ...entry, brokenSince: null }, reconnect: false };
  }
  const brokenSince = entry.brokenSince ?? now;
  const nextAt =
    entry.brokenSince === null ? now + (stale ? STALE_STREAM_GRACE_MS : 0) : entry.nextAt;
  if (now < nextAt) {
    return { entry: { ...entry, everConnected: true, brokenSince, nextAt }, reconnect: false };
  }
  const delay =
    AUTO_RECONNECT_DELAYS_MS[Math.min(entry.attempts, AUTO_RECONNECT_DELAYS_MS.length - 1)] ??
    AUTO_RECONNECT_DELAYS_MS[0]!;
  return {
    entry: {
      everConnected: true,
      brokenSince,
      attempts: entry.attempts + 1,
      nextAt: now + delay,
    },
    reconnect: true,
  };
}
