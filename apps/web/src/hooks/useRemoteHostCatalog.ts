// FILE: useRemoteHostCatalog.ts
// Purpose: Read-only view of one remote host's projects and threads, from its host store.
// Layer: Hook
// Exports: useRemoteHostCatalog, RemoteHostCatalog

import { sshHostId, type HostId } from "@saint/shared/hostId";
import { useSyncExternalStore } from "react";

import { hostStores, type HostStreamStatus } from "../hosts/hostStores";
import { buildRemoteCatalogFromState, type RemoteCatalogProject } from "../lib/remoteHostCatalog";

export interface RemoteHostCatalog {
  readonly status: "loading" | "ready" | "error";
  readonly projects: readonly RemoteCatalogProject[];
  readonly message: string | null;
}

const LOADING: RemoteHostCatalog = { status: "loading", projects: [], message: null };

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

/** A host's projects and threads from its store, which `useRemoteHostStoreSync` keeps current. */
export function useRemoteHostCatalog(hostKey: string | null): RemoteHostCatalog {
  const hostId = hostKey === null ? null : sshHostId(hostKey);
  return useSyncExternalStore(hostStores.subscribe, () =>
    hostId === null ? LOADING : readHostCatalog(hostId),
  );
}
