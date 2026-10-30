// FILE: hostThreadCreate.ts
// Purpose: Starts an empty thread in a connected host's project, and adds a project on a host.
//          This computer's new threads go through composer drafts first; a host's thread is
//          created on the host right away and opened, and the first message names it as usual.
// Layer: Web host connections
// Exports: createHostThread, addHostProject, addHostProjectAtPath, removeHostProject,
//          renameHostProject, setHostProjectPinned, deleteHostThread, updateHostThreadMeta

import type { ProjectId, ThreadId } from "@saint/contracts";
import { GENERIC_CHAT_THREAD_TITLE } from "@saint/shared/chatThreads";
import type { HostId } from "@saint/shared/hostId";

import { deleteProjectFromClient } from "../lib/projectDelete";
import { createOrRecoverProjectFromPath } from "../lib/projectCreation";
import { pickRemoteFolder } from "../remoteFolderPickerStore";
import { getThreadFromState } from "../threadDerivation";
import { newCommandId, newThreadId } from "../lib/utils";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { hostHandle } from "./hostScope";

export async function createHostThread(hostId: HostId, projectId: ProjectId): Promise<ThreadId> {
  const host = hostHandle(hostId);
  const api = host.requireApi();
  const state = host.store.getState();
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("This project is no longer on the host.");
  // The project's default, else the model its latest thread used.
  const latestThread = (state.threadIds ?? [])
    .map((id) => getThreadFromState(state, id))
    .filter((thread) => thread?.projectId === projectId)
    .toSorted((a, b) => (b?.updatedAt ?? "").localeCompare(a?.updatedAt ?? ""))[0];
  const modelSelection = project.defaultModelSelection ?? latestThread?.modelSelection;
  if (!modelSelection) throw new Error("Pick a default model for this project on the host first.");

  const threadId = newThreadId();
  await api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId,
    projectId,
    title: GENERIC_CHAT_THREAD_TITLE,
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

/**
 * Picks a folder on the host and adds it there as a project; null when the pick is cancelled.
 * The project goes to the host's Void: this computer's Spaces mean nothing on the host, and a
 * host's projects show in every Space here.
 */
export async function addHostProject(hostId: HostId, hostName: string): Promise<ProjectId | null> {
  const workspaceRoot = await pickRemoteFolder(hostId, hostName);
  if (!workspaceRoot) return null;
  return addHostProjectAtPath(hostId, workspaceRoot);
}

/** Adds a folder on the host as a project; `createIfMissing` makes a typed path that is not there. */
export async function addHostProjectAtPath(
  hostId: HostId,
  workspaceRoot: string,
  options: { readonly createIfMissing?: boolean } = {},
): Promise<ProjectId> {
  const api = hostHandle(hostId).requireApi();
  const { projectId } = await createOrRecoverProjectFromPath({
    api,
    workspaceRoot,
    spaceId: null,
    ...(options.createIfMissing ? { createIfMissing: true } : {}),
    loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
  });
  return projectId;
}

/**
 * Removes a project from a host's Saint, like removing it here: its chats go, its folder on the
 * host stays untouched.
 */
export async function removeHostProject(hostId: HostId, projectId: ProjectId): Promise<void> {
  const api = hostHandle(hostId).requireApi();
  const snapshot = await api.orchestration.getShellSnapshot();
  for (const thread of snapshot.threads.filter((entry) => entry.projectId === projectId)) {
    await api.orchestration.dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId: thread.id,
    });
  }
  await deleteProjectFromClient({
    api: api.orchestration,
    projectId,
    removeDeletedProjectFromClientState: () => undefined,
  });
}

/** Deletes one thread on a host; the host's shell stream drops it from its sidebar. */
export async function deleteHostThread(hostId: HostId, threadId: ThreadId): Promise<void> {
  await hostHandle(hostId).requireApi().orchestration.dispatchCommand({
    type: "thread.delete",
    commandId: newCommandId(),
    threadId,
  });
}

/** Renames a project on its host: the host's own title, not a label kept on this computer. */
export async function renameHostProject(
  hostId: HostId,
  projectId: ProjectId,
  title: string,
): Promise<void> {
  await hostHandle(hostId).requireApi().orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    title,
  });
}

/** Pins or unpins a project on its host; the host's shell stream carries the flag back. */
export async function setHostProjectPinned(
  hostId: HostId,
  projectId: ProjectId,
  isPinned: boolean,
): Promise<void> {
  await hostHandle(hostId).requireApi().orchestration.dispatchCommand({
    type: "project.meta.update",
    commandId: newCommandId(),
    projectId,
    isPinned,
  });
}

/** Renames or pins a thread on its host; the host's shell stream carries the change back. */
export async function updateHostThreadMeta(
  hostId: HostId,
  threadId: ThreadId,
  patch: { readonly title: string } | { readonly isPinned: boolean },
): Promise<void> {
  await hostHandle(hostId)
    .requireApi()
    .orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      ...patch,
    });
}
