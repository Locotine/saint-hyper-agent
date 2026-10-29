// FILE: hostApi.ts
// Purpose: A host's native API, without the host stores, so data helpers (query options, editor
//          sessions) can route calls to a connected host without loading the store layer.
// Layer: Web host connections
// Exports: apiFor

import type { NativeApi } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { readLocalNativeApi } from "../nativeApi";
import { createHostNativeApi } from "../wsNativeApi";
import type { WsTransport } from "../wsTransport";
import { hostConnections } from "./hostConnectionRegistry";

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
