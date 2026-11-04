// Purpose: per-desktop data partitioning on a server shared by several remote desktops.
// Layer: server transport support
//
// A server launched with SAINT_CLIENT_SCOPED=1 serves every desktop of one remote account. Each
// WebSocket names its desktop (`?client=<id>`); projects and spaces record the id they were
// created under, and everything else (threads, automations, todos, terminals...) belongs to a
// project. A scoped connection sees and changes only its own client's data. Data with no owner
// (created before scoping) is hidden from every client.
import { ServiceMap } from "effect";

import { REMOTE_CLIENT_ID_PARAM, isRemoteClientId } from "@saint/shared/remoteClientId";

/** The client a request acts for, or null when the server is not scoped (sees everything). */
export type ClientScope = string | null;

export const CurrentClientScope = ServiceMap.Reference<ClientScope>("saint/ws/CurrentClientScope", {
  defaultValue: () => null,
});

/**
 * The client scope of a WebSocket upgrade: null on an unscoped server, the id from the URL on a
 * scoped one, or "invalid" when a scoped server gets no valid id.
 */
export function clientScopeFromUpgrade(
  searchParams: URLSearchParams,
  clientScoped: boolean | undefined,
): ClientScope | "invalid" {
  if (!clientScoped) return null;
  const id = searchParams.get(REMOTE_CLIENT_ID_PARAM);
  return id !== null && isRemoteClientId(id) ? id : "invalid";
}

/** Whether data owned by `owner` is visible to `scope`. */
export function isVisibleToClient(scope: ClientScope, owner: string | null | undefined): boolean {
  return scope === null || owner === scope;
}
