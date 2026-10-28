// FILE: hostThreadCreate.ts
// Purpose: Starts an empty thread in a connected host's project. This computer's new threads go
//          through composer drafts first; a host's thread is created on the host right away and
//          opened, and the first message names it as usual.
// Layer: Web host connections
// Exports: createHostThread

import type { ProjectId, ThreadId } from "@saint/contracts";
import { GENERIC_CHAT_THREAD_TITLE } from "@saint/shared/chatThreads";
import type { HostId } from "@saint/shared/hostId";

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
