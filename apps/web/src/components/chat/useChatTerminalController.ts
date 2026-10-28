import { scopeThread } from "@saint/shared/hostId";
import { useHostHandle } from "~/hosts/hostScope";
import { type ThreadId } from "@saint/contracts";
import { useCallback, useEffect, useState } from "react";

import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { type Thread } from "../../types";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "../../lib/terminalCloseConfirmation";
import { shouldAutoDeleteTerminalThreadOnLastClose } from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { disposeAndCloseTerminalSession } from "../terminal/terminalSession";

type AutoDeleteCandidateThread = Pick<
  Thread,
  "activities" | "latestTurn" | "messages" | "proposedPlans" | "session" | "title"
>;

interface UseChatTerminalControllerInput {
  readonly threadId: ThreadId;
  readonly activeThreadId: ThreadId | null;
  readonly activeThread: AutoDeleteCandidateThread | null | undefined;
  readonly activeProjectPresent: boolean;
  readonly isFocusedPane: boolean;
  readonly isServerThread: boolean;
  readonly confirmTerminalClose: boolean;
  readonly onDeletePlaceholderThread: (threadId: ThreadId) => Promise<void> | void;
}

export function useChatTerminalController({
  threadId,
  activeThreadId,
  activeThread,
  activeProjectPresent,
  isFocusedPane,
  isServerThread,
  confirmTerminalClose,
  onDeletePlaceholderThread,
}: UseChatTerminalControllerInput) {
  const chatHost = useHostHandle();
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(
      state.terminalStateByThreadId,
      scopeThread(chatHost.hostId, threadId),
    ),
  );
  const setTerminalOpenInStore = useTerminalStateStore((state) => state.setTerminalOpen);
  const setPresentationModeInStore = useTerminalStateStore(
    (state) => state.setTerminalPresentationMode,
  );
  const setWorkspaceLayoutInStore = useTerminalStateStore(
    (state) => state.setTerminalWorkspaceLayout,
  );
  const openChatThreadPageInStore = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPageInStore = useTerminalStateStore(
    (state) => state.openTerminalThreadPage,
  );
  const closeWorkspaceChatInStore = useTerminalStateStore((state) => state.closeWorkspaceChat);
  const setWorkspaceTabInStore = useTerminalStateStore((state) => state.setTerminalWorkspaceTab);
  const setTerminalMetadataInStore = useTerminalStateStore((state) => state.setTerminalMetadata);
  const setTerminalActivityInStore = useTerminalStateStore((state) => state.setTerminalActivity);
  const openFullWidthTerminalInStore = useTerminalStateStore(
    (state) => state.openNewFullWidthTerminal,
  );
  const setActiveTerminalInStore = useTerminalStateStore((state) => state.setActiveTerminal);
  const closeTerminalInStore = useTerminalStateStore((state) => state.closeTerminal);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const requestTerminalFocus = useCallback(() => {
    setFocusRequestId((value) => value + 1);
  }, []);

  const terminalWorkspaceOpen =
    terminalState.presentationMode === "workspace" && terminalState.terminalOpen;
  const terminalWorkspaceTerminalTabActive =
    terminalWorkspaceOpen &&
    (terminalState.workspaceLayout === "terminal-only" ||
      terminalState.workspaceActiveTab === "terminal");
  const terminalWorkspaceChatTabActive =
    terminalWorkspaceOpen &&
    terminalState.workspaceLayout === "both" &&
    terminalState.workspaceActiveTab === "chat";

  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (activeThreadId)
        setTerminalOpenInStore(scopeThread(chatHost.hostId, activeThreadId), open);
    },
    [chatHost, activeThreadId, setTerminalOpenInStore],
  );
  const setTerminalPresentationMode = useCallback(
    (mode: "drawer" | "workspace") => {
      if (activeThreadId)
        setPresentationModeInStore(scopeThread(chatHost.hostId, activeThreadId), mode);
    },
    [chatHost, activeThreadId, setPresentationModeInStore],
  );
  const setTerminalWorkspaceLayout = useCallback(
    (layout: "both" | "terminal-only") => {
      if (activeThreadId)
        setWorkspaceLayoutInStore(scopeThread(chatHost.hostId, activeThreadId), layout);
    },
    [chatHost, activeThreadId, setWorkspaceLayoutInStore],
  );
  const setTerminalWorkspaceTab = useCallback(
    (tab: "terminal" | "chat") => {
      if (activeThreadId) setWorkspaceTabInStore(scopeThread(chatHost.hostId, activeThreadId), tab);
    },
    [chatHost, activeThreadId, setWorkspaceTabInStore],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    if (!terminalState.terminalOpen) setTerminalPresentationMode("workspace");
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, setTerminalPresentationMode, terminalState.terminalOpen]);
  const createTerminalFromShortcut = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalOpen(true);
    setTerminalWorkspaceTab("terminal");
    requestTerminalFocus();
  }, [
    activeThreadId,
    setTerminalPresentationMode,
    setTerminalOpen,
    setTerminalWorkspaceTab,
    requestTerminalFocus,
  ]);
  const openNewFullWidthTerminal = useCallback(() => {
    if (!activeThreadId || !activeProjectPresent) return;
    openFullWidthTerminalInStore(scopeThread(chatHost.hostId, activeThreadId));
    requestTerminalFocus();
  }, [
    chatHost,
    activeProjectPresent,
    activeThreadId,
    openFullWidthTerminalInStore,
    requestTerminalFocus,
  ]);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || !isFocusedPane) return;
    return onMenuAction((action) => {
      if (action === "new-terminal-tab") createTerminalFromShortcut();
    });
  }, [createTerminalFromShortcut, isFocusedPane]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      setActiveTerminalInStore(scopeThread(chatHost.hostId, activeThreadId), terminalId);
      requestTerminalFocus();
    },
    [chatHost, activeThreadId, requestTerminalFocus, setActiveTerminalInStore],
  );
  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const api = chatHost.api();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const shouldDeletePlaceholderThread = shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: isFinalTerminal,
        isServerThread,
        terminalEntryPoint: terminalState.entryPoint,
        thread: activeThread,
      });
      const confirmed = await confirmTerminalTabClose({
        api,
        enabled: shouldPromptForTerminalClose({
          confirmationEnabled: confirmTerminalClose,
          runningTerminalIds: terminalState.runningTerminalIds,
          terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          terminalId,
        }),
        terminalTitle: resolveTerminalCloseTitle({
          terminalId,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        }),
        willDeleteThread: shouldDeletePlaceholderThread,
      });
      if (!confirmed) return;
      try {
        await disposeAndCloseTerminalSession({
          api,
          threadId: activeThreadId,
          terminalId,
          requireStructuredClose: true,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to close terminal",
          description: error instanceof Error ? error.message : "Please try again.",
        });
        return;
      }
      closeTerminalInStore(scopeThread(chatHost.hostId, activeThreadId), terminalId);
      requestTerminalFocus();
      if (shouldDeletePlaceholderThread) {
        void onDeletePlaceholderThread(activeThreadId);
      }
    },
    [
      chatHost,
      activeThread,
      activeThreadId,
      closeTerminalInStore,
      confirmTerminalClose,
      isServerThread,
      onDeletePlaceholderThread,
      requestTerminalFocus,
      terminalState.entryPoint,
      terminalState.runningTerminalIds,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalIds.length,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
    ],
  );
  const handleTerminalSessionExited = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      disposeAndCloseTerminalSession({
        api: chatHost.api(),
        threadId: activeThreadId,
        terminalId,
        clearHistoryBeforeClose: isFinalTerminal,
        processAlreadyExited: true,
      });
      closeTerminalInStore(scopeThread(chatHost.hostId, activeThreadId), terminalId);
      requestTerminalFocus();
    },
    [
      chatHost,
      activeThreadId,
      closeTerminalInStore,
      requestTerminalFocus,
      terminalState.terminalIds.length,
    ],
  );
  const closeActiveWorkspaceView = useCallback(() => {
    if (!activeThreadId || !terminalWorkspaceOpen) return;
    if (terminalState.workspaceLayout === "both" && terminalState.workspaceActiveTab === "chat") {
      if (terminalState.entryPoint === "chat") {
        setTerminalOpen(false);
      } else {
        closeWorkspaceChatInStore(scopeThread(chatHost.hostId, activeThreadId));
      }
      return;
    }
    void closeTerminal(terminalState.activeTerminalId);
  }, [
    chatHost,
    activeThreadId,
    closeTerminal,
    closeWorkspaceChatInStore,
    setTerminalOpen,
    terminalState.activeTerminalId,
    terminalState.entryPoint,
    terminalState.workspaceActiveTab,
    terminalState.workspaceLayout,
    terminalWorkspaceOpen,
  ]);

  return {
    terminalState,
    terminalFocusRequestId: focusRequestId,
    requestTerminalFocus,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalMetadataInStore,
    setTerminalActivityInStore,
    openChatThreadPageInStore,
    openTerminalThreadPageInStore,
    setActiveTerminalInStore,
    toggleTerminalVisibility,
    createTerminalFromShortcut,
    openNewFullWidthTerminal,
    activateTerminal,
    closeTerminal,
    handleTerminalSessionExited,
    closeActiveWorkspaceView,
  };
}
