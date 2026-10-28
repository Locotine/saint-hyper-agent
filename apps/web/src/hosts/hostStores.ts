// FILE: hostStores.ts
// Purpose: One orchestration store per host (this computer plus each connected SSH host) and
//          the cross-host reads the sidebar needs. Stores keep raw server ids; only this module
//          pairs them with a host.
// Layer: Web host stores
// Exports: createHostStoreRegistry, hostStores, collectHostProjects, useAllHostProjects,
//          useRemoteHostIds

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useSyncExternalStore } from "react";

import { createHostStore, useStore, type HostStore } from "../store";
import type { Project } from "../types";
import type { HostShellStatus } from "./hostShellPump";

export interface HostProject {
  readonly hostId: HostId;
  readonly project: Project;
}

const EMPTY_HOST_PROJECTS: readonly HostProject[] = [];

export interface HostStreamStatus {
  readonly status: HostShellStatus;
  readonly message?: string;
}

/** A host with no stream (never connected, or gone) is stale, with whatever its store last held. */
const NO_STREAM: HostStreamStatus = { status: "stale" };

interface ProjectsSource {
  hostIds: () => HostId[];
  get: (hostId: HostId) => HostStore;
}

/** Every host's projects, local first; the same raw project id on two hosts is two rows. */
export function collectHostProjects(source: ProjectsSource): HostProject[] {
  return source.hostIds().flatMap((hostId) =>
    source
      .get(hostId)
      .getState()
      .projects.map((project) => ({ hostId, project })),
  );
}

export function createHostStoreRegistry(
  local: HostStore,
  create: (hostId: HostId) => HostStore = createHostStore,
) {
  const stores = new Map<HostId, HostStore>([[LOCAL_HOST_ID, local]]);
  const detach = new Map<HostId, () => void>();
  const listeners = new Set<() => void>();
  const streamStatus = new Map<HostId, HostStreamStatus>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const attach = (hostId: HostId, store: HostStore) => {
    detach.set(hostId, store.subscribe(notify));
  };
  attach(LOCAL_HOST_ID, local);

  let cachedRows: readonly HostProject[] = EMPTY_HOST_PROJECTS;
  let cachedKey: readonly unknown[] = [];

  const registry = {
    /** The host's store, created empty on first use. */
    get(hostId: HostId): HostStore {
      let store = stores.get(hostId);
      if (!store) {
        store = create(hostId);
        stores.set(hostId, store);
        attach(hostId, store);
        notify();
      }
      return store;
    },
    peek: (hostId: HostId): HostStore | undefined => stores.get(hostId),
    hostIds: (): HostId[] => [...stores.keys()],
    /** Drops a remote host's store (forget host). This computer's store is never removed. */
    remove(hostId: HostId): void {
      if (hostId === LOCAL_HOST_ID || !stores.delete(hostId)) return;
      streamStatus.delete(hostId);
      detach.get(hostId)?.();
      detach.delete(hostId);
      notify();
    },
    status: (hostId: HostId): HostStreamStatus => streamStatus.get(hostId) ?? NO_STREAM,
    setStatus(hostId: HostId, status: HostShellStatus, message?: string): void {
      const current = streamStatus.get(hostId);
      if (current?.status === status && current.message === message) return;
      streamStatus.set(hostId, message === undefined ? { status } : { status, message });
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Stable between calls until a host joins, leaves or replaces its `projects` array, so
     * it is safe as a `useSyncExternalStore` snapshot.
     */
    projectsSnapshot(): readonly HostProject[] {
      const key: unknown[] = [];
      for (const [hostId, store] of stores) key.push(hostId, store.getState().projects);
      if (
        key.length === cachedKey.length &&
        key.every((value, index) => value === cachedKey[index])
      ) {
        return cachedRows;
      }
      cachedKey = key;
      const rows = collectHostProjects(registry);
      cachedRows = rows.length === 0 ? EMPTY_HOST_PROJECTS : rows;
      return cachedRows;
    },
  };
  return registry;
}

export const hostStores = createHostStoreRegistry(useStore);

let remoteIdsKey = "";
let remoteIds: readonly HostId[] = [];

/** Hosts other than this computer that have a store, stable until one joins or leaves. */
function remoteHostIdsSnapshot(): readonly HostId[] {
  const ids = hostStores.hostIds().filter((hostId) => hostId !== LOCAL_HOST_ID);
  const key = ids.join("|");
  if (key !== remoteIdsKey) {
    remoteIdsKey = key;
    remoteIds = ids;
  }
  return remoteIds;
}

/** Connected (or remembered) hosts, for surfaces that run once per host. */
export function useRemoteHostIds(): readonly HostId[] {
  return useSyncExternalStore(hostStores.subscribe, remoteHostIdsSnapshot);
}

/** Projects of this computer and every connected host, for lists that mix them. */
export function useAllHostProjects(): readonly HostProject[] {
  return useSyncExternalStore(hostStores.subscribe, hostStores.projectsSnapshot);
}
