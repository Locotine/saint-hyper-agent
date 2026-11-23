// FILE: hostThreadCreate.ts
// Purpose: Starts an empty thread in a connected host's project, and adds a project on a host.
//          This computer's new threads go through composer drafts first; a host's thread is
//          created on the host right away and opened, and the first message names it as usual.
// Layer: Web host connections
// Exports: createHostThread, addHostProject, addHostProjectAtPath, removeHostProject,
//          renameHostProject, setHostProjectPinned, deleteHostThread, updateHostThreadMeta

import type { ModelSelection, NativeApi, ProjectId, ThreadId } from "@saint/contracts";
import { GENERIC_CHAT_THREAD_TITLE } from "@saint/shared/chatThreads";
import type { HostId } from "@saint/shared/hostId";
import { getDefaultModel } from "@saint/shared/model";

import { readStoredAppSettings } from "../appSettings";
import { resolveDefaultModelSelection } from "../composerDraftModels";
import {
  hasProbedEnabledProviderStatuses,
  isProviderUsable,
  resolveAvailableProviderPreference,
} from "../lib/providerAvailability";
import { awaitInFlightRemoteHostProviderRefresh } from "../lib/serverReactQuery";
import { buildModelSelection } from "../providerModelOptions";

import { deleteProjectFromClient } from "../lib/projectDelete";
import { createOrRecoverProjectFromPath } from "../lib/projectCreation";
import { pickRemoteFolder } from "../remoteFolderPickerStore";
import { getThreadFromState } from "../threadDerivation";
import { newCommandId, newThreadId } from "../lib/utils";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { hostHandle } from "./hostScope";

/**
 * The provider Settings picks for new chats, or the first one the host has when it lacks that
 * provider: Settings are this computer's, but a host only runs what it has installed.
 */
async function resolveHostProvider(hostId: HostId, api: NativeApi) {
  const settings = readStoredAppSettings();
  const inFlightStatuses = await awaitInFlightRemoteHostProviderRefresh(hostId).catch(() => null);
  let statuses =
    inFlightStatuses && hasProbedEnabledProviderStatuses(inFlightStatuses)
      ? inFlightStatuses
      : ((await api.server.getConfig().catch(() => null))?.providers ?? []);
  // Remote SSH servers start with an empty status cache (emitting only disabled
  // non-allowlisted providers until probed). Refresh live before picking so we
  // never stamp an unavailable local default (e.g. codex from 1.1.12) onto a
  // Claude-only host.
  if (!hasProbedEnabledProviderStatuses(statuses) || !statuses.some(isProviderUsable)) {
    const refreshed = await api.server.refreshProviders?.().catch(() => null);
    if (refreshed && refreshed.providers.length > 0) {
      statuses = refreshed.providers;
    }
  }
  const provider = resolveAvailableProviderPreference({
    preferredProvider: settings.defaultProvider,
    statuses,
    providerOrder: settings.providerOrder,
  });
  return { provider, settings };
}

/** Model of a new chat on a host: Settings' pinned model, else the last one used there. */
async function resolveHostModelSelection(
  hostId: HostId,
  api: NativeApi,
  candidates: ReadonlyArray<ModelSelection | null | undefined>,
): Promise<ModelSelection> {
  const { provider, settings } = await resolveHostProvider(hostId, api);
  return (
    (settings.defaultProvider === provider
      ? resolveDefaultModelSelection({
          defaultProvider: provider,
          defaultModel: settings.defaultModel,
          defaultEffort: settings.defaultEffort,
        })
      : null) ??
    candidates.find((selection) => selection?.provider === provider) ??
    // Providers without a default model (pi, omp) fall back to Codex's.
    buildModelSelection(
      getDefaultModel(provider) ? provider : "codex",
      getDefaultModel(provider) ?? getDefaultModel("codex")!,
    )
  );
}

export async function createHostThread(hostId: HostId, projectId: ProjectId): Promise<ThreadId> {
  const host = hostHandle(hostId);
  const api = host.requireApi();
  const state = host.store.getState();
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("This project is no longer on the host.");
  const latestThread = (state.threadIds ?? [])
    .map((id) => getThreadFromState(state, id))
    .filter((thread) => thread?.projectId === projectId)
    .toSorted((a, b) => (b?.updatedAt ?? "").localeCompare(a?.updatedAt ?? ""))[0];
  const modelSelection = await resolveHostModelSelection(hostId, api, [
    latestThread?.modelSelection,
    project.defaultModelSelection,
  ]);

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
  const { provider } = await resolveHostProvider(hostId, api);
  const { projectId } = await createOrRecoverProjectFromPath({
    api,
    workspaceRoot,
    defaultProvider: provider,
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
