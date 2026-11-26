// FILE: chatRouteRestore.ts
// Purpose: Validates saved chat routes before restoring them from startup or sidebar navigation.
// Layer: Route helper
// Exports: last-thread route resolver plus empty-startup fallback policy helpers.

import { isRemoteThreadParam } from "@saint/shared/hostId";

export type LastThreadRoute = {
  threadId: string;
  splitViewId?: string | undefined;
};

export type EmptyRouteRestoreRecoveryState = "idle" | "pending" | "done";

export const EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS = 1_800;

export function resolveRestorableThreadRoute(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadIds: ReadonlySet<string>;
  availableSplitViewIds?: ReadonlySet<string>;
}): LastThreadRoute | null {
  const { lastThreadRoute, availableThreadIds, availableSplitViewIds } = input;
  if (!lastThreadRoute) {
    return null;
  }

  if (!availableThreadIds.has(lastThreadRoute.threadId)) {
    return null;
  }

  if (
    lastThreadRoute.splitViewId &&
    availableSplitViewIds &&
    !availableSplitViewIds.has(lastThreadRoute.splitViewId)
  ) {
    return { threadId: lastThreadRoute.threadId };
  }

  return lastThreadRoute;
}

function hasRestorableLocalRememberedRoute(lastThreadRoute: LastThreadRoute | null): boolean {
  // Empty-startup recovery polls and repairs this machine's projection only; a remote SSH thread
  // never lives in local threadIds, so holding the splash screen for local repair only stalls boot.
  return lastThreadRoute !== null && !isRemoteThreadParam(lastThreadRoute.threadId);
}

// Route fallback guards separate a stale URL from a temporarily empty startup snapshot.
export function shouldStartRememberedRouteRecovery(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadCount: number;
  recoveryState: EmptyRouteRestoreRecoveryState;
}): boolean {
  return Boolean(
    hasRestorableLocalRememberedRoute(input.lastThreadRoute) &&
    input.availableThreadCount === 0 &&
    input.recoveryState === "idle",
  );
}

export function shouldHoldRememberedRouteFallback(input: {
  lastThreadRoute: LastThreadRoute | null;
  availableThreadCount: number;
  recoveryState: EmptyRouteRestoreRecoveryState;
}): boolean {
  return Boolean(
    hasRestorableLocalRememberedRoute(input.lastThreadRoute) &&
    input.availableThreadCount === 0 &&
    input.recoveryState !== "done",
  );
}

export function shouldStartMissingThreadRouteRecovery(input: {
  hasKnownServerThreads: boolean;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeThreadExists: boolean;
}): boolean {
  return !input.routeThreadExists && !input.hasKnownServerThreads && input.recoveryState === "idle";
}

export function shouldHoldMissingThreadRouteFallback(input: {
  hasKnownServerThreads: boolean;
  recoveryState: EmptyRouteRestoreRecoveryState;
  routeThreadExists: boolean;
}): boolean {
  return !input.routeThreadExists && !input.hasKnownServerThreads && input.recoveryState !== "done";
}
