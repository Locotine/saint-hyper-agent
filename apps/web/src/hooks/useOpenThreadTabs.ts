// FILE: useOpenThreadTabs.ts
// Purpose: Connect the open-thread tab store to the app: derive display tabs from live
//          saved thread state, record the thread on screen as open, and switch threads
//          from a tab the same way the sidebar and Ctrl+Tab switcher do.
// Layer: UI hooks
// Exports: useOpenThreadTabs, useRecordOpenThreadTab, useActivateThreadTab,
//          useReadRouteThreadId

import type { ProjectId, ThreadId } from "@saint/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  LOCAL_HOST_ID,
  parseScopedThreadId,
  scopeLocalThread,
  scopeThread,
  threadRouteParam,
  unscopeThread,
} from "@saint/shared/hostId";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import { stripDiffSearchParams } from "../diffRouteSearch";
import {
  getActiveComposerSendThreadIds,
  subscribeComposerSends,
} from "../lib/composerSendOwnership";
import {
  buildOpenThreadTabs,
  canKeepOpenThreadTab,
  hostOpenThreadIds,
  type OpenThreadTab,
  type OpenThreadTabSource,
} from "../openThreadTabs.logic";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { useHostId } from "../hosts/hostScope";
import { useStore } from "../store";
import { selectThreadActivities } from "../threadDerivation";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadDetailPrewarm } from "../threadDetailPrewarm";

/**
 * Open threads as display tabs, in tab order. `projectId` scopes them to one project
 * (the editor view). Stale ids (deleted threads, discarded drafts) are dropped from the
 * persisted list once the thread snapshot has hydrated.
 */
export function useOpenThreadTabs(input: {
  activeThreadId: ThreadId | null;
  projectId?: ProjectId | null | undefined;
}): OpenThreadTab[] {
  const { activeThreadId } = input;
  const scopedThreadIds = useOpenThreadTabsStore((state) => state.threadIds);
  const hostId = useHostId();
  const threadIds = useMemo(
    () => hostOpenThreadIds(scopedThreadIds, hostId),
    [scopedThreadIds, hostId],
  );
  const pruneThreadTabs = useOpenThreadTabsStore((state) => state.pruneThreadTabs);
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const activeComposerSendThreadIds = useSyncExternalStore(
    subscribeComposerSends,
    getActiveComposerSendThreadIds,
    getActiveComposerSendThreadIds,
  );
  // Per-id slices compared element-wise, so unrelated thread or composer churn (streaming,
  // typing) does not re-render the strip.
  const summaries = useStore(
    useShallow((state) => threadIds.map((threadId) => state.sidebarThreadSummaryById[threadId])),
  );
  // Subagent tabs name their agent from the parent's activity log, like the sidebar row.
  // Activity arrays are cached per thread, so this only changes when a parent logs one
  // (not on every streamed token, as the parent's whole Thread would).
  const parentActivities = useStore(
    useShallow((state) =>
      threadIds.map((threadId) => {
        const parentThreadId = state.sidebarThreadSummaryById[threadId]?.parentThreadId;
        return parentThreadId ? selectThreadActivities(state, parentThreadId) : undefined;
      }),
    ),
  );
  const terminalEntryPoints = useTerminalStateStore(
    useShallow((state) =>
      threadIds.map(
        (threadId) =>
          selectThreadTerminalState(state.terminalStateByThreadId, scopeThread(hostId, threadId))
            .entryPoint === "terminal",
      ),
    ),
  );
  // Once per mount after hydration: pruning on every thread change would also drop tabs
  // for threads that only disappear transiently (a draft promoting to a server thread).
  // Between prunes, tab derivation already hides ids that cannot keep a tab.
  const didPruneRef = useRef(false);
  useEffect(() => {
    // Only this computer's snapshot is authoritative; a remote chat's strip leaves pruning to local chats.
    if (hostId !== LOCAL_HOST_ID || !threadsHydrated || didPruneRef.current) return;
    didPruneRef.current = true;
    const { draftThreadsByThreadId } = useComposerDraftStore.getState();
    const { sidebarThreadSummaryById } = useStore.getState();
    pruneThreadTabs((scoped) => {
      const { hostId: tabHostId, threadId } = unscopeThread(scoped);
      // Another host's tabs stay.
      if (tabHostId !== LOCAL_HOST_ID) return true;
      return (
        threadId === activeThreadId ||
        canKeepOpenThreadTab(
          sidebarThreadSummaryById[threadId],
          draftThreadsByThreadId[scopeLocalThread(threadId)] !== undefined,
        )
      );
    });
  }, [activeThreadId, hostId, pruneThreadTabs, threadsHydrated]);

  const sources = threadIds.map((threadId, index): OpenThreadTabSource => {
    const summary = summaries[index];
    const activities = parentActivities[index];
    return {
      threadId,
      summary,
      parentThread:
        summary?.parentThreadId && activities
          ? { id: summary.parentThreadId, activities }
          : undefined,
      terminalEntryPoint: terminalEntryPoints[index] ?? false,
      isPreparingWorktree:
        activeComposerSendThreadIds.has(threadId) &&
        summary?.envMode === "worktree" &&
        summary.latestTurn === null &&
        summary.session === null,
    };
  });

  return buildOpenThreadTabs({ sources, activeThreadId, projectId: input.projectId });
}

/**
 * Registers the thread a chat surface is showing, including drafts so they appear on
 * promotion. Unsent drafts remain hidden. A layout effect so a newly opened
 * thread's tab paints in the same frame as the thread itself.
 */
export function useRecordOpenThreadTab(threadId: ThreadId | null): void {
  const hostId = useHostId();
  const openThreadTab = useOpenThreadTabsStore((state) => state.openThreadTab);
  useLayoutEffect(() => {
    if (threadId) {
      openThreadTab(scopeThread(hostId, threadId));
    }
  }, [hostId, openThreadTab, threadId]);
}

/**
 * Switches to an open thread as a single chat, keeping its chat-vs-terminal page like
 * the sidebar and Ctrl+Tab switcher. A tab never lands in a split: splits have one
 * header per pane, so there is no strip to keep showing.
 */
export function useActivateThreadTab(): (threadId: ThreadId) => Promise<void> {
  const hostId = useHostId();
  const navigate = useNavigate();
  const { prewarmThreadDetail } = useThreadDetailPrewarm();
  const openChatThreadPage = useTerminalStateStore((state) => state.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((state) => state.openTerminalThreadPage);

  return (threadId) => {
    // The prewarm reads this computer's server; a remote thread loads through its host surface.
    if (hostId === LOCAL_HOST_ID) prewarmThreadDetail(threadId);
    const scoped = scopeThread(hostId, threadId);
    const { entryPoint } = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      scoped,
    );
    if (entryPoint === "terminal") {
      openTerminalThreadPage(scoped);
    } else {
      openChatThreadPage(scoped);
    }
    return navigate({
      to: "/$threadId",
      params: { threadId: threadRouteParam(hostId, threadId) },
      search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId: undefined }),
    });
  };
}

/**
 * Reads the thread the route shows right now, for code that runs after a navigation
 * settles (render-time props still hold the thread from before it).
 */
export function useReadRouteThreadId(): () => ThreadId | null {
  const router = useRouter();
  const hostId = useHostId();
  return () => {
    for (const match of router.state.matches) {
      const threadId = (match.params as { threadId?: unknown }).threadId;
      if (typeof threadId === "string") {
        // Remote routes carry the host-qualified id; callers compare bare ids of their host.
        const scoped = parseScopedThreadId(threadId);
        if (scoped === null) return threadId as ThreadId;
        const ref = unscopeThread(scoped);
        return ref.hostId === hostId ? ref.threadId : (threadId as ThreadId);
      }
    }
    return null;
  };
}
