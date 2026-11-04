// Purpose: Route selected transcript text through the normal Side and new-chat flows.

import { LOCAL_HOST_ID, scopeLocalProject, scopeThread, type HostId } from "@saint/shared/hostId";
import type { ProjectId, ThreadEnvironmentMode, ThreadId } from "@saint/contracts";

import { useComposerDraftStore, type QueuedComposerChatTurn } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { ensureLocalNativeApi } from "../nativeApi";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { useRightDockStore } from "../rightDockStore";
import { hostStores } from "../hosts/hostStores";
import { createAssistantSelectionAttachment } from "./assistantSelections";
import { projectApiFor } from "./projectReactQuery";
import { createSidechatThread } from "./sidechatCreation";
import type { NewThreadOptions } from "./threadBootstrap";
import { randomUUID } from "./utils";
import type { TranscriptAssistantSelection } from "../components/chat/chatSelectionActions";
import { isSidechatThread } from "@saint/shared/sidechatThread";

function requireSelection(selection: TranscriptAssistantSelection) {
  const attachment = createAssistantSelectionAttachment(selection);
  if (!attachment) throw new Error("Select between 1 and 4,000 characters.");
  return attachment;
}

export async function addSelectionToSide(
  input: Pick<
    Parameters<typeof createSidechatThread>[0],
    "project" | "sourceThread" | "selectedModelSelection" | "runtimeMode"
  > & {
    selection: TranscriptAssistantSelection;
    /** The host the source chat lives on; this computer by default. */
    hostId?: HostId;
  },
): Promise<void> {
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  const attachment = requireSelection(input.selection);
  // No sidechat of a sidechat, forked or standalone.
  if (isSidechatThread(input.sourceThread) || input.sourceThread.sidechatExpiredAt) {
    throw new Error("Open a main chat before starting Side.");
  }
  await createSidechatThread({
    api: projectApiFor(hostId),
    project: input.project,
    sourceThread: input.sourceThread,
    selectedModelSelection: input.selectedModelSelection,
    ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
    openSidechat: (threadId) => {
      // Seed the reference before mounting the Side composer, including during a slow sync.
      useComposerDraftStore
        .getState()
        .addAssistantSelection(scopeThread(hostId, threadId), attachment);
      useRightDockStore.getState().openPane(input.sourceThread.id, { kind: "sidechat", threadId });
      requestComposerFocus(threadId);
    },
    syncServerShellSnapshot: (snapshot) =>
      hostStores.get(hostId).getState().syncServerShellSnapshot(snapshot),
  });
}

type SelectionChatSettings = Pick<
  QueuedComposerChatTurn,
  "modelSelection" | "selectedPromptEffort" | "providerOptionsForDispatch" | "runtimeMode"
>;

export async function startSelectionChat(
  input: SelectionChatSettings & {
    projectId: ProjectId;
    projectCwd: string;
    selection: TranscriptAssistantSelection;
    prompt: string;
    envMode: ThreadEnvironmentMode;
    intent?: "send" | "compose";
    /** The host the source chat lives on; this computer by default. */
    hostId?: HostId;
    createThread: (projectId: ProjectId, options: NewThreadOptions) => Promise<ThreadId | null>;
  },
): Promise<void> {
  const attachment = requireSelection(input.selection);
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  const prompt = input.prompt.trim();
  if (!prompt && input.intent !== "compose") throw new Error("Write a message for the new chat.");

  let branch: string | null = null;
  if (input.envMode === "worktree") {
    const status = await ensureLocalNativeApi().git.status({ cwd: input.projectCwd });
    branch = status.branch;
    if (!branch) throw new Error("Check out a branch before starting a new worktree.");
  }
  const threadId = await input.createThread(input.projectId, {
    fresh: true,
    entryPoint: "chat",
    envMode: input.envMode,
    branch,
    worktreePath: null,
    workingDirectory: null,
  });
  if (!threadId) throw new Error("Could not open the new chat. Try again.");

  const drafts = useComposerDraftStore.getState();
  drafts.setModelSelection(scopeThread(hostId, threadId), input.modelSelection);
  drafts.setRuntimeMode(scopeThread(hostId, threadId), input.runtimeMode);
  drafts.setInteractionMode(scopeThread(hostId, threadId), "default");
  useProjectEnvironmentStore
    .getState()
    .setProjectEnvMode(scopeLocalProject(input.projectId), input.envMode);
  if (input.intent === "compose") {
    drafts.setPrompt(scopeThread(hostId, threadId), input.prompt);
    drafts.addAssistantSelection(scopeThread(hostId, threadId), attachment);
    requestComposerFocus(threadId);
    return;
  }
  // The destination ChatView drains this queue through its regular first-send path,
  // including worktree creation, setup scripts, attachment serialization and recovery.
  drafts.enqueueQueuedTurn(scopeThread(hostId, threadId), {
    id: randomUUID(),
    kind: "chat",
    createdAt: new Date().toISOString(),
    previewText: prompt,
    prompt,
    assistantSelections: [attachment],
    images: [],
    files: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    pullRequestContexts: [],
    skills: [],
    mentions: [],
    selectedProvider: input.modelSelection.provider,
    selectedModel: input.modelSelection.model,
    selectedPromptEffort: input.selectedPromptEffort,
    modelSelection: input.modelSelection,
    ...(input.providerOptionsForDispatch
      ? { providerOptionsForDispatch: input.providerOptionsForDispatch }
      : {}),
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    envMode: input.envMode,
  });
}
