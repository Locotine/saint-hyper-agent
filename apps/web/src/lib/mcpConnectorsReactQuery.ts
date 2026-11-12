// FILE: mcpConnectorsReactQuery.ts
// Purpose: The one react-query definition of the Connectors list, shared by Settings and
//   the composer's `@` menu so a connect or disconnect refreshes both.
// Layer: Web data access
// Exports: MCP_CONNECTORS_QUERY_KEY, mcpConnectorsQueryOptions

import { queryOptions } from "@tanstack/react-query";

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { projectApiFor, withHostKey } from "./projectReactQuery";

export const MCP_CONNECTORS_QUERY_KEY = ["server", "mcpConnectors"] as const;

/** `hostId`: whose connectors a chat can mention; a remote session only receives its host's. */
export function mcpConnectorsQueryOptions(hostId: HostId = LOCAL_HOST_ID) {
  return queryOptions({
    queryKey: withHostKey(MCP_CONNECTORS_QUERY_KEY, hostId),
    queryFn: () => projectApiFor(hostId).server.listMcpConnectors(),
    staleTime: 5_000,
    // Remote and browser-hosted clients get a definitive refusal (connectors
    // are managed on the loopback instance); retrying only repeats it.
    retry: false,
  });
}
