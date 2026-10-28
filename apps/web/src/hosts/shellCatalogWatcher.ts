// FILE: shellCatalogWatcher.ts
// Purpose: Keeps one host's catalog current from its shell stream instead of a 15 s poll.
//          The stream's own snapshot is applied directly; any other shell event schedules one
//          debounced snapshot fetch, so no shell reducer runs outside the host store (P2).
// Layer: Web host connections
// Exports: watchShellCatalog, ShellCatalogTransport, ShellCatalogSink

import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@saint/contracts";

export const SHELL_CATALOG_REFETCH_DEBOUNCE_MS = 250;

export interface ShellCatalogTransport {
  readonly subscribe: (
    channel: typeof ORCHESTRATION_WS_CHANNELS.shellEvent,
    listener: (message: { readonly data: OrchestrationShellStreamItem }) => void,
  ) => () => void;
  readonly request: <T>(method: string, params?: unknown) => Promise<T>;
  readonly onStateChange: (listener: (state: string) => void) => () => void;
}

export interface ShellCatalogSink {
  readonly snapshot: (snapshot: OrchestrationShellSnapshot) => void;
  readonly error: (message: string) => void;
}

/** Returns a stop function; after it runs nothing reaches the sink. */
export function watchShellCatalog(
  transport: ShellCatalogTransport,
  sink: ShellCatalogSink,
  debounceMs = SHELL_CATALOG_REFETCH_DEBOUNCE_MS,
): () => void {
  let stopped = false;
  let appliedSequence = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fetching = false;
  let refetchAgain = false;

  const apply = (snapshot: OrchestrationShellSnapshot) => {
    // A fetch that raced a newer stream snapshot must not roll the catalog back.
    if (stopped || snapshot.snapshotSequence < appliedSequence) return;
    appliedSequence = snapshot.snapshotSequence;
    sink.snapshot(snapshot);
  };

  const refetch = async () => {
    if (fetching) {
      refetchAgain = true;
      return;
    }
    fetching = true;
    try {
      apply(
        await transport.request<OrchestrationShellSnapshot>(
          ORCHESTRATION_WS_METHODS.getShellSnapshot,
        ),
      );
    } catch (error) {
      if (!stopped) sink.error(error instanceof Error ? error.message : String(error));
    } finally {
      fetching = false;
      if (refetchAgain && !stopped) {
        refetchAgain = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void refetch();
    }, debounceMs);
  };

  const unsubscribe = transport.subscribe(ORCHESTRATION_WS_CHANNELS.shellEvent, (message) => {
    if (stopped) return;
    if (message.data.kind === "snapshot") apply(message.data.snapshot);
    else schedule();
  });
  const unwatchState = transport.onStateChange((state) => {
    if (state === "closed" || state === "incompatible") {
      if (!stopped) sink.error("The host's server is not reachable.");
    }
  });
  // Listening on the channel does not open the stream; only this request does. The
  // transport restarts it itself on reconnect, and disposing the transport ends it.
  transport.request(ORCHESTRATION_WS_METHODS.subscribeShell, {}).catch((error: unknown) => {
    if (!stopped) sink.error(error instanceof Error ? error.message : String(error));
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    unsubscribe();
    unwatchState();
  };
}
