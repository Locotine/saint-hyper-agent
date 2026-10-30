// FILE: remoteHostCatalog.ts
// Purpose: Pure view model of one remote host's projects and threads for the sidebar.
// Layer: Sidebar support (read-only mirror of a host's shell snapshot)
// Exports: buildRemoteCatalogProjects, remoteHostSidebarStatus, REMOTE_CATALOG_THREAD_LIMIT

import type {
  DesktopRemoteSshHostState,
  DesktopRemoteSshState,
  OrchestrationShellSnapshot,
} from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";

import { groupNestedThreads } from "./nestedThreads";

import { isRemoteHostBusy, remoteHostRows } from "../components/settings/remoteHostsSettingsModel";
import type { AppState } from "../storeState";

/** Threads listed per project before the sidebar shows a count instead. */
export const REMOTE_CATALOG_THREAD_LIMIT = 8;

export type RemoteCatalogThreadState = "running" | "attention" | "idle";

export interface RemoteCatalogThread {
  readonly id: string;
  readonly title: string;
  readonly state: RemoteCatalogThreadState;
  readonly updatedAt: string;
  /** Its subagent sessions (and theirs), oldest first; they list under it, not on their own. */
  readonly children: readonly RemoteCatalogThread[];
}

export interface RemoteCatalogProject {
  readonly id: string;
  readonly title: string;
  /** Folder on the host, never on this computer. */
  readonly workspaceRoot: string;
  readonly isPinned: boolean;
  readonly threads: readonly RemoteCatalogThread[];
  /** Threads beyond `REMOTE_CATALOG_THREAD_LIMIT`. */
  readonly hiddenThreadCount: number;
}

/** The few fields a catalog row needs; a shell snapshot and a host store both supply them. */
interface CatalogProjectInput {
  readonly id: string;
  readonly title: string;
  readonly kind?: string | undefined;
  readonly workspaceRoot: string;
  readonly isPinned?: boolean | undefined;
}

interface CatalogThreadInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt?: string | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly parentThreadId?: string | null | undefined;
  readonly createdAt?: string | undefined;
  readonly session?: { readonly status?: string } | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
}

export function threadState(thread: CatalogThreadInput): RemoteCatalogThreadState {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  const status = thread.session?.status;
  return status === "running" || status === "starting" ? "running" : "idle";
}

function buildCatalog(
  allProjects: readonly CatalogProjectInput[],
  allThreads: readonly CatalogThreadInput[],
): RemoteCatalogProject[] {
  const live = allThreads.filter((thread) => !thread.archivedAt);
  const nestedByParent = groupNestedThreads(live);
  const toEntry = (thread: CatalogThreadInput): RemoteCatalogThread => ({
    id: thread.id,
    title: thread.title,
    state: threadState(thread),
    updatedAt: thread.updatedAt ?? "",
    children: (nestedByParent.get(thread.id) ?? []).map(toEntry),
  });
  const threadsByProject = new Map<string, RemoteCatalogThread[]>();
  for (const thread of live) {
    if (thread.parentThreadId) continue;
    const list = threadsByProject.get(thread.projectId);
    if (list) list.push(toEntry(thread));
    else threadsByProject.set(thread.projectId, [toEntry(thread)]);
  }
  return (
    allProjects
      .filter((project) => project.kind === "project")
      .map((project) => {
        const threads = (threadsByProject.get(project.id) ?? []).toSorted((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        return {
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          isPinned: project.isPinned === true,
          threads: threads.slice(0, REMOTE_CATALOG_THREAD_LIMIT),
          hiddenThreadCount: Math.max(0, threads.length - REMOTE_CATALOG_THREAD_LIMIT),
        };
      })
      // Pinned projects first, like this computer's list.
      .toSorted((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.title.localeCompare(b.title))
  );
}

/**
 * Standard projects of a host with their live (not archived, not sub-agent)
 * threads, newest first. Chats, studios and groups stay on the host's own UI.
 */
export function buildRemoteCatalogProjects(
  snapshot: OrchestrationShellSnapshot,
): RemoteCatalogProject[] {
  return buildCatalog(
    snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      kind: project.kind,
      workspaceRoot: project.workspaceRoot,
      isPinned: project.isPinned,
    })),
    snapshot.threads,
  );
}

/** The same catalog read from a host's store, which a shell stream keeps current. */
export function buildRemoteCatalogFromState(
  state: Pick<AppState, "projects" | "sidebarThreadSummaryById">,
): RemoteCatalogProject[] {
  return buildCatalog(
    state.projects.map((project) => ({
      id: project.id,
      title: project.name,
      kind: project.kind,
      workspaceRoot: project.cwd,
      isPinned: project.isPinned,
    })),
    Object.values(state.sidebarThreadSummaryById),
  );
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

/** Hosts that are connected right now, by their SSH name and host id. */
export function connectedRemoteHosts(
  state: DesktopRemoteSshState | null,
): ReadonlyArray<{ host: string; hostId: HostId }> {
  return (state ? remoteHostRows(state) : []).flatMap((row) =>
    row.state?.hostKey && remoteHostSidebarStatus(row.state) === "connected"
      ? [{ host: row.host, hostId: sshHostId(row.state.hostKey) }]
      : [],
  );
}
