// FILE: hostThreadDetail.ts
// Purpose: Streams one remote host thread's detail (messages, activities, session) into that
//          host's store while a view shows it. This computer's threads keep EventRouter's lease
//          machinery; a remote thread needs only snapshot-then-events on the host's transport,
//          which restarts the stream (and sends a fresh snapshot) after a reconnect.
// Layer: Web host connections
// Exports: followHostThread, useHostThreadDetail

import type { NativeApi, OrchestrationEvent, ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useEffect, useSyncExternalStore } from "react";

import type { HostStore } from "../store";
import { hostStores } from "./hostStores";
import { apiFor } from "./hostScope";

/** Events that land before the first snapshot wait for it; past this they are dropped (the snapshot covers them). */
const PENDING_EVENT_LIMIT = 500;

/** Returns a stop function that ends the host's stream for the thread. */
export function followHostThread(input: {
  readonly api: Pick<
    NativeApi["orchestration"],
    "onThreadEvent" | "subscribeThread" | "unsubscribeThread"
  >;
  readonly store: Pick<HostStore, "getState">;
  readonly threadId: ThreadId;
  readonly onError?: (error: unknown) => void;
}): () => void {
  const { api, store, threadId } = input;
  let stopped = false;
  let appliedSequence: number | null = null;
  let pending: OrchestrationEvent[] = [];

  const apply = (events: readonly OrchestrationEvent[]) => {
    if (appliedSequence === null) {
      pending.push(...events);
      if (pending.length > PENDING_EVENT_LIMIT) pending = pending.slice(-PENDING_EVENT_LIMIT);
      return;
    }
    const fresh = events.filter((event) => event.sequence > (appliedSequence ?? 0));
    if (fresh.length === 0) return;
    store.getState().applyOrchestrationEvents(fresh);
    appliedSequence = fresh.at(-1)?.sequence ?? appliedSequence;
  };

  const unsubscribe = api.onThreadEvent((item) => {
    if (stopped) return;
    if (item.kind === "snapshot") {
      if (item.snapshot.thread.id !== threadId) return;
      store
        .getState()
        .syncServerThreadDetailHotPath(
          item.snapshot.thread,
          item.snapshot.snapshotSequence,
          item.snapshot.historyRevisionSequence,
        );
      // A reconnect re-sends the snapshot; it replaces the detail and re-bases the fence.
      appliedSequence = item.snapshot.snapshotSequence;
      const buffered = pending;
      pending = [];
      apply(buffered);
      return;
    }
    const events = item.kind === "replay" ? item.events : [item.event];
    apply(events.filter((event) => String(event.aggregateId) === threadId));
  });

  api.subscribeThread({ threadId }).catch((error: unknown) => {
    if (!stopped) input.onError?.(error);
  });

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    void api.unsubscribeThread({ threadId }).catch(() => undefined);
  };
}

/**
 * Keeps a remote thread's detail current while the calling view is mounted. A host that goes
 * offline keeps the last detail in its store (read-only); the stream resumes on a new connection.
 */
export function useHostThreadDetail(hostId: HostId, threadId: ThreadId): void {
  const live = useSyncExternalStore(
    hostStores.subscribe,
    () => hostStores.status(hostId).status === "live",
  );
  useEffect(() => {
    if (hostId === LOCAL_HOST_ID || !live) return;
    const api = apiFor(hostId);
    if (!api) return;
    const store = hostStores.get(hostId);
    return followHostThread({
      api: api.orchestration,
      store,
      threadId,
      onError: () => store.getState().markThreadDetailSyncFailed(threadId),
    });
  }, [hostId, threadId, live]);
}
