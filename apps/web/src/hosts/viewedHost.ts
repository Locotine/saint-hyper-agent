// FILE: viewedHost.ts
// Purpose: The host the window is showing. Inside a `HostScope` that is the scope's host; elsewhere
//          (the rail, which sits outside every scope) it is the host of the thread the route opens.
// Layer: Web host connections
// Exports: hostIdFromPathname, hostScopedQueryKey, useViewedHostId

import { hostIdOf, LOCAL_HOST_ID, parseScopedThreadId, type HostId } from "@saint/shared/hostId";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useSyncExternalStore } from "react";

import { useHostId } from "./hostScope";

/** A chat route's `/$threadId` names its host; any other path, or a malformed one, is this computer. */
export function hostIdFromPathname(pathname: string): HostId {
  try {
    const scoped = parseScopedThreadId(decodeURIComponent(pathname.split("/")[1] ?? ""));
    return scoped ? hostIdOf(scoped) : LOCAL_HOST_ID;
  } catch {
    return LOCAL_HOST_ID;
  }
}

export function useViewedHostId(): HostId {
  const scopedHostId = useHostId();
  // No router (isolated component renders) leaves this computer as the viewed host.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const subscribe = useCallback(
    (listener: () => void) => router?.subscribe("onResolved", listener) ?? (() => {}),
    [router],
  );
  const read = () => (router ? hostIdFromPathname(router.state.location.pathname) : LOCAL_HOST_ID);
  const routedHostId = useSyncExternalStore(subscribe, read, read);
  return scopedHostId === LOCAL_HOST_ID ? routedHostId : scopedHostId;
}

/** This computer keeps `key` as is; another host's cache entries end in its id so hosts never share one. */
export function hostScopedQueryKey<const T extends readonly unknown[]>(key: T, hostId: HostId) {
  return hostId === LOCAL_HOST_ID ? key : ([...key, hostId] as const);
}
