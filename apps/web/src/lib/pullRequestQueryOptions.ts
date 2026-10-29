import type { PullRequestDetailInput, ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { apiFor } from "../hosts/hostApi";
import { queryOptions } from "@tanstack/react-query";

import { ensureLocalNativeApi } from "~/nativeApi";
import {
  GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS,
  GITHUB_ITEM_DETAIL_STALE_TIME_MS,
} from "./githubInboxQueryOptions";

// Pull request lists live in the GitHub inbox query (`githubInboxQueryOptions.ts`); these keys
// cover pull request detail and diff only.
export const pullRequestQueryKeys = {
  all: ["pull-requests"] as const,
  detail: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "detail",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  diff: (input: PullRequestDetailInput | null) =>
    [
      "pull-requests",
      "diff",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  autoFix: (threadId: ThreadId | null) => ["pull-requests", "auto-fix", threadId] as const,
};

/** Distinguish a cold-load failure from a background failure with usable cached data. */
export function pullRequestQueryErrorState<TData, TError>(
  query: { data: TData | undefined; error: TError | null; isError: boolean },
  enabled = true,
): { initialError: TError | null; backgroundError: TError | null } {
  if (!enabled || !query.isError) return { initialError: null, backgroundError: null };
  return query.data === undefined
    ? { initialError: query.error, backgroundError: null }
    : { initialError: null, backgroundError: query.error };
}

/**
 * A connected host's pull request reads go to that host and key by it after the usual key,
 * so prefix invalidations still reach them. This computer's keys are unchanged.
 */
function withHostKey<const Key extends readonly unknown[]>(key: Key, hostId: HostId) {
  return hostId === LOCAL_HOST_ID ? key : ([...key, hostId] as const);
}

export function pullRequestApiFor(hostId: HostId) {
  if (hostId === LOCAL_HOST_ID) return ensureLocalNativeApi();
  const api = apiFor(hostId);
  if (!api) throw new Error("This host is not connected.");
  return api;
}

export function pullRequestDetailQueryOptions(
  input: PullRequestDetailInput | null,
  behavior: { pollingEnabled?: boolean; hostId?: HostId } = {},
) {
  const pollingEnabled = behavior.pollingEnabled ?? true;
  const hostId = behavior.hostId ?? LOCAL_HOST_ID;
  return queryOptions({
    queryKey: withHostKey(pullRequestQueryKeys.detail(input), hostId),
    queryFn: () => {
      if (!input) throw new Error("Pull request detail is unavailable.");
      return pullRequestApiFor(hostId).pullRequests.detail(input);
    },
    enabled: input !== null,
    staleTime: GITHUB_ITEM_DETAIL_STALE_TIME_MS,
    refetchInterval: pollingEnabled ? GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: pollingEnabled,
    refetchOnReconnect: pollingEnabled,
  });
}

export function pullRequestDiffQueryOptions(
  input: PullRequestDetailInput | null,
  hostId: HostId = LOCAL_HOST_ID,
) {
  return queryOptions({
    queryKey: withHostKey(pullRequestQueryKeys.diff(input), hostId),
    queryFn: () => {
      if (!input) throw new Error("Pull request diff is unavailable.");
      return pullRequestApiFor(hostId).pullRequests.diff(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

/** Auto-fix CI state for a thread. The server watcher changes it every minute at most. */
export function pullRequestAutoFixQueryOptions(threadId: ThreadId | null, enabled: boolean) {
  return queryOptions({
    queryKey: pullRequestQueryKeys.autoFix(threadId),
    queryFn: () => {
      if (!threadId) throw new Error("Auto-fix CI is unavailable.");
      return ensureLocalNativeApi().pullRequests.getAutoFix({ threadId });
    },
    enabled: enabled && threadId !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
