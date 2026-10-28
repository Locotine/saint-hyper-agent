import { ThreadId, type OrchestrationThreadStreamItem } from "@saint/contracts";
import { describe, expect, it, vi } from "vitest";

import { makeReadModelThread } from "../storeTestFixtures";
import { followHostThread } from "./hostThreadDetail";

const threadId = ThreadId.makeUnsafe("thread-1");

function setup() {
  let listener: ((item: OrchestrationThreadStreamItem) => void) | null = null;
  const api = {
    onThreadEvent: vi.fn((next: (item: OrchestrationThreadStreamItem) => void) => {
      listener = next;
      return () => {
        listener = null;
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
  const event = (sequence: number, aggregateId: string = threadId) => ({
    kind: "event",
    event: { sequence, aggregateId, type: "thread.message-sent" },
  });
  const snapshot = (snapshotSequence: number) => ({
    kind: "snapshot",
    snapshot: { thread: makeReadModelThread({ id: threadId }), snapshotSequence },
  });
  return { api, state, store, emit, event, snapshot, listening: () => listener !== null };
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
    expect(t.api.unsubscribeThread).toHaveBeenCalledTimes(1);
  });
});
