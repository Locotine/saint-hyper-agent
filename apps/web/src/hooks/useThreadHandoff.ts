// FILE: useThreadHandoff.ts
// Purpose: Hands a thread to another provider, in place or in a new thread.
// Layer: Web hook
// Exports: useThreadHandoff

import { scopeLocalThread } from "@saint/shared/hostId";
import { useNavigate } from "@tanstack/react-router";
import {
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
} from "@saint/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { useProviderStatusesForLocalConfig } from "./useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "./useProviderStatusRefresh";
import {
  buildThreadHandoffImportedActivities,
  buildThreadHandoffImportedMessages,
  buildTranscriptHandoffPrompt,
  canContinueThreadHandoff,
  canCreateThreadHandoff,
  ProviderHandoffBackgroundTasksError,
  type ProviderHandoffOutcome,
  resolveProviderHandoffOutcome,
  resolveThreadHandoffModelSelection,
  resolveThreadHandoffTitle,
} from "../lib/threadHandoff";
import { resolveProviderSendAvailabilityWithRefresh } from "../lib/providerAvailability";
import { newCommandId, newMessageId, newThreadId } from "../lib/utils";
import { readLocalNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { type Thread } from "../types";

// Provider startup (CLI spawn, auth, MCP) can take a while; past this the
// caller keeps the user's message and reports the handoff as still starting.
const PROVIDER_HANDOFF_OUTCOME_TIMEOUT_MS = 120_000;

function waitForProviderHandoffOutcome(
  threadId: Thread["id"],
  commandId: string,
): Promise<ProviderHandoffOutcome> {
  const read = () =>
    resolveProviderHandoffOutcome(getThreadFromState(useStore.getState(), threadId), commandId);
  const initial = read();
  if (initial.status !== "pending") {
    return Promise.resolve(initial);
  }
  return new Promise((resolve) => {
    const finish = (outcome: ProviderHandoffOutcome) => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(outcome);
    };
    const unsubscribe = useStore.subscribe(() => {
      const outcome = read();
      if (outcome.status !== "pending") {
        finish(outcome);
      }
    });
    const timeout = window.setTimeout(
      () => finish({ status: "pending" }),
      PROVIDER_HANDOFF_OUTCOME_TIMEOUT_MS,
    );
  });
}

export function useThreadHandoff() {
  const navigate = useNavigate();
  const projects = useStore((store) => store.projects);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();

  // Shared by both Hand off destinations: the same preconditions, target
  // availability check, and target model selection.
  const prepareThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
    // A transcript handoff may restart the same agent with a fresh context.
    options?: { readonly allowSameTarget?: boolean },
  ) => {
    const api = readLocalNativeApi();
    if (!api) {
      throw new Error("Native API not found");
    }

    const project = projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      throw new Error("Project not found for handoff thread.");
    }

    if (!canCreateThreadHandoff({ thread })) {
      throw new Error("This thread cannot be handed off yet.");
    }
    const sourceProviderInstanceId =
      thread.session?.providerInstanceId ??
      thread.modelSelection.instanceId ??
      thread.modelSelection.provider;
    const targetInstanceId = targetProviderInstanceId ?? targetProvider;
    if (
      !options?.allowSameTarget &&
      targetProvider === thread.modelSelection.provider &&
      targetInstanceId === sourceProviderInstanceId
    ) {
      throw new Error("This handoff target is not available for the current thread.");
    }
    const targetAvailability = await resolveProviderSendAvailabilityWithRefresh({
      provider: targetProvider,
      ...(targetProviderInstanceId ? { instanceId: targetProviderInstanceId } : {}),
      statuses: providerStatuses,
      refreshStatuses: () => refreshProviderStatuses({ silent: true }),
    });
    if (!targetAvailability.usable) {
      throw new Error(
        targetAvailability.usable
          ? "This handoff target is not available for the current thread."
          : targetAvailability.unavailableReason,
      );
    }

    const modelSelection = resolveThreadHandoffModelSelection({
      sourceThread: thread,
      targetProvider,
      targetProviderInstanceId,
      projectDefaultModelSelection: project.defaultModelSelection,
      stickyModelSelectionByProvider:
        useComposerDraftStore.getState().stickyModelSelectionByProvider,
    });
    return { api, modelSelection, project };
  };

  // Keeps the thread (id, transcript, project, worktree) and switches who runs
  // its next turn. The server starts the target session, records the handoff in
  // the timeline, and restores the source selection if the target cannot start.
  // Resolves once the target is up; throws when it failed or is still starting,
  // so a caller holding a message keeps it.
  const continueThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
    // The model picked in the composer; the header menu leaves it to the
    // same default the new-thread handoff uses.
    explicitModelSelection?: ModelSelection,
    // Set only from an explicit user choice: ends the source's background tasks.
    options?: { readonly stopBackgroundTasks?: boolean },
  ): Promise<void> => {
    if (
      !canContinueThreadHandoff({ sourceProvider: thread.modelSelection.provider, targetProvider })
    ) {
      throw new Error("Hand off to a new thread to switch between accounts of the same provider.");
    }
    const prepared = await prepareThreadHandoff(thread, targetProvider, targetProviderInstanceId);
    const modelSelection = explicitModelSelection ?? prepared.modelSelection;
    const commandId = newCommandId();
    // The composer shows the provider the next message goes to.
    useComposerDraftStore
      .getState()
      .setModelSelectionAndSticky(scopeLocalThread(thread.id), modelSelection);
    await prepared.api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId,
      threadId: thread.id,
      modelSelection,
      providerHandoff: true,
      ...(options?.stopBackgroundTasks ? { providerHandoffStopsBackgroundTasks: true } : {}),
    });
    const outcome = await waitForProviderHandoffOutcome(thread.id, commandId);
    const targetName = PROVIDER_DISPLAY_NAMES[targetProvider] ?? targetProvider;
    if (outcome.status === "failed" && outcome.blockedByBackgroundTasks) {
      throw new ProviderHandoffBackgroundTasksError(thread.modelSelection.provider, targetProvider);
    }
    if (outcome.status === "failed") {
      throw new Error(`${targetName} could not start: ${outcome.detail}`);
    }
    if (outcome.status === "pending") {
      throw new Error(`${targetName} is still starting. Try again once it is ready.`);
    }
  };

  const createThreadHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
  ): Promise<Thread["id"]> => {
    const { api, modelSelection } = await prepareThreadHandoff(
      thread,
      targetProvider,
      targetProviderInstanceId,
    );

    const nextThreadId = newThreadId();
    const createdAt = new Date().toISOString();
    const importedMessages = buildThreadHandoffImportedMessages(thread);
    const importedActivities = buildThreadHandoffImportedActivities(thread);
    const { copyTransferableComposerState } = useComposerDraftStore.getState();

    await api.orchestration.dispatchCommand({
      type: "thread.handoff.create",
      commandId: newCommandId(),
      threadId: nextThreadId,
      sourceThreadId: thread.id,
      projectId: thread.projectId,
      title: resolveThreadHandoffTitle(thread),
      modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      envMode: thread.envMode ?? (thread.worktreePath ? "worktree" : "local"),
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      workingDirectory: thread.workingDirectory ?? null,
      associatedWorktreePath: thread.associatedWorktreePath ?? thread.worktreePath ?? null,
      associatedWorktreeBranch: thread.associatedWorktreeBranch ?? thread.branch ?? null,
      associatedWorktreeRef:
        thread.associatedWorktreeRef ?? thread.associatedWorktreeBranch ?? thread.branch ?? null,
      createBranchFlowCompleted: thread.createBranchFlowCompleted ?? false,
      importedMessages: [...importedMessages],
      createdAt,
    });

    for (const activity of importedActivities) {
      await api.orchestration.dispatchCommand({
        type: "thread.activity.append",
        commandId: newCommandId(),
        threadId: nextThreadId,
        activity,
        createdAt,
      });
    }

    copyTransferableComposerState(scopeLocalThread(thread.id), scopeLocalThread(nextThreadId));

    const snapshot = await api.orchestration.getShellSnapshot();
    syncServerShellSnapshot(snapshot);
    await navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
    });

    return nextThreadId;
  };

  // Orca-style handoff: a new thread whose agent starts fresh from the source
  // session's native transcript (read-only), the latest prompt and reply, and
  // the workspace, instead of a copy of the conversation.
  const createTranscriptHandoff = async (
    thread: Thread,
    targetProvider: ProviderKind,
    targetProviderInstanceId?: ProviderInstanceId,
  ): Promise<Thread["id"]> => {
    const { api, modelSelection, project } = await prepareThreadHandoff(
      thread,
      targetProvider,
      targetProviderInstanceId,
      { allowSameTarget: true },
    );
    const transcript = await api.orchestration
      .getThreadTranscript?.({ threadId: thread.id })
      .catch(() => null);
    const sourceProvider = thread.modelSelection.provider;
    const prompt = buildTranscriptHandoffPrompt({
      sourceAgent: `${PROVIDER_DISPLAY_NAMES[sourceProvider] ?? sourceProvider} (${thread.modelSelection.model})`,
      threadTitle: thread.title,
      workingDirectory: thread.worktreePath ?? thread.workingDirectory ?? project.cwd,
      branch: thread.branch,
      transcriptPath: transcript?.transcriptPath ?? null,
      messages: thread.messages,
    });

    const nextThreadId = newThreadId();
    const createdAt = new Date().toISOString();
    await api.orchestration.dispatchCommand({
      type: "thread.handoff.create",
      commandId: newCommandId(),
      threadId: nextThreadId,
      sourceThreadId: thread.id,
      projectId: thread.projectId,
      title: resolveThreadHandoffTitle(thread),
      modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      envMode: thread.envMode ?? (thread.worktreePath ? "worktree" : "local"),
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      workingDirectory: thread.workingDirectory ?? null,
      associatedWorktreePath: thread.associatedWorktreePath ?? thread.worktreePath ?? null,
      associatedWorktreeBranch: thread.associatedWorktreeBranch ?? thread.branch ?? null,
      associatedWorktreeRef:
        thread.associatedWorktreeRef ?? thread.associatedWorktreeBranch ?? thread.branch ?? null,
      createBranchFlowCompleted: thread.createBranchFlowCompleted ?? false,
      // The transcript replaces the copied conversation.
      importedMessages: [],
      createdAt,
    });
    await api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId: nextThreadId,
      message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
      modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    });

    const snapshot = await api.orchestration.getShellSnapshot();
    syncServerShellSnapshot(snapshot);
    await navigate({ to: "/$threadId", params: { threadId: nextThreadId } });
    return nextThreadId;
  };

  return {
    continueThreadHandoff,
    createThreadHandoff,
    createTranscriptHandoff,
  };
}
