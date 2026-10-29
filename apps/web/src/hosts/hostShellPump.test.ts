import {
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  type OrchestrationShellStreamItem,
} from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeReadModelThread, makeShellSnapshot } from "../storeTestFixtures";
import { createHostShellPump, type HostShellStatus } from "./hostShellPump";

const hostA = sshHostId("a1b2c3d4");

function snapshotItem(sequence: number, threadIds: string[] = ["thread-1"]) {
  const base = makeShellSnapshot(makeReadModelThread({ id: ThreadId.makeUnsafe("thread-1") }));
  return {
    kind: "snapshot",
    snapshot: {
      ...base,
      snapshotSequence: sequence,
      threads: threadIds.map((id) => ({
        ...base.threads[0]!,
        id: ThreadId.makeUnsafe(id),
        projectId: ProjectId.makeUnsafe("project-1"),
      })),
    },
  } as OrchestrationShellStreamItem;
}

function threadUpserted(sequence: number, id: string) {
  const base = snapshotItem(1).kind === "snapshot" ? snapshotItem(1) : null;
  const thread = (base as Extract<OrchestrationShellStreamItem, { kind: "snapshot" }>).snapshot
    .threads[0]!;
  return {
    kind: "thread-upserted",
    sequence,
    thread: { ...thread, id: ThreadId.makeUnsafe(id) },
  } as OrchestrationShellStreamItem;
}

async function setup() {
  vi.resetModules();
  const { createHostStore } = await import("../store");
  const store = createHostStore(hostA);
  let push: (item: OrchestrationShellStreamItem) => void = () => undefined;
  let state: (value: string) => void = () => undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async () => undefined);
  const statuses: HostShellStatus[] = [];
  const pump = createHostShellPump({
    store,
    transport: {
      subscribe: (_channel, listener) => {
        push = (data) => listener({ data });
        return unsubscribe;
      },
      request: request as never,
      onStateChange: (listener) => {
        state = listener;
        return () => undefined;
      },
    },
    onStatus: (status) => statuses.push(status),
  });
  const threadIds = () => store.getState().threadIds ?? [];
  return {
    store,
    pump,
    push: (i: OrchestrationShellStreamItem) => push(i),
    state: (v: string) => state(v),
    request,
    unsubscribe,
    statuses,
    threadIds,
  };
}

describe("createHostShellPump", () => {
  afterEach(() => vi.useRealTimers());

  it("starts the host's shell stream and reports connecting", async () => {
    const host = await setup();
    expect(host.request).toHaveBeenCalledWith(ORCHESTRATION_WS_METHODS.subscribeShell, {});
    expect(host.statuses).toEqual(["connecting"]);
  });

  it("applies the snapshot to the host's store and goes live", async () => {
    const host = await setup();
    host.push(snapshotItem(5));
    expect(host.threadIds()).toEqual(["thread-1"]);
    expect(host.store.getState().threadsHydrated).toBe(true);
    expect(host.statuses.at(-1)).toBe("live");
  });

  it("buffers events that arrive before the snapshot and drops the ones it already covers", async () => {
    const host = await setup();
    host.push(threadUpserted(4, "covered")); // at or below the snapshot: dropped
    host.push(threadUpserted(7, "after")); // newer: kept
    expect(host.threadIds()).toEqual([]);

    host.push(snapshotItem(5));
    expect(host.threadIds()).toEqual(expect.arrayContaining(["thread-1", "after"]));
    expect(host.threadIds()).not.toContain("covered");
  });

  it("applies live events after the snapshot and ignores replayed ones", async () => {
    const host = await setup();
    host.push(snapshotItem(5));
    host.push(threadUpserted(6, "live"));
    host.push(threadUpserted(6, "replayed"));
    host.push(threadUpserted(3, "old"));
    expect(host.threadIds()).toContain("live");
    expect(host.threadIds()).not.toContain("replayed");
    expect(host.threadIds()).not.toContain("old");
  });

  it("goes stale when the transport closes, and keeps the host's data", async () => {
    const host = await setup();
    host.push(snapshotItem(5));
    host.state("closed");
    expect(host.statuses.at(-1)).toBe("stale");
    expect(host.threadIds()).toEqual(["thread-1"]);
  });

  it("stops cleanly: nothing more is applied and the stored data stays", async () => {
    const host = await setup();
    host.push(snapshotItem(5));
    host.pump();
    host.push(threadUpserted(9, "late"));
    host.push(snapshotItem(12, []));
    expect(host.threadIds()).toEqual(["thread-1"]);
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    expect(host.statuses.at(-1)).toBe("stale");
  });

  it("reports a failed stream start as stale with the reason", async () => {
    vi.resetModules();
    const { createHostStore } = await import("../store");
    const messages: (string | undefined)[] = [];
    createHostShellPump({
      store: createHostStore(hostA),
      transport: {
        subscribe: () => () => undefined,
        request: (async () => {
          throw new Error("no stream");
        }) as never,
        onStateChange: () => () => undefined,
      },
      onStatus: (_status, message) => messages.push(message),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(messages.at(-1)).toBe("no stream");
  });
});
