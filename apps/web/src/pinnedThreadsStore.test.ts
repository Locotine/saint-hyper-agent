// FILE: pinnedThreadsStore.test.ts
// Purpose: Verifies the global pinned-thread store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, scopeLocalThread, scopeThread, sshHostId } from "@saint/shared/hostId";
import { usePinnedThreadsStore } from "./pinnedThreadsStore";

describe("usePinnedThreadsStore", () => {
  beforeEach(() => {
    usePinnedThreadsStore.setState({ pinnedThreadIds: [] });
  });

  it("toggles a pinned thread id on and off", () => {
    const threadId = scopeLocalThread("thread-1" as ThreadId);
    usePinnedThreadsStore.getState().togglePinnedThread(threadId);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([threadId]);

    usePinnedThreadsStore.getState().togglePinnedThread(threadId);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([]);
  });

  it("prunes only the snapshot host's missing threads", () => {
    const remote = scopeThread(sshHostId("a1b2c3d4"), "thread-2" as ThreadId);
    usePinnedThreadsStore.setState({
      pinnedThreadIds: [
        scopeLocalThread("thread-2" as ThreadId),
        remote,
        scopeLocalThread("thread-1" as ThreadId),
      ],
    });

    usePinnedThreadsStore.getState().prunePinnedThreads(LOCAL_HOST_ID, ["thread-1" as ThreadId]);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([
      remote,
      scopeLocalThread("thread-1" as ThreadId),
    ]);
  });

  it("reads v1 raw ids as this computer's threads", () => {
    const merged = usePinnedThreadsStore.persist
      .getOptions()
      .merge?.({ pinnedThreadIds: ["thread-a"] }, usePinnedThreadsStore.getState());
    expect(merged?.pinnedThreadIds).toEqual([scopeLocalThread("thread-a" as ThreadId)]);
  });
});
