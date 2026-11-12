// FILE: threadActivation.logic.ts
// Purpose: Pure routing decisions for opening threads as single chats or split panes.
// Exports: split-aware activation resolvers shared by sidebar click, keyboard, and search flows.

import type { ThreadId } from "@saint/contracts";
import type { HostId } from "@saint/shared/hostId";
import {
  resolveSplitViewPaneIdForThread,
  type PaneId,
  type SplitView,
  type SplitViewId,
} from "./splitViewStore";

export type ThreadCommandActivation =
  | { kind: "ignore" }
  | { kind: "single"; threadId: ThreadId }
  | { kind: "split"; threadId: ThreadId; splitViewId: SplitViewId; paneId: PaneId };

/**
 * Decide what a sidebar/search/keyboard activation should do for a thread.
 *
 * Callers decide which split (if any) is "preferred". That means the currently
 * active split first, then any persisted split block with deterministic ownership.
 */
export function resolveThreadCommandActivation(input: {
  threadId: ThreadId;
  threadExists: boolean;
  activeSidebarThreadId: ThreadId | null | undefined;
  preferredSplitViewId: SplitViewId | null;
  splitPaneId: PaneId | null;
}): ThreadCommandActivation {
  if (!input.threadExists) {
    return { kind: "ignore" };
  }

  if (input.preferredSplitViewId && input.splitPaneId) {
    return {
      kind: "split",
      threadId: input.threadId,
      splitViewId: input.preferredSplitViewId,
      paneId: input.splitPaneId,
    };
  }

  if (input.threadId === input.activeSidebarThreadId) {
    return { kind: "ignore" };
  }

  return { kind: "single", threadId: input.threadId };
}

/**
 * Resolve whether thread activation should land in a split.
 *
 * While a split is active, that split's panes win. Otherwise every persisted
 * split block can be restored, but ambiguous non-source membership falls back to
 * single chat instead of guessing by recency.
 */
export function resolvePreferredSplitForCommand(input: {
  activeSplitView: SplitView | null;
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  threadId: ThreadId;
}): { splitViewId: SplitViewId; paneId: PaneId } | null {
  if (input.activeSplitView) {
    const paneId = resolveSplitViewPaneIdForThread(input.activeSplitView, input.threadId);
    if (paneId) {
      return { splitViewId: input.activeSplitView.id, paneId };
    }
  }

  const matchingSplits = Object.values(input.splitViewsById)
    .filter((splitView): splitView is SplitView => splitView !== undefined)
    .map((splitView) => ({
      splitView,
      paneId: resolveSplitViewPaneIdForThread(splitView, input.threadId),
    }))
    .filter((match): match is { splitView: SplitView; paneId: PaneId } => match.paneId !== null);

  const sourceMatch = matchingSplits.find(
    ({ splitView }) => splitView.sourceThreadId === input.threadId,
  );
  const match = sourceMatch ?? (matchingSplits.length === 1 ? matchingSplits[0] : null);
  return match ? { splitViewId: match.splitView.id, paneId: match.paneId } : null;
}

/**
 * The split a host's thread opens in from its sidebar row, as `resolvePreferredSplitForCommand`
 * decides for this computer's rows, over that host's splits only: the route's split first.
 */
export function resolveHostThreadSplit(input: {
  hostId: HostId;
  threadId: ThreadId;
  routeSplitViewId: string | null | undefined;
  splitViewsById: Readonly<Record<SplitViewId, SplitView | undefined>>;
}): { splitViewId: SplitViewId; paneId: PaneId } | null {
  const hostSplitViewsById: Record<SplitViewId, SplitView | undefined> = {};
  for (const splitView of Object.values(input.splitViewsById)) {
    if (splitView?.hostId === input.hostId) hostSplitViewsById[splitView.id] = splitView;
  }
  return resolvePreferredSplitForCommand({
    activeSplitView: input.routeSplitViewId
      ? (hostSplitViewsById[input.routeSplitViewId] ?? null)
      : null,
    splitViewsById: hostSplitViewsById,
    threadId: input.threadId,
  });
}
