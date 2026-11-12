import { ProjectId, ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { resolveRouteChatSurface } from "./splitViewRoute";
import type { SplitView } from "./splitViewStore";

const THREAD = ThreadId.makeUnsafe("thread-a");
const splitView: SplitView = {
  id: "split-1",
  hostId: LOCAL_HOST_ID,
  sourceThreadId: THREAD,
  ownerProjectId: ProjectId.makeUnsafe("project-1"),
  focusedPaneId: "pane-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  root: {
    kind: "leaf",
    id: "pane-1",
    threadId: THREAD,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser",
    },
  },
};

describe("resolveRouteChatSurface", () => {
  it("holds a split route until the persisted splits load, instead of flashing one chat", () => {
    expect(
      resolveRouteChatSurface({
        search: { splitViewId: "split-1" },
        splitView: null,
        splitViewsHydrated: false,
      }),
    ).toBe("hold");
  });

  it("shows the split once loaded, or one chat when that split is gone", () => {
    const search = { splitViewId: "split-1" };
    expect(resolveRouteChatSurface({ search, splitView, splitViewsHydrated: true })).toBe("split");
    expect(resolveRouteChatSurface({ search, splitView: null, splitViewsHydrated: true })).toBe(
      "single",
    );
  });

  it("shows a plain route's chat without waiting", () => {
    expect(
      resolveRouteChatSurface({ search: {}, splitView: null, splitViewsHydrated: false }),
    ).toBe("single");
  });
});
