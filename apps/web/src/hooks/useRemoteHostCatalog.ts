// FILE: useRemoteHostCatalog.ts
// Purpose: Read-only mirror of one connected remote host's projects and threads.
// Layer: Hook (a separate WsTransport per host; the app's own backend connection is untouched)
// Exports: useRemoteHostCatalog, RemoteHostCatalog

import { ORCHESTRATION_WS_METHODS, type OrchestrationShellSnapshot } from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";
import { useEffect, useState, useSyncExternalStore } from "react";

import { hostStores, type HostStreamStatus } from "../hosts/hostStores";
import {
  buildRemoteCatalogFromState,
  buildRemoteCatalogProjects,
  type RemoteCatalogProject,
} from "../lib/remoteHostCatalog";
import { WsTransport } from "../wsTransport";

export const REMOTE_CATALOG_REFRESH_MS = 15_000;

export interface RemoteHostCatalog {
  readonly status: "loading" | "ready" | "error";
  readonly projects: readonly RemoteCatalogProject[];
  readonly message: string | null;
}

const LOADING: RemoteHostCatalog = { status: "loading", projects: [], message: null };

export interface RemoteHostIdentity {
  readonly hostKey: string | null;
  readonly epoch: number;
}

/**
 * Kill switch for the push-driven catalog: `localStorage["saint:multi-host-live-catalog"] = "off"`
 * restores the 15 s poll without a rebuild. Read once per page load.
 */
export const LIVE_CATALOG_ENABLED = (() => {
  try {
    return window.localStorage.getItem("saint:multi-host-live-catalog") !== "off";
  } catch {
    return true;
  }
})();

/**
 * A connected host's projects and threads. Hosts that carry a key read their store, which
 * follows the host's shell stream; otherwise (or with the kill switch) the snapshot is polled.
 */
export function useRemoteHostCatalog(
  host: string,
  localPort: number | null,
  identity?: RemoteHostIdentity,
): RemoteHostCatalog {
  const hostKey = LIVE_CATALOG_ENABLED ? (identity?.hostKey ?? null) : null;
  const live = hostKey !== null;
  const polled = usePolledRemoteHostCatalog(host, live ? null : localPort);
  const pushed = useLiveRemoteHostCatalog(hostKey);
  return live ? pushed : polled;
}

const catalogCache = new Map<
  HostId,
  {
    projects: unknown;
    summaries: unknown;
    hydrated: boolean;
    stream: HostStreamStatus;
    result: RemoteHostCatalog;
  }
>();

/** The host's catalog from its store, stable until something it shows changes. */
function readHostCatalog(hostId: HostId): RemoteHostCatalog {
  const state = hostStores.peek(hostId)?.getState();
  const stream = hostStores.status(hostId);
  const projects = state?.projects;
  const summaries = state?.sidebarThreadSummaryById;
  const hydrated = state?.threadsHydrated ?? false;
  const cached = catalogCache.get(hostId);
  if (
    cached &&
    cached.projects === projects &&
    cached.summaries === summaries &&
    cached.hydrated === hydrated &&
    cached.stream === stream
  ) {
    return cached.result;
  }
  const entries = state ? buildRemoteCatalogFromState(state) : [];
  let result: RemoteHostCatalog;
  if (!hydrated) {
    result =
      stream.status === "stale" && stream.message
        ? { status: "error", projects: entries, message: stream.message }
        : LOADING;
  } else if (stream.status === "stale") {
    result = {
      status: "error",
      projects: entries,
      message: stream.message ?? "The host's server is not reachable.",
    };
  } else {
    result = { status: "ready", projects: entries, message: null };
  }
  catalogCache.set(hostId, { projects, summaries, hydrated, stream, result });
  return result;
}

/** Reads the host's store; `useRemoteHostStoreSync` is what keeps that store current. */
function useLiveRemoteHostCatalog(hostKey: string | null): RemoteHostCatalog {
  const hostId = hostKey === null ? null : sshHostId(hostKey);
  return useSyncExternalStore(hostStores.subscribe, () =>
    hostId === null ? LOADING : readHostCatalog(hostId),
  );
}

/**
 * Polls the host's shell snapshot while it is connected. Each effect run is one
 * connection incarnation (host + tunnel port): its transport and every response
 * it produces are dropped as soon as the host reconnects or goes away, so a stale
 * answer can never overwrite a newer catalog.
 */
function usePolledRemoteHostCatalog(host: string, localPort: number | null): RemoteHostCatalog {
  const [catalog, setCatalog] = useState<RemoteHostCatalog>(LOADING);

  useEffect(() => {
    const bridge = window.desktopBridge?.remoteSsh;
    if (!bridge || localPort === null) return;
    let current = true;
    let transport: WsTransport | null = null;
    setCatalog(LOADING);

    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (!transport) {
          const url = await bridge.wsUrl(host);
          if (!current) return;
          if (!url) throw new Error("The host's server is not reachable.");
          transport = new WsTransport(url);
        }
        const snapshot = await transport.request<OrchestrationShellSnapshot>(
          ORCHESTRATION_WS_METHODS.getShellSnapshot,
        );
        if (!current) return;
        setCatalog({
          status: "ready",
          projects: buildRemoteCatalogProjects(snapshot),
          message: null,
        });
      } catch (error) {
        if (!current) return;
        const message = error instanceof Error ? error.message : String(error);
        setCatalog((previous) => ({ status: "error", projects: previous.projects, message }));
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), REMOTE_CATALOG_REFRESH_MS);
    return () => {
      current = false;
      window.clearInterval(timer);
      void transport?.dispose();
    };
  }, [host, localPort]);

  return catalog;
}
