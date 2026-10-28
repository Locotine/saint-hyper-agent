// FILE: RemoteThreadSurface.tsx
// Purpose: A connected SSH host's thread in the app window: the chat reads the host's store and
//          sends through the host's API. While the host is offline the last loaded chat stays
//          readable; one never loaded says why it cannot open.
// Layer: Chat surface
// Exports: RemoteThreadSurface

import type { ThreadId } from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";
import { useSyncExternalStore } from "react";

import { useRemoteSshState } from "~/hooks/useRemoteSshState";
import { HostScope } from "~/hosts/hostScope";
import { hostStores } from "~/hosts/hostStores";
import { useHostThreadDetail } from "~/hosts/hostThreadDetail";
import ChatView from "../ChatView";
import { Alert, AlertDescription } from "../ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

const RECONNECT_HINT = "Reconnect it in Settings → Remote hosts.";

function useHostAlias(hostId: HostId): string {
  const state = useRemoteSshState();
  const match = state?.hosts.find((host) => host.hostKey && sshHostId(host.hostKey) === hostId);
  return match?.host ?? "This host";
}

export function RemoteThreadSurface(props: { hostId: HostId; threadId: ThreadId }) {
  const { hostId, threadId } = props;
  useHostThreadDetail(hostId, threadId);
  const live = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.status(hostId).status === "live",
  );
  const loaded = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.get(hostId).getState().threadDetailSyncById?.[threadId] === "synced",
  );
  const alias = useHostAlias(hostId);

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
        <ChatView threadId={threadId} />
      </div>
    </HostScope>
  );
}
