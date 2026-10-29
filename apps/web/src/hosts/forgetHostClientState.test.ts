import { ProjectId, ThreadId } from "@saint/contracts";
import {
  LOCAL_HOST_ID,
  scopeLocalProject,
  scopeLocalThread,
  scopeProject,
  scopeThread,
  sshHostId,
} from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { useDiffRenderModeStore } from "../diffRenderModeStore";
import { usePinnedProjectsStore } from "../pinnedProjectsStore";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { useRecentViewsStore } from "../recentViewsStore";
import { useSplitViewStore } from "../splitViewStore";
import { forgetHostClientState } from "./forgetHostClientState";

const HOST = sshHostId("a1b2c3d4");
const OTHER_HOST = sshHostId("0f0f0f0f");
const RAW_THREAD = ThreadId.makeUnsafe("thread-1");
const RAW_PROJECT = ProjectId.makeUnsafe("project-1");

describe("forgetHostClientState", () => {
  it("drops the forgotten host's state and keeps this computer's and other hosts'", () => {
    const local = scopeLocalThread(RAW_THREAD);
    const forgotten = scopeThread(HOST, RAW_THREAD);
    const other = scopeThread(OTHER_HOST, RAW_THREAD);
    useComposerDraftStore.getState().setPrompt(local, "local draft");
    useComposerDraftStore.getState().setPrompt(forgotten, "remote draft");
    usePinnedThreadsStore.setState({ pinnedThreadIds: [local, forgotten, other] });
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [scopeLocalProject(RAW_PROJECT), scopeProject(HOST, RAW_PROJECT)],
    });
    useDiffRenderModeStore.setState({ modeByThreadId: { [local]: "split", [forgotten]: "split" } });
    useRecentViewsStore.setState({
      recentViews: [
        { kind: "thread", threadId: forgotten },
        { kind: "thread", threadId: local },
        { kind: "settings" },
      ],
    });
    const remoteSplitId = useSplitViewStore.getState().createFromThread({
      hostId: HOST,
      sourceThreadId: RAW_THREAD,
      ownerProjectId: RAW_PROJECT,
    });
    const localSplitId = useSplitViewStore.getState().createFromThread({
      hostId: LOCAL_HOST_ID,
      sourceThreadId: RAW_THREAD,
      ownerProjectId: RAW_PROJECT,
    });
    expect(remoteSplitId).not.toBe(localSplitId);

    forgetHostClientState(HOST);

    expect(useComposerDraftStore.getState().draftsByThreadId[local]?.prompt).toBe("local draft");
    expect(useComposerDraftStore.getState().draftsByThreadId[forgotten]).toBeUndefined();
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([local, other]);
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([
      scopeLocalProject(RAW_PROJECT),
    ]);
    expect(useDiffRenderModeStore.getState().modeByThreadId).toEqual({ [local]: "split" });
    expect(useRecentViewsStore.getState().recentViews).toEqual([
      { kind: "thread", threadId: local },
      { kind: "settings" },
    ]);
    expect(Object.keys(useSplitViewStore.getState().splitViewsById)).toEqual([localSplitId]);
    expect(useSplitViewStore.getState().splitViewIdBySourceThreadId).toEqual({
      [local]: localSplitId,
    });
  });

  it("never clears this computer's state", () => {
    const local = scopeLocalThread(RAW_THREAD);
    usePinnedThreadsStore.setState({ pinnedThreadIds: [local] });
    forgetHostClientState(LOCAL_HOST_ID);
    expect(usePinnedThreadsStore.getState().pinnedThreadIds).toEqual([local]);
  });
});
