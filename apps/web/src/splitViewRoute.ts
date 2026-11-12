// FILE: splitViewRoute.ts
// Purpose: Bridges route search params and split view state so route consumers can stay focused on UI logic.
// Layer: Route helpers
// Exports: split route helpers shared by chat surface, sidebar, and thread-scoped UI

import { type ThreadId } from "@saint/contracts";
import { type DiffRouteSearch } from "./diffRouteSearch";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  type PaneId,
  type SplitView,
} from "./splitViewStore";

export function resolveActiveSplitView(input: {
  splitView: SplitView | null;
  routeThreadId: ThreadId | null;
}): {
  splitView: SplitView | null;
  focusedThreadId: ThreadId | null;
  routePaneId: PaneId | null;
} {
  const { routeThreadId, splitView } = input;
  if (!splitView) {
    return {
      splitView: null,
      focusedThreadId: routeThreadId,
      routePaneId: null,
    };
  }

  return {
    splitView,
    focusedThreadId: resolveSplitViewFocusedThreadId(splitView),
    routePaneId: resolveSplitViewPaneIdForThread(splitView, routeThreadId),
  };
}

export function isSplitRoute(search: DiffRouteSearch): boolean {
  return typeof search.splitViewId === "string" && search.splitViewId.length > 0;
}

/**
 * The surface a thread route shows. A split route waits for the persisted splits to load, as
 * this computer's route does, since choosing before then flashes a single chat; it then shows
 * its split, or one chat when that split is gone.
 */
export function resolveRouteChatSurface(input: {
  search: DiffRouteSearch;
  splitView: SplitView | null;
  splitViewsHydrated: boolean;
}): "hold" | "split" | "single" {
  if (!isSplitRoute(input.search)) return "single";
  if (!input.splitViewsHydrated) return "hold";
  return input.splitView ? "split" : "single";
}
