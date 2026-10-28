// FILE: hostShellPump.ts
// Purpose: Feeds one host's store from that host's shell stream, with the same snapshot fence
//          as this computer's EventRouter: events before the snapshot wait for it, events the
//          snapshot already covers are dropped. A pump that stops leaves the store as it was,
//          so a host that goes offline keeps its last known projects and threads.
// Layer: Web host connections
// Exports: createHostShellPump, HostShellStatus, HostShellTransport

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
} from "@saint/contracts";

import type { HostStore } from "../store";

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

/** Events that may arrive ahead of the snapshot; the oldest are dropped past this. */
const PENDING_EVENT_LIMIT = 512;

/** Returns a stop function. */
export function createHostShellPump(input: {
  readonly store: Pick<HostStore, "getState">;
  readonly transport: HostShellTransport;
  readonly onStatus?: (status: HostShellStatus, message?: string) => void;
}): () => void {
  const { store, transport, onStatus } = input;
  let stopped = false;
  let fence = -1;
  let pending: OrchestrationShellStreamEvent[] = [];

  const status = (next: HostShellStatus, message?: string) => {
    if (!stopped) onStatus?.(next, message);
  };

  const applyEvent = (event: OrchestrationShellStreamEvent) => {
    if (event.sequence <= fence) return;
    fence = event.sequence;
    store.getState().applyShellEvent(event);
  };

  const unsubscribe = transport.subscribe(ORCHESTRATION_WS_CHANNELS.shellEvent, (message) => {
    if (stopped) return;
    const item = message.data;
    if (item.kind === "snapshot") {
      // Authoritative: prunes what the host no longer has. Only a live pump gets here, so an
      // offline host is never pruned by silence.
      fence = item.snapshot.snapshotSequence;
      store.getState().syncServerShellSnapshot(item.snapshot);
      const buffered = pending;
      pending = [];
      for (const event of buffered) applyEvent(event);
      status("live");
      return;
    }
    if (fence < 0) {
      pending.push(item);
      if (pending.length > PENDING_EVENT_LIMIT) pending.shift();
      return;
    }
    applyEvent(item);
  });
  const unwatchState = transport.onStateChange((state) => {
    if (state === "closed" || state === "incompatible") {
      // The transport restarts the stream and sends a new snapshot, which re-bases the fence.
      fence = -1;
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
    pending = [];
    unsubscribe();
    unwatchState();
  };
}
