// Characterizes the shell snapshot fence exactly as EventRouter had it inline, so the local
// store and every remote host's pump share one implementation.

import type { OrchestrationShellSnapshot, OrchestrationShellStreamEvent } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { createShellFence } from "./shellFence";

const snapshot = (snapshotSequence: number) =>
  ({ snapshotSequence }) as unknown as OrchestrationShellSnapshot;
const event = (sequence: number, tag = "e") =>
  ({
    kind: "thread-removed",
    sequence,
    threadId: `${tag}${sequence}`,
  }) as unknown as OrchestrationShellStreamEvent;

function setup(pendingLimit?: number) {
  const calls: string[] = [];
  const fence = createShellFence(
    {
      syncServerShellSnapshot: (s) => calls.push(`sync:${s.snapshotSequence}`),
      applyShellEvent: (e) =>
        calls.push(`event:${(e as unknown as { threadId: string }).threadId}`),
    },
    pendingLimit === undefined ? undefined : { pendingLimit },
  );
  return { fence, calls };
}

describe("createShellFence", () => {
  it("starts closed: events wait for a snapshot", () => {
    const { fence, calls } = setup();
    expect(fence.sequence).toBe(-1);
    expect(fence.applyEvent(event(4))).toBe(false);
    expect(calls).toEqual([]);
  });

  it("applies the snapshot, then only the buffered events newer than it, in sequence order", () => {
    const { fence, calls } = setup();
    fence.applyEvent(event(9));
    fence.applyEvent(event(5));
    fence.applyEvent(event(7));
    fence.applyEvent(event(3));
    fence.applySnapshot(snapshot(5), { force: true });
    expect(calls).toEqual(["sync:5", "event:e7", "event:e9"]);
    expect(fence.sequence).toBe(9);
  });

  it("applies buffered events that share a sequence (it only filters on the snapshot)", () => {
    const { fence, calls } = setup();
    fence.applyEvent(event(8, "a"));
    fence.applyEvent(event(8, "b"));
    fence.applySnapshot(snapshot(5), { force: true });
    expect(calls).toEqual(["sync:5", "event:a8", "event:b8"]);
  });

  it("drops the oldest buffered events past the limit", () => {
    const { fence, calls } = setup(2);
    fence.applyEvent(event(6));
    fence.applyEvent(event(7));
    fence.applyEvent(event(8));
    fence.applySnapshot(snapshot(1), { force: true });
    expect(calls).toEqual(["sync:1", "event:e7", "event:e8"]);
  });

  it("applies live events after the snapshot and ignores ones it already covers", () => {
    const { fence, calls } = setup();
    fence.applySnapshot(snapshot(5), { force: true });
    expect(fence.applyEvent(event(6))).toBe(true);
    expect(fence.applyEvent(event(6, "dup"))).toBe(false);
    expect(fence.applyEvent(event(2))).toBe(false);
    expect(calls).toEqual(["sync:5", "event:e6"]);
    expect(fence.sequence).toBe(6);
  });

  it("calls onApply after the fence moved and before the event is applied", () => {
    const { fence, calls } = setup();
    fence.applySnapshot(snapshot(5), { force: true });
    fence.applyEvent(event(6), { onApply: () => calls.push(`before@${fence.sequence}`) });
    expect(calls).toEqual(["sync:5", "before@6", "event:e6"]);
  });

  it("a stream snapshot is always taken, even behind the fence", () => {
    const { fence, calls } = setup();
    fence.applySnapshot(snapshot(10), { force: true });
    fence.applySnapshot(snapshot(4), { force: true });
    expect(calls).toEqual(["sync:10", "sync:4"]);
    expect(fence.sequence).toBe(4);
  });

  it("a queried snapshot older than the fence is refused; equal or newer, or an open fence, is taken", () => {
    const { fence, calls } = setup();
    expect(fence.applySnapshot(snapshot(3))).toBe(true);
    expect(fence.applySnapshot(snapshot(2))).toBe(false);
    expect(fence.applySnapshot(snapshot(3))).toBe(true);
    expect(fence.applySnapshot(snapshot(8))).toBe(true);
    expect(calls).toEqual(["sync:3", "sync:3", "sync:8"]);
    expect(fence.sequence).toBe(8);
  });

  it("runs afterSync between the snapshot and the buffered events", () => {
    const { fence, calls } = setup();
    fence.applyEvent(event(7));
    fence.applySnapshot(snapshot(5), { force: true, afterSync: () => calls.push("after") });
    expect(calls).toEqual(["sync:5", "after", "event:e7"]);
  });

  it("reset closes the fence and forgets buffered events", () => {
    const { fence, calls } = setup();
    fence.applySnapshot(snapshot(5), { force: true });
    fence.applyEvent(event(6));
    fence.reset();
    expect(fence.sequence).toBe(-1);
    expect(fence.applyEvent(event(7))).toBe(false);
    fence.reset();
    fence.applySnapshot(snapshot(1), { force: true });
    expect(calls).toEqual(["sync:5", "event:e6", "sync:1"]);
  });
});
