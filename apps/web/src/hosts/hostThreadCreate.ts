// FILE: hostThreadCreate.ts
// Purpose: Starts an empty thread in a connected host's project, and adds a project on a host.
//          This computer's new threads go through composer drafts first; a host's thread is
//          created on the host right away and opened, and the first message names it as usual.
// Layer: Web host connections
// Exports: createHostThread, addHostProject

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
  const api = hostHandle(hostId).requireApi();
  const { projectId } = await createOrRecoverProjectFromPath({
    api,
    workspaceRoot,
    spaceId: null,
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
