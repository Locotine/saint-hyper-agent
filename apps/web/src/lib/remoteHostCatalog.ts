// FILE: remoteHostCatalog.ts
// Purpose: Pure view model of one remote host's projects and threads for the sidebar.
// Layer: Sidebar support (read-only mirror of a host's shell snapshot)
// Exports: buildRemoteCatalogProjects, remoteHostSidebarStatus, REMOTE_CATALOG_THREAD_LIMIT

import type { DesktopRemoteSshHostState, OrchestrationShellSnapshot } from "@saint/contracts";

import { isRemoteHostBusy } from "../components/settings/remoteHostsSettingsModel";

/** Threads listed per project before the sidebar shows a count instead. */
export const REMOTE_CATALOG_THREAD_LIMIT = 8;

export type RemoteCatalogThreadState = "running" | "attention" | "idle";

export interface RemoteCatalogThread {
  readonly id: string;
  readonly title: string;
  readonly state: RemoteCatalogThreadState;
  readonly updatedAt: string;
}

export interface RemoteCatalogProject {
  readonly id: string;
  readonly title: string;
  /** Folder on the host, never on this computer. */
  readonly workspaceRoot: string;
  readonly threads: readonly RemoteCatalogThread[];
  /** Threads beyond `REMOTE_CATALOG_THREAD_LIMIT`. */
  readonly hiddenThreadCount: number;
}

type ShellThread = OrchestrationShellSnapshot["threads"][number];

function threadState(thread: ShellThread): RemoteCatalogThreadState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  const status = thread.session?.status;
  return status === "running" || status === "starting" ? "running" : "idle";
}

/**
 * Standard projects of a host with their live (not archived, not sub-agent)
 * threads, newest first. Chats, studios and groups stay on the host's own UI.
 */
export function buildRemoteCatalogProjects(
  snapshot: OrchestrationShellSnapshot,
): RemoteCatalogProject[] {
  const threadsByProject = new Map<string, RemoteCatalogThread[]>();
  for (const thread of snapshot.threads) {
    if (thread.archivedAt || thread.parentThreadId) continue;
    const entry: RemoteCatalogThread = {
      id: thread.id,
      title: thread.title,
      state: threadState(thread),
      updatedAt: thread.updatedAt,
    };
    const list = threadsByProject.get(thread.projectId);
    if (list) list.push(entry);
    else threadsByProject.set(thread.projectId, [entry]);
  }
  return snapshot.projects
    .filter((project) => project.kind === "project")
    .map((project) => {
      const threads = (threadsByProject.get(project.id) ?? []).toSorted((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );
      return {
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        threads: threads.slice(0, REMOTE_CATALOG_THREAD_LIMIT),
        hiddenThreadCount: Math.max(0, threads.length - REMOTE_CATALOG_THREAD_LIMIT),
      };
    })
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

export type RemoteHostSidebarStatus = "connected" | "connecting" | "error" | "offline";

/** Dot state for a host row: busy phases read as connecting, `idle` as offline. */
export function remoteHostSidebarStatus(
  state: DesktopRemoteSshHostState | null,
): RemoteHostSidebarStatus {
  if (!state || state.phase === "idle") return "offline";
  if (state.phase === "connected") return "connected";
  if (state.phase === "error") return "error";
  return isRemoteHostBusy(state) ? "connecting" : "offline";
}
