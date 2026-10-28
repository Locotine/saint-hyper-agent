// FILE: devLoopbackHosts.ts
// Purpose: The desktop's remote SSH bridge, or in a development browser build a stand-in where
//          another Saint server on this machine plays a connected host. Lets multi-host run end
//          to end without SSH or the desktop app.
// Layer: Web platform bridge
// Exports: remoteSshBridge
//
// Enable (dev builds only), then reload:
//   localStorage["saint:dev-loopback-hosts"] = '[{"host":"loopback","url":"ws://127.0.0.1:3901"}]'
// Settings → Remote hosts can then disconnect and reconnect the stand-in host.

import type {
  DesktopBridge,
  DesktopRemoteSshHostState,
  DesktopRemoteSshState,
} from "@saint/contracts";

type RemoteSshBridge = NonNullable<DesktopBridge["remoteSsh"]>;

const LOOPBACK_HOSTS_KEY = "saint:dev-loopback-hosts";

/** The bridge this window has: the desktop's, a dev stand-in, or none (Stable without it, browsers). */
export function remoteSshBridge(): RemoteSshBridge | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.desktopBridge?.remoteSsh) return window.desktopBridge.remoteSsh;
  return import.meta.env.DEV ? loopbackBridge() : undefined;
}

let loopback: RemoteSshBridge | null | undefined;

/** Stable 8-hex key per alias (FNV-1a), the shape a saved host's key has. */
function loopbackHostKey(host: string): string {
  let hash = 0x811c9dc5;
  for (const char of host) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function loopbackBridge(): RemoteSshBridge | undefined {
  if (loopback !== undefined) return loopback ?? undefined;
  let entries: Array<{ host: string; url: string }> = [];
  try {
    entries = JSON.parse(window.localStorage.getItem(LOOPBACK_HOSTS_KEY) ?? "[]");
  } catch {
    entries = [];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    loopback = null;
    return undefined;
  }

  const urls = new Map(entries.map((entry) => [entry.host, entry.url]));
  const listeners = new Set<(state: DesktopRemoteSshState) => void>();
  const hostState = (
    host: string,
    connected: boolean,
    epoch: number,
  ): DesktopRemoteSshHostState => ({
    host,
    hostKey: loopbackHostKey(host),
    epoch,
    remoteRoot: "~/.saint-loopback",
    phase: connected ? "connected" : "idle",
    message: null,
    localPort: connected ? Number(new URL(urls.get(host) ?? "ws://x:0").port) || null : null,
  });
  let hosts = entries.map((entry) => hostState(entry.host, true, 1));
  const snapshot = (): DesktopRemoteSshState => ({
    configHosts: [...urls.keys()],
    savedHosts: entries.map((entry) => ({
      host: entry.host,
      hostKey: loopbackHostKey(entry.host),
    })),
    hosts,
    defaultRemoteRoot: "~/.saint-loopback",
  });
  const setConnected = (host: string, connected: boolean) => {
    hosts = hosts.map((state) =>
      state.host === host ? hostState(host, connected, state.epoch + (connected ? 1 : 0)) : state,
    );
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return hosts.find((state) => state.host === host) ?? hostState(host, connected, 1);
  };

  loopback = {
    getState: async () => snapshot(),
    connect: async (saved) => setConnected(saved.host, true),
    disconnect: async (host) => {
      setConnected(host, false);
    },
    stopServer: async (saved) => {
      setConnected(saved.host, false);
    },
    forget: async () => undefined,
    wsUrl: async (host) =>
      hosts.some((state) => state.host === host && state.phase === "connected")
        ? (urls.get(host) ?? null)
        : null,
    onState: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return loopback;
}
