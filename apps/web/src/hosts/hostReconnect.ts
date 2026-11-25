// FILE: hostReconnect.ts
// Purpose: Reconnecting a remote host from the web side: the action itself, shared by the sidebar
//          button and the automatic retry, and the pure schedule that decides when to retry.
// Layer: Web host connections
// Exports: reconnectRemoteHost, stepAutoReconnect, AutoReconnectEntry

import type { DesktopRemoteSshHostState } from "@saint/contracts";

import type { HostShellStatus } from "./hostShellPump";
import { remoteSshBridge } from "../lib/devLoopbackHosts";

/**
 * Re-establishes a host's SSH tunnel. Prefers the desktop's non-destructive `reconnect` path so
 * `auto_connect` is preserved and the UI/store does not flash `idle`; falls back to disconnect +
 * connect only on older bridges that lack `reconnect`.
 */
export async function reconnectRemoteHost(input: {
  host: string;
  hostKey: string;
  remoteRoot: string | null;
  hostState: DesktopRemoteSshHostState | null;
}): Promise<void> {
  const bridge = remoteSshBridge();
  if (!bridge) return;
  const target = {
    host: input.host,
    remoteRoot: input.remoteRoot,
    hostKey: input.hostKey,
  };
  if (bridge.reconnect) {
    await bridge.reconnect(target);
    return;
  }
  if (input.hostState?.phase === "connected") await bridge.disconnect(input.host);
  await bridge.connect(target);
}

/** Wait before the first automatic try on a stream that went quiet while the tunnel looks fine. */
const STALE_STREAM_GRACE_MS = 20_000;
/** Wait before retrying a stream that stays stuck in `connecting` after a tunnel opens. */
const CONNECTING_STREAM_GRACE_MS = 30_000;
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
 * `connected` while the host's stream is stale (or stuck in `connecting` past its grace window).
 * Only a confirmed `live` stream resets backoff — `connecting` never clears retry attempts.
 * A user's disconnect (`idle`) and the desktop's own retries (busy phases) are left alone.
 */
export function stepAutoReconnect(
  entry: AutoReconnectEntry,
  input: {
    now: number;
    phase: DesktopRemoteSshHostState["phase"];
    streamStatus: HostShellStatus;
    autoReconnectSuppressed?: boolean;
  },
): { entry: AutoReconnectEntry; reconnect: boolean } {
  const { now, phase, streamStatus, autoReconnectSuppressed } = input;
  if (phase === "connected" && streamStatus === "live") {
    return {
      entry: { everConnected: true, brokenSince: null, attempts: 0, nextAt: 0 },
      reconnect: false,
    };
  }
  if (phase === "idle" || phase === "stopping" || autoReconnectSuppressed === true) {
    return { entry: INITIAL_AUTO_RECONNECT_ENTRY, reconnect: false };
  }
  const stale = phase === "connected" && streamStatus === "stale";
  const connectingStuck = phase === "connected" && streamStatus === "connecting";
  const gaveUp = phase === "error" && entry.everConnected;
  if (!stale && !connectingStuck && !gaveUp) {
    return { entry: { ...entry, brokenSince: null }, reconnect: false };
  }
  const brokenSince = entry.brokenSince ?? now;
  const graceMs = stale ? STALE_STREAM_GRACE_MS : connectingStuck ? CONNECTING_STREAM_GRACE_MS : 0;
  const nextAt = entry.brokenSince === null ? now + graceMs : entry.nextAt;
  if (now < nextAt) {
    return {
      entry: {
        ...entry,
        everConnected: entry.everConnected || stale,
        brokenSince,
        nextAt,
      },
      reconnect: false,
    };
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
