// FILE: useRemoteHostCatalog.ts
// Purpose: Read-only mirror of one connected remote host's projects and threads.
// Layer: Hook (a separate WsTransport per host; the app's own backend connection is untouched)
// Exports: useRemoteHostCatalog, RemoteHostCatalog

import { ORCHESTRATION_WS_METHODS, type OrchestrationShellSnapshot } from "@saint/contracts";
import { useEffect, useState } from "react";

import { buildRemoteCatalogProjects, type RemoteCatalogProject } from "../lib/remoteHostCatalog";
import { WsTransport } from "../wsTransport";

export const REMOTE_CATALOG_REFRESH_MS = 15_000;

export interface RemoteHostCatalog {
  readonly status: "loading" | "ready" | "error";
  readonly projects: readonly RemoteCatalogProject[];
  readonly message: string | null;
}

const LOADING: RemoteHostCatalog = { status: "loading", projects: [], message: null };

/**
 * Polls the host's shell snapshot while it is connected. Each effect run is one
 * connection incarnation (host + tunnel port): its transport and every response
 * it produces are dropped as soon as the host reconnects or goes away, so a stale
 * answer can never overwrite a newer catalog.
 */
export function useRemoteHostCatalog(host: string, localPort: number | null): RemoteHostCatalog {
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
