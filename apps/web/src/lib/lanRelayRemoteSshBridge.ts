// FILE: lanRelayRemoteSshBridge.ts
// Purpose: Browser/mobile Remote SSH bridge backed by the desktop LAN relay's authenticated
//          `/api/remote-ssh/*` HTTP + SSE + reverse-proxy endpoints, giving paired phones full
//          desktop parity for SSH remote hosts, projects, chats, files, and forwarded dev servers.
// Layer: Web platform bridge
// Exports: lanRelayRemoteSshBridge, isLanRelayRemoteSshAvailable,
//          subscribeLanRelayRemoteSshAvailability, probeLanRelayRemoteSshAvailability

import type {
  DesktopBridge,
  DesktopRemoteSshHostState,
  DesktopRemoteSshSavedHost,
  DesktopRemoteSshState,
  DesktopRemoteSshTestResult,
  DesktopRemoteSshUpdateHostInput,
  DesktopWorkspaceDownloadItem,
  DesktopWorkspaceDownloadResult,
} from "@saint/contracts";
import { WORKSPACE_DOWNLOAD_ROUTE_PATH } from "@saint/shared/binaryTransfer";

import { downloadUrlAsBlob } from "./browserDownload";

type RemoteSshBridge = NonNullable<DesktopBridge["remoteSsh"]>;

const LAN_RELAY_COOKIE_NAME = "saint_lan_relay";
const LAN_RELAY_HEADER = "x-saint-lan-relay";

let probedAvailability: boolean | null = null;
let probeInFlight: Promise<boolean> | null = null;
const availabilityListeners = new Set<() => void>();

function notifyAvailabilityListeners(): void {
  for (const listener of availabilityListeners) {
    listener();
  }
}

export function hasLanRelayRemoteSshCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((pair) => pair.trim() === `${LAN_RELAY_COOKIE_NAME}=1`);
}

export function isLanRelayRemoteSshAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (window.desktopBridge?.remoteSsh) return false;
  return probedAvailability === true || hasLanRelayRemoteSshCookie();
}

export function subscribeLanRelayRemoteSshAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

/**
 * Fallback probe for sessions paired before the `saint_lan_relay=1` hint cookie existed.
 * Checks the explicit `X-Saint-Lan-Relay: 1` response header so an SPA HTML fallback cannot
 * trigger a false positive.
 */
export function probeLanRelayRemoteSshAvailability(): Promise<boolean> {
  if (typeof window === "undefined" || window.desktopBridge?.remoteSsh) {
    return Promise.resolve(false);
  }
  if (isLanRelayRemoteSshAvailable()) {
    return Promise.resolve(true);
  }
  if (probedAvailability === false) {
    return Promise.resolve(false);
  }
  if (probeInFlight) {
    return probeInFlight;
  }
  probeInFlight = fetch("/api/remote-ssh/state", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then((response) => {
      const available = response.ok && response.headers.get(LAN_RELAY_HEADER) === "1";
      probedAvailability = available;
      if (available) {
        notifyAvailabilityListeners();
      }
      return available;
    })
    .catch(() => {
      probedAvailability = false;
      return false;
    })
    .finally(() => {
      probeInFlight = null;
    });
  return probeInFlight;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const errorMessage =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Remote SSH request failed (${response.status}).`;
    throw new Error(errorMessage);
  }
  return parsed as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<T>(response);
}

function toRelayWsUrl(proxyPath: string): string {
  const httpUrl = new URL(proxyPath, window.location.origin);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

const SSE_RECONNECT_BASE_DELAY_MS = 1_000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;

let cachedBridge: RemoteSshBridge | null = null;
let activeBridgeCleanup: (() => void) | null = null;

function createLanRelayRemoteSshBridge(): RemoteSshBridge {
  const stateListeners = new Set<(state: DesktopRemoteSshState) => void>();
  let eventSource: EventSource | null = null;
  let lastEventData: string | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let needsResyncOnOpen = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const closeActiveEventSource = () => {
    if (!eventSource) return;
    eventSource.close();
    eventSource = null;
    lastEventData = null;
  };

  const emitState = (next: DesktopRemoteSshState, serialized?: string) => {
    const raw = serialized ?? JSON.stringify(next);
    if (raw === lastEventData) return;
    lastEventData = raw;
    for (const listener of [...stateListeners]) {
      listener(next);
    }
  };

  const resyncState = async () => {
    if (stateListeners.size === 0) return;
    try {
      const response = await fetch("/api/remote-ssh/state", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const next = await parseJsonOrThrow<DesktopRemoteSshState>(response);
      if (stateListeners.size > 0) {
        emitState(next);
      }
    } catch {
      // Transient fetch failures recover on the next SSE frame or reconnect.
    }
  };

  const scheduleReconnect = () => {
    if (stateListeners.size === 0 || reconnectTimer !== null || eventSource !== null) return;
    const delayMs = Math.min(
      SSE_RECONNECT_MAX_DELAY_MS,
      SSE_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempt, 5),
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      ensureEventSource();
    }, delayMs);
  };

  const ensureEventSource = () => {
    if (eventSource || typeof EventSource === "undefined" || stateListeners.size === 0) return;
    clearReconnectTimer();
    const source = new EventSource("/api/remote-ssh/events", { withCredentials: true });
    source.onopen = () => {
      if (eventSource !== source) return;
      reconnectAttempt = 0;
      if (needsResyncOnOpen) {
        needsResyncOnOpen = false;
        void resyncState();
      }
    };
    source.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length === 0) return;
      if (event.data === lastEventData) return;
      try {
        const next = JSON.parse(event.data) as DesktopRemoteSshState;
        emitState(next, event.data);
      } catch {
        // Ignore malformed SSE frames.
      }
    };
    source.onerror = () => {
      if (eventSource !== source) return;
      needsResyncOnOpen = true;
      const closedState = typeof EventSource.CLOSED === "number" ? EventSource.CLOSED : 2;
      if (source.readyState === closedState) {
        closeActiveEventSource();
        scheduleReconnect();
      }
    };
    eventSource = source;
  };

  const closeEventSourceIfIdle = () => {
    if (stateListeners.size === 0) {
      clearReconnectTimer();
      closeActiveEventSource();
      reconnectAttempt = 0;
      needsResyncOnOpen = false;
    }
  };

  activeBridgeCleanup = () => {
    stateListeners.clear();
    clearReconnectTimer();
    closeActiveEventSource();
    reconnectAttempt = 0;
    needsResyncOnOpen = false;
  };

  return {
    getState: async () => {
      const response = await fetch("/api/remote-ssh/state", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return parseJsonOrThrow<DesktopRemoteSshState>(response);
    },
    connect: (host: DesktopRemoteSshSavedHost) =>
      postJson<DesktopRemoteSshHostState>("/api/remote-ssh/connect", host),
    disconnect: async (host: string) => {
      await postJson<Record<string, never>>("/api/remote-ssh/disconnect", { host });
    },
    stopServer: async (host: DesktopRemoteSshSavedHost) => {
      await postJson<Record<string, never>>("/api/remote-ssh/stop-server", host);
    },
    forget: async (host: string) => {
      await postJson<Record<string, never>>("/api/remote-ssh/forget", { host });
    },
    testHost: (host: DesktopRemoteSshSavedHost) =>
      postJson<DesktopRemoteSshTestResult>("/api/remote-ssh/test-host", host),
    updateHost: (input: DesktopRemoteSshUpdateHostInput) =>
      postJson<DesktopRemoteSshState>("/api/remote-ssh/update-host", input),
    wsUrl: async (host: string) => {
      const result = await postJson<{ proxyPath: string | null }>("/api/remote-ssh/ws-url", {
        host,
      });
      return result.proxyPath ? toRelayWsUrl(result.proxyPath) : null;
    },
    forwardPort: async (input: { readonly host: string; readonly remotePort: number }) => {
      const result = await postJson<{ url?: string; proxyPath?: string }>(
        "/api/remote-ssh/forward-port",
        input,
      );
      if (typeof result.url === "string" && result.url.length > 0) {
        return new URL(result.url).toString();
      }
      if (typeof result.proxyPath === "string" && result.proxyPath.length > 0) {
        return new URL(result.proxyPath, window.location.origin).toString();
      }
      throw new Error("Forwarded port URL was not returned by LAN relay.");
    },
    downloadFiles: async (input: {
      readonly host: string;
      readonly items: readonly DesktopWorkspaceDownloadItem[];
    }): Promise<DesktopWorkspaceDownloadResult> => {
      const { proxyPath } = await postJson<{ proxyPath: string | null }>("/api/remote-ssh/ws-url", {
        host: input.host,
      });
      if (!proxyPath) {
        throw new Error(`${input.host} is not connected.`);
      }
      const prefix = proxyPath.replace(/\/+$/, "");
      const saved: Array<{ path: string; fileName: string }> = [];
      const failures: Array<{ fileName: string; message: string }> = [];
      for (const item of input.items) {
        const params = new URLSearchParams({
          cwd: item.cwd,
          path: item.path || ".",
        });
        const url = new URL(
          `${prefix}${WORKSPACE_DOWNLOAD_ROUTE_PATH}?${params.toString()}`,
          window.location.origin,
        ).toString();
        try {
          await downloadUrlAsBlob({ url, filename: item.fileName });
          saved.push({ path: item.fileName, fileName: item.fileName });
        } catch (error) {
          failures.push({
            fileName: item.fileName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { canceled: false, saved, failures };
    },
    onState: (listener) => {
      stateListeners.add(listener);
      ensureEventSource();
      return () => {
        stateListeners.delete(listener);
        closeEventSourceIfIdle();
      };
    },
  };
}

export function lanRelayRemoteSshBridge(): RemoteSshBridge | undefined {
  if (!isLanRelayRemoteSshAvailable()) return undefined;
  cachedBridge ??= createLanRelayRemoteSshBridge();
  return cachedBridge;
}

/** @internal Test helper to reset probe/bridge singletons between Vitest cases. */
export function resetLanRelayRemoteSshBridgeForTests(): void {
  activeBridgeCleanup?.();
  activeBridgeCleanup = null;
  probedAvailability = null;
  probeInFlight = null;
  cachedBridge = null;
  availabilityListeners.clear();
}
