import { scopeLocalThread, type ScopedThreadId } from "@saint/shared/hostId";
import { ThreadId, type ProjectId } from "@saint/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  type ComposerTrigger,
} from "../../composer-logic";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type BrowserAnnotationDraft,
  type ComposerDraftStoreState,
  type ComposerAssistantSelectionAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type RestoredComposerSourceProposedPlan,
} from "../../composerDraftStore";
import {
  localProjectDraftThread,
  type DraftThreadMutationOptions,
} from "../../composerDraftDomain";
import { type PastedTextDraft } from "../../lib/composerPastedText";
import { type FileCommentDraft } from "../../lib/fileComments";
import { type PullRequestContextDraft } from "../../lib/pullRequestContext";
import {
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import { deriveComposerSendState, type PromptHistoryNavigationState } from "../ChatView.logic";
import { type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { useComposerAttachmentPersistence } from "./useComposerAttachmentPersistence";

export type ChatComposerDraftController = ReturnType<typeof useChatComposerDraft>;
interface ChatComposerDraftInput {
  threadId: ThreadId;
}

/**
 * A composer-draft action addressed by the server thread id. The store keys drafts by host,
 * and this chat surface only shows this computer's threads.
 */
function useLocalThreadAction<Args extends unknown[], Result>(
  select: (store: ComposerDraftStoreState) => (threadId: ScopedThreadId, ...args: Args) => Result,
) {
  const action = useComposerDraftStore(select);
  return useCallback(
    (threadId: ThreadId, ...args: Args) => action(scopeLocalThread(threadId), ...args),
    [action],
  );
}

export function useChatComposerDraft({ threadId }: ChatComposerDraftInput) {
  const composerDraft = useComposerThreadDraft(scopeLocalThread(threadId));
  const prompt = composerDraft.prompt;
  const composerPromptHistorySavedDraft = composerDraft.promptHistorySavedDraft;
  const composerPromptHistorySavedDraftImages = composerPromptHistorySavedDraft?.images ?? null;
  const composerImages = composerDraft.images;
  const composerFiles = composerDraft.files;
  const composerAssistantSelections = composerDraft.assistantSelections;
  const composerBrowserAnnotations = composerDraft.browserAnnotations;
  const composerFileComments = composerDraft.fileComments;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerPastedTexts = composerDraft.pastedTexts;
  const composerPullRequestContexts = composerDraft.pullRequestContexts;
  const composerSkills = composerDraft.skills;
  const composerMentions = composerDraft.mentions;
  const queuedComposerTurns = composerDraft.queuedTurns;
  const restoredSourceProposedPlan = composerDraft.restoredSourceProposedPlan;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        fileCount: composerFiles.length,
        assistantSelectionCount: composerAssistantSelections.length,
        browserAnnotationCount: composerBrowserAnnotations.length,
        fileCommentCount: composerFileComments.length,
        terminalContexts: composerTerminalContexts,
        pastedTexts: composerPastedTexts,
        pullRequestContexts: composerPullRequestContexts,
      }),
    [
      composerAssistantSelections.length,
      composerBrowserAnnotations.length,
      composerFileComments.length,
      composerFiles.length,
      composerImages.length,
      composerTerminalContexts,
      composerPastedTexts,
      composerPullRequestContexts,
      prompt,
    ],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const durablyPersistedComposerImageIds = composerDraft.persistedAttachments;
  const setComposerDraftPrompt = useLocalThreadAction((store) => store.setPrompt);
  const setComposerDraftPromptHistorySavedDraft = useLocalThreadAction(
    (store) => store.setPromptHistorySavedDraft,
  );
  const restoreComposerDraftPromptHistorySavedDraft = useLocalThreadAction(
    (store) => store.restorePromptHistorySavedDraft,
  );
  const setComposerDraftModelSelection = useLocalThreadAction((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useLocalThreadAction(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useLocalThreadAction((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useLocalThreadAction((store) => store.setInteractionMode);
  const setComposerDraftComputerControlMode = useLocalThreadAction(
    (store) => store.setComputerControlMode,
  );
  const setComposerDraftComputerControl = useLocalThreadAction(
    (store) => store.setEnableComputerControl,
  );
  const enqueueQueuedComposerTurn = useLocalThreadAction((store) => store.enqueueQueuedTurn);
  const insertQueuedComposerTurn = useLocalThreadAction((store) => store.insertQueuedTurn);
  const removeQueuedComposerTurnFromDraft = useLocalThreadAction((store) => store.removeQueuedTurn);
  const addComposerDraftImages = useLocalThreadAction((store) => store.addImages);
  const removeComposerDraftImage = useLocalThreadAction((store) => store.removeImage);
  const addComposerDraftFiles = useLocalThreadAction((store) => store.addFiles);
  const removeComposerDraftFile = useLocalThreadAction((store) => store.removeFile);
  const addComposerDraftAssistantSelection = useLocalThreadAction(
    (store) => store.addAssistantSelection,
  );
  const addComposerDraftBrowserAnnotations = useLocalThreadAction(
    (store) => store.addBrowserAnnotations,
  );
  const removeComposerDraftBrowserAnnotation = useLocalThreadAction(
    (store) => store.removeBrowserAnnotation,
  );
  const clearComposerDraftAssistantSelections = useLocalThreadAction(
    (store) => store.clearAssistantSelections,
  );
  const addComposerDraftFileComment = useLocalThreadAction((store) => store.addFileComment);
  const clearComposerDraftFileComments = useLocalThreadAction((store) => store.clearFileComments);
  const insertComposerDraftTerminalContext = useLocalThreadAction(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useLocalThreadAction(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useLocalThreadAction(
    (store) => store.removeTerminalContext,
  );
  const addComposerDraftPastedTexts = useLocalThreadAction((store) => store.addPastedTexts);
  const removeComposerDraftPastedText = useLocalThreadAction((store) => store.removePastedText);
  const addComposerDraftPullRequestContext = useLocalThreadAction(
    (store) => store.addPullRequestContext,
  );
  const removeComposerDraftPullRequestContext = useLocalThreadAction(
    (store) => store.removePullRequestContext,
  );
  const setComposerDraftTerminalContexts = useLocalThreadAction(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftRestoredSourceProposedPlan = useLocalThreadAction(
    (store) => store.setRestoredSourceProposedPlan,
  );
  const clearComposerDraftContent = useLocalThreadAction((store) => store.clearComposerContent);
  const setDraftThreadContext = useLocalThreadAction((store) => store.setDraftThreadContext);
  const getScopedDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThreadByProjectId = useCallback(
    (...args: Parameters<typeof getScopedDraftThreadByProjectId>) =>
      localProjectDraftThread(getScopedDraftThreadByProjectId(...args)),
    [getScopedDraftThreadByProjectId],
  );
  const getDraftThread = useLocalThreadAction((store) => store.getDraftThread);
  const setScopedProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setProjectDraftThreadId,
  );
  const setProjectDraftThreadId = useCallback(
    (projectId: ProjectId, threadId: ThreadId, options?: DraftThreadMutationOptions) =>
      setScopedProjectDraftThreadId(projectId, scopeLocalThread(threadId), options),
    [setScopedProjectDraftThreadId],
  );
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );

  const promptRef = useRef(prompt);

  const composerAssistantSelectionsRef = useRef<ComposerAssistantSelectionAttachment[]>(
    composerAssistantSelections,
  );
  const composerBrowserAnnotationsRef = useRef<BrowserAnnotationDraft[]>(
    composerBrowserAnnotations,
  );
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const composerFileCommentsRef = useRef<FileCommentDraft[]>(composerFileComments);
  const composerPastedTextsRef = useRef<PastedTextDraft[]>(composerPastedTexts);
  const composerPullRequestContextsRef = useRef<PullRequestContextDraft[]>(
    composerPullRequestContexts,
  );

  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );

  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);

  const promptHistoryNavigationRef = useRef<PromptHistoryNavigationState | null>(null);
  const applyingPromptHistoryNavigationRef = useRef(false);
  const expectedPromptHistoryPromptRef = useRef<string | null>(null);
  const promptHistoryAppliedPromptRef = useRef<string | null>(null);

  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerFilesRef = useRef<ComposerFileAttachment[]>([]);

  const restoredQueuedSourceProposedPlanRef = useRef<RestoredComposerSourceProposedPlan | null>(
    restoredSourceProposedPlan ?? null,
  );

  useEffect(() => {
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
  }, [threadId]);
  // While a history browse is active the persisted draft prompt holds a
  // recalled entry and the user's real draft snapshot sits in promptHistorySavedDraft.
  // A non-null saved draft with no live navigation state means the browse was
  // interrupted (thread switch, reload, unmount) — put the real draft back.
  useEffect(() => {
    if (promptHistoryNavigationRef.current !== null || composerPromptHistorySavedDraft === null) {
      return;
    }
    restoreComposerDraftPromptHistorySavedDraft(threadId);
    setComposerCursor(
      collapseExpandedComposerCursor(
        composerPromptHistorySavedDraft.prompt,
        composerPromptHistorySavedDraft.prompt.length,
      ),
    );
  }, [composerPromptHistorySavedDraft, restoreComposerDraftPromptHistorySavedDraft, threadId]);
  const setRestoredQueuedSourceProposedPlan = useCallback(
    (targetThreadId: ThreadId, source: RestoredComposerSourceProposedPlan | null) => {
      restoredQueuedSourceProposedPlanRef.current = source;
      setComposerDraftRestoredSourceProposedPlan(targetThreadId, source);
    },
    [setComposerDraftRestoredSourceProposedPlan],
  );
  useEffect(() => {
    restoredQueuedSourceProposedPlanRef.current = restoredSourceProposedPlan ?? null;
  }, [restoredSourceProposedPlan]);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const discardPromptHistoryNavigationForComposerMutation = useCallback(() => {
    if (promptHistoryNavigationRef.current === null) {
      return;
    }
    // Attachment edits mean the recalled prompt is now the user's draft; do not restore the old one.
    promptHistoryNavigationRef.current = null;
    applyingPromptHistoryNavigationRef.current = false;
    expectedPromptHistoryPromptRef.current = null;
    promptHistoryAppliedPromptRef.current = null;
    setComposerDraftPromptHistorySavedDraft(threadId, null);
  }, [setComposerDraftPromptHistorySavedDraft, threadId]);
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      return addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFilesToDraft = useCallback(
    (files: ComposerFileAttachment[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      return addComposerDraftFiles(threadId, files);
    },
    [addComposerDraftFiles, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerAssistantSelectionToDraft = useCallback(
    (selection: ComposerAssistantSelectionAttachment) => {
      discardPromptHistoryNavigationForComposerMutation();
      return addComposerDraftAssistantSelection(threadId, selection);
    },
    [
      addComposerDraftAssistantSelection,
      discardPromptHistoryNavigationForComposerMutation,
      threadId,
    ],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerPastedTextsToDraft = useCallback(
    (pastedTexts: PastedTextDraft[]) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(threadId, pastedTexts);
    },
    [addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const addComposerFileCommentToDraft = useCallback(
    (comment: FileCommentDraft) => {
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftFileComment(threadId, comment);
    },
    [addComposerDraftFileComment, discardPromptHistoryNavigationForComposerMutation, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftImage(threadId, imageId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftImage, threadId],
  );
  const clearComposerAssistantSelectionsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftAssistantSelections(threadId);
  }, [
    clearComposerDraftAssistantSelections,
    discardPromptHistoryNavigationForComposerMutation,
    threadId,
  ]);
  const clearComposerFileCommentsFromDraft = useCallback(() => {
    discardPromptHistoryNavigationForComposerMutation();
    clearComposerDraftFileComments(threadId);
  }, [clearComposerDraftFileComments, discardPromptHistoryNavigationForComposerMutation, threadId]);
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftTerminalContext,
      setPrompt,
      threadId,
    ],
  );
  const removeComposerPastedTextFromDraft = useCallback(
    (pastedTextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftPastedText(threadId, pastedTextId);
    },
    [discardPromptHistoryNavigationForComposerMutation, removeComposerDraftPastedText, threadId],
  );
  const addComposerPullRequestContextsToDraft = useCallback(
    (contexts: ReadonlyArray<PullRequestContextDraft>) => {
      if (contexts.length === 0) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      for (const context of contexts) {
        addComposerDraftPullRequestContext(threadId, context);
      }
    },
    [
      addComposerDraftPullRequestContext,
      discardPromptHistoryNavigationForComposerMutation,
      threadId,
    ],
  );
  const removeComposerPullRequestContextFromDraft = useCallback(
    (contextId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftPullRequestContext(threadId, contextId);
    },
    [
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftPullRequestContext,
      threadId,
    ],
  );
  const removeComposerBrowserAnnotationFromDraft = useCallback(
    (annotationId: string) => {
      discardPromptHistoryNavigationForComposerMutation();
      removeComposerDraftBrowserAnnotation(threadId, annotationId);
    },
    [
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftBrowserAnnotation,
      threadId,
    ],
  );
  // "Show in text field": drop the full pasted text back into the editor (appended
  // to the current prompt) and discard the card so it can be edited as normal text.
  const showComposerPastedTextInField = useCallback(
    (pastedTextId: string) => {
      const pasted = composerPastedTexts.find((entry) => entry.id === pastedTextId);
      if (!pasted) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const current = promptRef.current;
      const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      const nextPrompt = `${current}${separator}${pasted.text}`;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      removeComposerDraftPastedText(threadId, pastedTextId);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAtEnd();
      });
    },
    [
      composerPastedTexts,
      discardPromptHistoryNavigationForComposerMutation,
      removeComposerDraftPastedText,
      setPrompt,
      threadId,
    ],
  );

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles]);

  useEffect(() => {
    composerAssistantSelectionsRef.current = composerAssistantSelections;
  }, [composerAssistantSelections]);

  useEffect(() => {
    composerBrowserAnnotationsRef.current = composerBrowserAnnotations;
  }, [composerBrowserAnnotations]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    composerFileCommentsRef.current = composerFileComments;
  }, [composerFileComments]);

  useEffect(() => {
    composerPastedTextsRef.current = composerPastedTexts;
  }, [composerPastedTexts]);

  useEffect(() => {
    composerPullRequestContextsRef.current = composerPullRequestContexts;
  }, [composerPullRequestContexts]);

  useEffect(() => {
    promptRef.current = prompt;
    if (
      promptHistoryNavigationRef.current !== null &&
      prompt !== promptHistoryAppliedPromptRef.current
    ) {
      // Another writer (queued-turn restore, automation restore, insertion)
      // replaced the prompt while a history browse was active. The new prompt
      // is authoritative: end the browse and drop the saved pre-browse draft
      // so it cannot clobber this prompt later.
      promptHistoryNavigationRef.current = null;
      expectedPromptHistoryPromptRef.current = null;
      setComposerDraftPromptHistorySavedDraft(threadId, null);
    }
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, setComposerDraftPromptHistorySavedDraft, threadId]);

  useComposerAttachmentPersistence({
    threadId,
    composerImages,
    composerPromptHistorySavedDraftImages,
  });
  return {
    composerDraft,
    prompt,
    composerImages,
    composerFiles,
    composerAssistantSelections,
    composerBrowserAnnotations,
    composerFileComments,
    composerTerminalContexts,
    composerPastedTexts,
    composerPullRequestContexts,
    composerSkills,
    composerMentions,
    queuedComposerTurns,
    composerSendState,
    nonPersistedComposerImageIds,
    durablyPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftPromptHistorySavedDraft,
    restoreComposerDraftPromptHistorySavedDraft,
    setComposerDraftModelSelection,
    setComposerDraftProviderModelOptions,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setComposerDraftComputerControlMode,
    setComposerDraftComputerControl,
    enqueueQueuedComposerTurn,
    insertQueuedComposerTurn,
    removeQueuedComposerTurnFromDraft,
    removeComposerDraftFile,
    addComposerDraftBrowserAnnotations,
    insertComposerDraftTerminalContext,
    addComposerDraftPastedTexts,
    setComposerDraftTerminalContexts,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftThreadByProjectId,
    getDraftThread,
    setProjectDraftThreadId,
    clearProjectDraftThreadId,
    promptRef,
    composerAssistantSelectionsRef,
    composerBrowserAnnotationsRef,
    composerTerminalContextsRef,
    composerFileCommentsRef,
    composerPastedTextsRef,
    composerPullRequestContextsRef,
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    composerEditorRef,
    promptHistoryNavigationRef,
    applyingPromptHistoryNavigationRef,
    expectedPromptHistoryPromptRef,
    promptHistoryAppliedPromptRef,
    composerImagesRef,
    composerFilesRef,
    restoredQueuedSourceProposedPlanRef,
    setRestoredQueuedSourceProposedPlan,
    setPrompt,
    discardPromptHistoryNavigationForComposerMutation,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerFileCommentToDraft,
    removeComposerImageFromDraft,
    clearComposerAssistantSelectionsFromDraft,
    clearComposerFileCommentsFromDraft,
    removeComposerTerminalContextFromDraft,
    removeComposerPastedTextFromDraft,
    addComposerPullRequestContextsToDraft,
    removeComposerPullRequestContextFromDraft,
    removeComposerBrowserAnnotationFromDraft,
    showComposerPastedTextInField,
  };
}
