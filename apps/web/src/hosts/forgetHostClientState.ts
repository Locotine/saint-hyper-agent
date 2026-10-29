// FILE: forgetHostClientState.ts
// Purpose: Drops everything the client persisted for one host when the user forgets it:
//          drafts, tabs, pins, terminal and split layouts, recent views and per-project
//          preferences. This computer's state is never touched.
// Layer: Web host stores
// Exports: forgetHostClientState

import {
  LOCAL_HOST_ID,
  hostIdOf,
  type HostId,
  type ScopedProjectId,
  type ScopedThreadId,
} from "@saint/shared/hostId";

import { useComposerDraftStore } from "../composerDraftStore";
import { useDiffRenderModeStore } from "../diffRenderModeStore";
import { useGroupPanelClosedStore } from "../groupPanelClosedStore";
import { useKanbanUiStore } from "../kanbanUiStore";
import { useLatestProjectStore } from "../latestProjectStore";
import { useClaudeCompactionRequests } from "../lib/claudeCompactionRequests";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useProjectInstructionsStore } from "../projectInstructionsStore";
import { useRecentViewsStore } from "../recentViewsStore";
import { useSplitViewStore } from "../splitViewStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { useWorkflowRunUiStore } from "../workflowRunUiStore";

type ScopedId = ScopedThreadId | ScopedProjectId;

function withoutHost<K extends ScopedId, V>(record: Record<K, V>, hostId: HostId): Record<K, V> {
  const keys = Object.keys(record) as K[];
  if (!keys.some((key) => hostIdOf(key) === hostId)) return record;
  const next = {} as Record<K, V>;
  for (const key of keys) {
    if (hostIdOf(key) !== hostId) next[key] = record[key];
  }
  return next;
}

export function forgetHostClientState(hostId: HostId): void {
  if (hostId === LOCAL_HOST_ID) return;
  const onHost = (id: ScopedId) => hostIdOf(id) === hostId;

  // Through the store action, so attachment blobs are released with the draft.
  const drafts = useComposerDraftStore.getState();
  const draftThreadIds = new Set([
    ...(Object.keys(drafts.draftsByThreadId) as ScopedThreadId[]),
    ...(Object.keys(drafts.draftThreadsByThreadId) as ScopedThreadId[]),
  ]);
  for (const threadId of draftThreadIds) {
    if (onHost(threadId)) drafts.clearDraftThread(threadId);
  }

  useOpenThreadTabsStore.getState().pruneThreadTabs((threadId) => !onHost(threadId));
  useTerminalStateStore.getState().removeOrphanedTerminalStates(hostId, new Set());
  usePinnedThreadsStore.setState((state) => ({
    pinnedThreadIds: state.pinnedThreadIds.filter((id) => !onHost(id)),
  }));
  usePinnedProjectsStore.setState((state) => ({
    pinnedProjectIds: state.pinnedProjectIds.filter((id) => !onHost(id)),
  }));
  useRecentViewsStore.setState((state) => ({
    recentViews: state.recentViews.filter(
      (view) => view.kind !== "thread" || !onHost(view.threadId),
    ),
  }));
  useSplitViewStore.setState((state) => ({
    splitViewsById: Object.fromEntries(
      Object.entries(state.splitViewsById).filter(([, view]) => view?.hostId !== hostId),
    ),
    splitViewIdBySourceThreadId: withoutHost(state.splitViewIdBySourceThreadId, hostId),
  }));
  useDiffRenderModeStore.setState((state) => ({
    modeByThreadId: withoutHost(state.modeByThreadId, hostId),
  }));
  useWorkflowRunUiStore.setState((state) => ({
    stateByThreadId: withoutHost(state.stateByThreadId, hostId),
  }));
  useClaudeCompactionRequests.setState((state) => ({
    requests: withoutHost(state.requests, hostId),
  }));
  useGroupPanelClosedStore.setState((state) => ({
    closedProjectIds: state.closedProjectIds.filter((id) => !onHost(id)),
  }));
  useLatestProjectStore.setState((state) =>
    state.latestProjectId && onHost(state.latestProjectId) ? { latestProjectId: null } : state,
  );
  useProjectEnvironmentStore.setState((state) => ({
    envModeByProjectId: withoutHost(state.envModeByProjectId, hostId),
  }));
  useProjectInstructionsStore.setState((state) => ({
    instructionsByProjectId: withoutHost(state.instructionsByProjectId, hostId),
  }));
  useKanbanUiStore.setState((state) => ({
    draftOrderByProjectId: withoutHost(state.draftOrderByProjectId, hostId),
  }));
}
