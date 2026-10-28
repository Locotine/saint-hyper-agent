// FILE: hostScope.tsx
// Purpose: Which host a piece of UI acts for, and that host's API. This computer answers on the
//          app's own connection; another host on the transport its shell pump holds open.
// Layer: Web host connections
// Exports: apiFor, HostScope, useHostId

import type { NativeApi } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { createContext, createElement, type ReactNode, useContext } from "react";

import { readLocalNativeApi } from "../nativeApi";
import { HostStoreProvider } from "../store";
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

const HostIdContext = createContext<HostId>(LOCAL_HOST_ID);

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
