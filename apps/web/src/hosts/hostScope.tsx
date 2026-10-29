// FILE: hostScope.tsx
// Purpose: Which host a piece of UI acts for, and that host's API. This computer answers on the
//          app's own connection; another host on the transport its shell pump holds open.
// Layer: Web host connections
// Exports: apiFor, hostHandle, HostScope, useHostHandle, useHostId

import type { NativeApi } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { createContext, createElement, type ReactNode, useContext } from "react";

import { readLocalNativeApi } from "../nativeApi";
import { HostStoreProvider, type HostStore } from "../store";
import { createHostNativeApi } from "../wsNativeApi";
import type { WsTransport } from "../wsTransport";
import { hostConnections } from "./hostConnectionRegistry";
import { hostStores } from "./hostStores";

const apiByTransport = new WeakMap<WsTransport, NativeApi>();

/**
 * The host's API, or undefined while it has no live connection. Read it when the call is
 * made, not once per render: a reconnect brings a new transport (and a new API).
 */
export function apiFor(hostId: HostId): NativeApi | undefined {
  if (hostId === LOCAL_HOST_ID) return readLocalNativeApi();
  const transport = hostConnections.peek(hostId);
  if (!transport) return undefined;
  let api = apiByTransport.get(transport);
  if (!api) {
    api = createHostNativeApi(transport);
    apiByTransport.set(transport, api);
  }
  return api;
}

/** A host's store and API together, for code that acts on one thread or project. */
export interface HostHandle {
  readonly hostId: HostId;
  readonly store: HostStore;
  /** Read at call time, like `apiFor`. */
  readonly api: () => NativeApi | undefined;
  readonly requireApi: () => NativeApi;
}

const handles = new Map<HostId, HostHandle>();

/** Stable per host, so it is safe in hook dependency lists. */
export function hostHandle(hostId: HostId): HostHandle {
  let handle = handles.get(hostId);
  if (!handle) {
    const api = () => apiFor(hostId);
    handle = {
      hostId,
      store: hostStores.get(hostId),
      api,
      requireApi: () => {
        const resolved = api();
        if (!resolved) throw new Error("This host is not connected.");
        return resolved;
      },
    };
    handles.set(hostId, handle);
  }
  return handle;
}

const HostIdContext = createContext<HostId>(LOCAL_HOST_ID);

/** The handle of the host the calling component renders for. */
export function useHostHandle(): HostHandle {
  return hostHandle(useContext(HostIdContext));
}

/** The host the calling component renders for: this computer outside any `HostScope`. */
export function useHostId(): HostId {
  return useContext(HostIdContext);
}

/** Children read `hostId`'s store through `useStore` and act on it through `apiFor(useHostId())`. */
export function HostScope({ hostId, children }: { hostId: HostId; children: ReactNode }) {
  return createElement(
    HostIdContext.Provider,
    { value: hostId },
    createElement(HostStoreProvider, { value: hostStores.get(hostId) }, children),
  );
}
