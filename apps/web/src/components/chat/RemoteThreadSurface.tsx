// FILE: RemoteThreadSurface.tsx
// Purpose: A connected SSH host's thread in the app window: the chat reads the host's store and
//          sends through the host's API. A split view of that host's threads renders here too.
//          While the host is offline the last loaded chat stays readable; one never loaded says
//          why it cannot open.
// Layer: Chat surface
// Exports: RemoteThreadSurface

import type { ThreadId } from "@saint/contracts";
import { threadRouteParam, type HostId } from "@saint/shared/hostId";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { HostScope } from "~/hosts/hostScope";
import { hostStores } from "~/hosts/hostStores";
import { useHostThreadDetail } from "~/hosts/hostThreadDetail";
import { type DiffRouteSearch, stripDiffSearchParams } from "~/diffRouteSearch";
import { isSplitRoute, resolveRouteChatSurface } from "~/splitViewRoute";
import { selectSplitView, useSplitViewStore } from "~/splitViewStore";
import { SingleChatSurface } from "./SingleChatSurface";
import { SplitChatSurface } from "./SplitChatSurface";
import { remoteHostAlias } from "../settings/remoteHostsSettingsModel";
import { Alert, AlertDescription } from "../ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

const RECONNECT_HINT = "Reconnect it in Settings → Remote hosts.";

function useHostAlias(hostId: HostId): string {
  return remoteHostAlias(useRemoteSshState(), hostId) ?? "This host";
}

export function RemoteThreadSurface(props: {
  hostId: HostId;
  threadId: ThreadId;
  search: DiffRouteSearch;
}) {
  const { hostId, threadId } = props;
  const projectId = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.get(hostId).getState().sidebarThreadSummaryById[threadId]?.projectId ?? null,
  );
  const routeSplitViewId = props.search.splitViewId ?? null;
  // A split opens only on its own host; a stale id or another host's split falls back to one chat.
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSplitViewId, hostId), [routeSplitViewId, hostId]),
  );
  const splitViewsHydrated = useSplitViewStore((store) => store.hasHydrated);
  const surface = resolveRouteChatSurface({
    search: props.search,
    splitView,
    splitViewsHydrated,
  });
  const staleSplitRoute = surface === "single" && isSplitRoute(props.search);
  // Split panes stream their own threads, the route's included.
  useHostThreadDetail(hostId, surface === "single" ? threadId : null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!staleSplitRoute) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: threadRouteParam(hostId, threadId) },
      replace: true,
      search: (previous) => ({ ...stripDiffSearchParams(previous), splitViewId: undefined }),
    });
  }, [hostId, navigate, staleSplitRoute, threadId]);
  const live = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.status(hostId).status === "live",
  );
  const loaded = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.get(hostId).getState().threadDetailSyncById?.[threadId] === "synced",
  );
  const alias = useHostAlias(hostId);

  if (surface === "hold") return null;

  if (!live && !loaded) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{`${alias} is offline`}</EmptyTitle>
          <EmptyDescription>{`This chat has not loaded yet. ${RECONNECT_HINT}`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <HostScope hostId={hostId}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {live ? null : (
          <Alert variant="warning" size="sm" className="m-2 w-auto">
            <AlertDescription>{`${alias} is offline, so this chat is read-only. ${RECONNECT_HINT}`}</AlertDescription>
          </Alert>
        )}
        {/* The same surfaces as this computer's chats: right dock, Explorer and Browser included. */}
        {surface === "split" && splitView ? (
          <SplitChatSurface splitViewId={splitView.id} routeThreadId={threadId} />
        ) : (
          <SingleChatSurface threadId={threadId} search={props.search} projectId={projectId} />
        )}
      </div>
    </HostScope>
  );
}
