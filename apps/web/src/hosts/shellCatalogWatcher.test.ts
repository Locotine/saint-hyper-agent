import type { OrchestrationShellSnapshot, OrchestrationShellStreamItem } from "@saint/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchShellCatalog, type ShellCatalogTransport } from "./shellCatalogWatcher";

const snapshot = (snapshotSequence: number) =>
  ({
    snapshotSequence,
    spaces: [],
    projects: [],
    threads: [],
  }) as unknown as OrchestrationShellSnapshot;

function makeTransport(fetched: () => OrchestrationShellSnapshot) {
  let push: (item: OrchestrationShellStreamItem) => void = () => undefined;
  let state: (value: string) => void = () => undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async () => fetched());
  const transport: ShellCatalogTransport = {
    subscribe: (_channel, listener) => {
      push = (data) => listener({ data });
      return unsubscribe;
    },
    request: request as ShellCatalogTransport["request"],
    onStateChange: (listener) => {
      state = listener;
      return () => undefined;
    },
  };
  return {
    transport,
    request,
    unsubscribe,
    push: (item: OrchestrationShellStreamItem) => push(item),
    setState: (value: string) => state(value),
  };
}

const event = {
  kind: "thread-removed",
  sequence: 5,
  threadId: "t",
} as OrchestrationShellStreamItem;

describe("watchShellCatalog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies the stream snapshot directly and refetches once for a burst of events", async () => {
    const host = makeTransport(() => snapshot(7));
    const sink = { snapshot: vi.fn(), error: vi.fn() };
    watchShellCatalog(host.transport, sink, 100);

    host.push({ kind: "snapshot", snapshot: snapshot(3) });
    expect(sink.snapshot).toHaveBeenCalledTimes(1);
    expect(host.request).not.toHaveBeenCalled();

    host.push(event);
    host.push(event);
    host.push(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(sink.snapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 7 }),
    );
  });

  it("drops a fetched snapshot older than one already applied", async () => {
    const host = makeTransport(() => snapshot(2));
    const sink = { snapshot: vi.fn(), error: vi.fn() };
    watchShellCatalog(host.transport, sink, 100);
    host.push({ kind: "snapshot", snapshot: snapshot(9) });
    host.push(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(sink.snapshot).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable transport and a failed fetch", async () => {
    const host = makeTransport(() => snapshot(1));
    host.request.mockRejectedValueOnce(new Error("boom"));
    const sink = { snapshot: vi.fn(), error: vi.fn() };
    watchShellCatalog(host.transport, sink, 100);
    host.setState("closed");
    expect(sink.error).toHaveBeenCalledWith("The host's server is not reachable.");
    host.push(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.error).toHaveBeenLastCalledWith("boom");
  });

  it("delivers nothing after stop, including a pending refetch", async () => {
    const host = makeTransport(() => snapshot(4));
    const sink = { snapshot: vi.fn(), error: vi.fn() };
    const stop = watchShellCatalog(host.transport, sink, 100);
    host.push(event);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    host.push({ kind: "snapshot", snapshot: snapshot(8) });
    host.setState("closed");
    expect(host.request).not.toHaveBeenCalled();
    expect(sink.snapshot).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
