// FILE: hostSearchThreads.ts
// Purpose: Connected hosts' threads as search palette rows. Rows carry the host-qualified route
//          id and name the host next to the project; only titles are searchable, since a host's
//          messages load only for the chats that were opened.
// Layer: Web host stores
// Exports: collectHostSearchThreads, useHostSearchThreads

import { LOCAL_HOST_ID, scopeThread, type HostId } from "@saint/shared/hostId";
import { useSyncExternalStore } from "react";

import type { SidebarSearchThread } from "../components/SidebarSearchPalette.logic";
import type { AppState } from "../store";
import { hostStores } from "./hostStores";

type SearchSource = Pick<AppState, "projects" | "sidebarThreadSummaryById">;

const NO_THREADS: readonly SidebarSearchThread[] = [];

export function collectHostSearchThreads(
  hosts: ReadonlyArray<{ hostId: HostId; host: string; state: SearchSource }>,
): SidebarSearchThread[] {
  return hosts.flatMap(({ hostId, host, state }) => {
    const projectNameById = new Map(state.projects.map((project) => [project.id, project.name]));
    return Object.values(state.sidebarThreadSummaryById).flatMap((thread) => {
      if (thread.archivedAt || thread.parentThreadId) return [];
      const projectName = `${projectNameById.get(thread.projectId) ?? "Unknown project"} · ${host}`;
      return [
        {
          id: scopeThread(hostId, thread.id),
          title: thread.title,
          projectId: thread.projectId,
          projectName,
          projectRemoteName: projectName,
          spaceName: "Global",
          provider: thread.modelSelection.provider,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          messages: [],
        },
      ];
    });
  });
}

let cachedKey: readonly unknown[] = [];
let cachedRows: readonly SidebarSearchThread[] = NO_THREADS;

/** Every connected host's threads, stable while no host's projects or summaries change. */
export function useHostSearchThreads(
  hostName: (hostId: HostId) => string,
): readonly SidebarSearchThread[] {
  return useSyncExternalStore(hostStores.subscribe, () => {
    const hosts = hostStores
      .hostIds()
      .filter((hostId) => hostId !== LOCAL_HOST_ID)
      .map((hostId) => ({
        hostId,
        host: hostName(hostId),
        state: hostStores.get(hostId).getState(),
      }));
    const key = hosts.flatMap(({ hostId, host, state }) => [
      hostId,
      host,
      state.projects,
      state.sidebarThreadSummaryById,
    ]);
    if (key.length !== cachedKey.length || key.some((value, index) => value !== cachedKey[index])) {
      cachedKey = key;
      const rows = collectHostSearchThreads(hosts);
      cachedRows = rows.length === 0 ? NO_THREADS : rows;
    }
    return cachedRows;
  });
}
