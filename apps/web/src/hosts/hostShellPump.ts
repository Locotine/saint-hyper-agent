// FILE: hostShellPump.ts
// Purpose: Feeds one host's store from that host's shell stream through the same snapshot fence
//          as this computer's EventRouter (see shellFence.ts). A pump that stops leaves the store
//          as it was, so a host that goes offline keeps its last known projects and threads.
// Layer: Web host connections
// Exports: createHostShellPump, HostShellStatus, HostShellTransport

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellStreamItem,
} from "@saint/contracts";

import type { HostStore } from "../store";
import { createShellFence } from "./shellFence";

/** `connecting` until the first snapshot lands, `live` after it, `stale` once the host is out of reach. */
export type HostShellStatus = "connecting" | "live" | "stale";

export interface HostShellTransport {
  readonly subscribe: (
    channel: typeof ORCHESTRATION_WS_CHANNELS.shellEvent,
    listener: (message: { readonly data: OrchestrationShellStreamItem }) => void,
  ) => () => void;
  readonly request: <T>(method: string, params?: unknown) => Promise<T>;
  readonly onStateChange: (listener: (state: string) => void) => () => void;
}

/** Returns a stop function. */
export function createHostShellPump(input: {
  readonly store: Pick<HostStore, "getState">;
  readonly transport: HostShellTransport;
  readonly onStatus?: (status: HostShellStatus, message?: string) => void;
}): () => void {
  const { store, transport, onStatus } = input;
  let stopped = false;
  const fence = createShellFence({
    syncServerShellSnapshot: (snapshot) => store.getState().syncServerShellSnapshot(snapshot),
    applyShellEvent: (event) => store.getState().applyShellEvent(event),
  });

  const status = (next: HostShellStatus, message?: string) => {
    if (!stopped) onStatus?.(next, message);
  };

  const unsubscribe = transport.subscribe(ORCHESTRATION_WS_CHANNELS.shellEvent, (message) => {
    if (stopped) return;
    const item = message.data;
    if (item.kind === "snapshot") {
      // Authoritative: prunes what the host no longer has. Only a live pump gets here, so an
      // offline host is never pruned by silence.
      fence.applySnapshot(item.snapshot, { force: true });
      status("live");
      return;
    }
    fence.applyEvent(item);
  });
  const unwatchState = transport.onStateChange((state) => {
    if (state === "closed" || state === "incompatible") {
      // The transport restarts the stream and sends a new snapshot, which re-bases the fence.
      fence.reset();
      status("stale");
    }
  });

  status("connecting");
  // Listening on the channel does not open the stream; only this request does. The transport
  // restarts it on reconnect, and disposing the transport ends it.
  transport.request(ORCHESTRATION_WS_METHODS.subscribeShell, {}).catch((error: unknown) => {
    status("stale", error instanceof Error ? error.message : String(error));
  });

  return () => {
    if (stopped) return;
    status("stale");
    stopped = true;
    fence.reset();
    unsubscribe();
    unwatchState();
  };
}
