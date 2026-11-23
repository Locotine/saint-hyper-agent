import {
  ThreadId,
  type OrchestrationThreadStreamFailure,
  type OrchestrationThreadStreamItem,
} from "@saint/contracts";
import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

import { makeReadModelThread } from "../storeTestFixtures";
import { registerThreadDetailSyncRetry, retryThreadDetailSync } from "../threadDetailSyncRetry";
import { followHostThread } from "./hostThreadDetail";

const threadId = ThreadId.makeUnsafe("thread-1");

function setup() {
  let listener: ((item: OrchestrationThreadStreamItem) => void) | null = null;
  let failureListener: ((failure: OrchestrationThreadStreamFailure) => void) | null = null;
  const api = {
    onThreadEvent: vi.fn((next: (item: OrchestrationThreadStreamItem) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    onThreadStreamFailure: vi.fn((next: (failure: OrchestrationThreadStreamFailure) => void) => {
      failureListener = next;
      return () => {
        failureListener = null;
      };
    }),
    subscribeThread: vi.fn(async () => undefined),
    unsubscribeThread: vi.fn(async () => undefined),
  };
  const state = {
    syncServerThreadDetailHotPath: vi.fn(),
    applyOrchestrationEvents: vi.fn(),
    markThreadDetailSyncFailed: vi.fn(),
  };
  const store = { getState: () => state as never };
  const emit = (item: unknown) => listener?.(item as OrchestrationThreadStreamItem);
  const emitFailure = (failure: OrchestrationThreadStreamFailure) => failureListener?.(failure);
  const event = (sequence: number, aggregateId: string = threadId) => ({
    kind: "event",
    event: { sequence, aggregateId, type: "thread.message-sent" },
  });
  const snapshot = (snapshotSequence: number) => ({
    kind: "snapshot",
    snapshot: { thread: makeReadModelThread({ id: threadId }), snapshotSequence },
  });
  return {
    api,
    state,
    store,
    emit,
    emitFailure,
    event,
    snapshot,
    listening: () => listener !== null,
    listeningFailures: () => failureListener !== null,
  };
}

const sequences = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((call) => (call[0] as Array<{ sequence: number }>).map((e) => e.sequence));

describe("followHostThread", () => {
  it("subscribes, holds events until the snapshot, then applies only newer ones", () => {
    const t = setup();
    followHostThread({ api: t.api, store: t.store, threadId });
    expect(t.api.subscribeThread).toHaveBeenCalledWith({ threadId });

    t.emit(t.event(4));
    t.emit(t.event(6));
    expect(t.state.applyOrchestrationEvents).not.toHaveBeenCalled();

    t.emit(t.snapshot(5));
    expect(t.state.syncServerThreadDetailHotPath).toHaveBeenCalledTimes(1);
    t.emit(t.event(6));
    t.emit(t.event(7));
    t.emit(t.event(8, "another-thread"));
    expect(sequences(t.state.applyOrchestrationEvents)).toEqual([[6], [7]]);
  });

  it("reports the live events it applied, so file caches can refresh", () => {
    const t = setup();
    const onEventsApplied = vi.fn();
    followHostThread({ api: t.api, store: t.store, threadId, onEventsApplied });
    t.emit(t.snapshot(5));
    t.emit(t.event(5));
    t.emit(t.event(6));
    expect(sequences(onEventsApplied)).toEqual([[6]]);
  });

  it("re-bases on the snapshot a reconnect sends", () => {
    const t = setup();
    followHostThread({ api: t.api, store: t.store, threadId });
    t.emit(t.snapshot(10));
    t.emit(t.event(11));
    t.emit(t.snapshot(3));
    t.emit(t.event(4));
    expect(sequences(t.state.applyOrchestrationEvents)).toEqual([[11], [4]]);
  });

  it("stops listening and ends the host stream", () => {
    const t = setup();
    const stop = followHostThread({ api: t.api, store: t.store, threadId });
    stop();
    stop();
    expect(t.listening()).toBe(false);
    expect(t.listeningFailures()).toBe(false);
    expect(t.api.unsubscribeThread).toHaveBeenCalledTimes(1);
  });

  it("reports terminal thread stream failures for the matching thread only", () => {
    const t = setup();
    const onError = vi.fn();
    const stop = followHostThread({ api: t.api, store: t.store, threadId, onError });

    const otherError = new Error("other thread failed");
    t.emitFailure({
      threadId: ThreadId.makeUnsafe("thread-other"),
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      error: otherError,
    });
    expect(onError).not.toHaveBeenCalled();

    const matchingError = new Error("stalled");
    t.emitFailure({
      threadId,
      code: "ORCHESTRATION_SNAPSHOT_STALLED",
      error: matchingError,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(matchingError);

    stop();
    t.emitFailure({
      threadId,
      code: "ORCHESTRATION_STREAM_OVERFLOW",
      error: new Error("after stop"),
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("retryThreadDetailSync host routing", () => {
  it("routes remote retries to the matching (hostId, threadId) without invoking local retry", async () => {
    const localRetry = vi.fn(async () => undefined);
    const remoteRetry = vi.fn(async () => undefined);
    const remoteHostId = sshHostId("a1b2c3d4");

    const unregisterLocal = registerThreadDetailSyncRetry(localRetry);
    const unregisterRemote = registerThreadDetailSyncRetry(remoteRetry, {
      hostId: remoteHostId,
      threadId,
    });

    try {
      await retryThreadDetailSync(threadId, remoteHostId);
      expect(remoteRetry).toHaveBeenCalledTimes(1);
      expect(remoteRetry).toHaveBeenCalledWith(threadId);
      expect(localRetry).not.toHaveBeenCalled();

      await retryThreadDetailSync(threadId, LOCAL_HOST_ID);
      expect(localRetry).toHaveBeenCalledTimes(1);
      expect(localRetry).toHaveBeenCalledWith(threadId);
    } finally {
      unregisterRemote();
      unregisterLocal();
    }
  });
});
