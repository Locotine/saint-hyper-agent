// FILE: useRemoteHostCatalog.ts
// Purpose: Read-only mirror of one connected remote host's projects and threads.
// Layer: Hook (a separate WsTransport per host; the app's own backend connection is untouched)
// Exports: useRemoteHostCatalog, RemoteHostCatalog

import { ORCHESTRATION_WS_METHODS, type OrchestrationShellSnapshot } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { useEffect, useState } from "react";

import { hostConnections } from "../hosts/hostConnectionRegistry";
import { watchShellCatalog } from "../hosts/shellCatalogWatcher";
import { buildRemoteCatalogProjects, type RemoteCatalogProject } from "../lib/remoteHostCatalog";
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
const LIVE_CATALOG_ENABLED = (() => {
  try {
    return window.localStorage.getItem("saint:multi-host-live-catalog") !== "off";
  } catch {
    return true;
  }
})();

/**
 * A connected host's projects and threads. Hosts that carry a key follow the host's shell
 * stream through the shared per-host connection; otherwise (or with the kill switch) the
 * snapshot is polled.
 */
export function useRemoteHostCatalog(
  host: string,
  localPort: number | null,
  identity?: RemoteHostIdentity,
): RemoteHostCatalog {
  const hostKey = LIVE_CATALOG_ENABLED ? (identity?.hostKey ?? null) : null;
  const live = hostKey !== null;
  const polled = usePolledRemoteHostCatalog(host, live ? null : localPort);
  const pushed = useLiveRemoteHostCatalog(
    host,
    live ? localPort : null,
    hostKey,
    identity?.epoch ?? 0,
  );
  return live ? pushed : polled;
}

function useLiveRemoteHostCatalog(
  host: string,
  localPort: number | null,
  hostKey: string | null,
  epoch: number,
): RemoteHostCatalog {
  const [catalog, setCatalog] = useState<RemoteHostCatalog>(LOADING);

  // A new epoch is a new token: its connection and every answer from the old one are dropped.
  useEffect(() => {
    const bridge = window.desktopBridge?.remoteSsh;
    if (!bridge || localPort === null || hostKey === null) return;
    let current = true;
    let stop: (() => void) | null = null;
    let release: (() => void) | null = null;
    setCatalog(LOADING);

    void (async () => {
      try {
        const url = await bridge.wsUrl(host);
        if (!current) return;
        if (!url) throw new Error("The host's server is not reachable.");
        const lease = hostConnections.acquire(sshHostId(hostKey), epoch, url);
        release = lease.release;
        stop = watchShellCatalog(lease.transport, {
          snapshot: (snapshot) =>
            setCatalog({
              status: "ready",
              projects: buildRemoteCatalogProjects(snapshot),
              message: null,
            }),
          error: (message) =>
            setCatalog((previous) => ({ status: "error", projects: previous.projects, message })),
        });
      } catch (error) {
        if (!current) return;
        const message = error instanceof Error ? error.message : String(error);
        setCatalog((previous) => ({ status: "error", projects: previous.projects, message }));
      }
    })();

    return () => {
      current = false;
      stop?.();
      release?.();
    };
  }, [host, localPort, hostKey, epoch]);

  return catalog;
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
