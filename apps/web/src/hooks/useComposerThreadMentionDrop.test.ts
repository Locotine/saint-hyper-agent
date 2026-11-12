import { ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { isThreadDragTransfer, readThreadDragPayload, THREAD_DRAG_MIME } from "~/lib/threadDrag";
import { canDropThreadMention } from "./useComposerThreadMentionDrop";

const CURRENT = ThreadId.makeUnsafe("thread-current");
const OTHER = ThreadId.makeUnsafe("thread-other");

describe("canDropThreadMention", () => {
  it("accepts another chat and an unknown drag source", () => {
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: OTHER }),
    ).toBe(true);
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: null }),
    ).toBe(true);
  });

  it("rejects the chat's own row and a disabled composer", () => {
    expect(
      canDropThreadMention({ disabled: false, currentThreadId: CURRENT, draggedThreadId: CURRENT }),
    ).toBe(false);
    expect(
      canDropThreadMention({ disabled: true, currentThreadId: CURRENT, draggedThreadId: OTHER }),
    ).toBe(false);
  });
});

describe("thread drag transfer", () => {
  it("detects the thread MIME and ignores file drags", () => {
    expect(isThreadDragTransfer({ types: [THREAD_DRAG_MIME] })).toBe(true);
    expect(isThreadDragTransfer({ types: ["Files"] })).toBe(false);
  });

  it("parses a valid payload and rejects malformed data", () => {
    expect(readThreadDragPayload({ getData: () => JSON.stringify({ threadId: OTHER }) })).toEqual({
      threadId: OTHER,
      hostId: LOCAL_HOST_ID,
    });
    const remote = sshHostId("0a1b2c3d");
    expect(
      readThreadDragPayload({ getData: () => JSON.stringify({ threadId: OTHER, hostId: remote }) }),
    ).toEqual({ threadId: OTHER, hostId: remote });
    expect(
      readThreadDragPayload({
        getData: () => JSON.stringify({ threadId: OTHER, hostId: "bogus" }),
      }),
    ).toEqual({ threadId: OTHER, hostId: LOCAL_HOST_ID });
    expect(readThreadDragPayload({ getData: () => "" })).toBeNull();
    expect(readThreadDragPayload({ getData: () => "{not json" })).toBeNull();
    expect(readThreadDragPayload({ getData: () => JSON.stringify({ threadId: 7 }) })).toBeNull();
  });
});
