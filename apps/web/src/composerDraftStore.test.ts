import { LOCAL_HOST_ID, scopeLocalThread } from "@saint/shared/hostId";
import { ProjectId, ThreadId } from "@saint/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectComposerThreadDraft } from "./composerDraftDomain";
import { runComposerSendOnce } from "./lib/composerSendOwnership";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("composerDraftStore stable empty draft identity", () => {
  it("reuses the empty draft sentinel across unrelated store updates", () => {
    resetComposerDraftStore();
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");
    const otherThreadId = ThreadId.makeUnsafe("thread-other");
    const before = selectComposerThreadDraft(
      useComposerDraftStore.getState(),
      scopeLocalThread(missingThreadId),
    );

    useComposerDraftStore.getState().setPrompt(scopeLocalThread(otherThreadId), "unrelated");

    const after = selectComposerThreadDraft(
      useComposerDraftStore.getState(),
      scopeLocalThread(missingThreadId),
    );
    expect(after).toBe(before);
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("revokes blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-clear",
      previewUrl: "blob:clear",
    });
    useComposerDraftStore.getState().addImage(scopeLocalThread(threadId), first);

    useComposerDraftStore.getState().clearComposerContent(scopeLocalThread(threadId));

    const draft = useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)];
    expect(draft).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
  });

  it("can preserve blob preview URLs for optimistic message handoff", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(scopeLocalThread(threadId), first);

    useComposerDraftStore
      .getState()
      .clearComposerContent(scopeLocalThread(threadId), { preservePreviewUrls: true });

    const draft = useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(scopeLocalThread(threadId))).toBeNull();

    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId: scopeLocalThread(threadId),
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toEqual({
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
  });

  it("preserves untouched thread draft identity across unrelated thread updates", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(scopeLocalThread(threadId), "thread a");
    store.setPrompt(scopeLocalThread(otherThreadId), "thread b");
    const threadADraft =
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)];

    useComposerDraftStore.getState().setPrompt(scopeLocalThread(otherThreadId), "thread b updated");

    expect(useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]).toBe(
      threadADraft,
    );
  });

  it("tracks temporary draft metadata and lets context updates clear it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), { isTemporary: true });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.isTemporary,
    ).toBe(true);

    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "feature/preserve-temp",
    });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.isTemporary,
    ).toBe(true);

    store.setDraftThreadContext(scopeLocalThread(threadId), { isTemporary: false });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.isTemporary,
    ).toBeUndefined();
  });

  it("stages, trims, and clears a draft goal via context updates", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {});
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.goal,
    ).toBeUndefined();

    store.setDraftThreadContext(scopeLocalThread(threadId), { goal: "  ship the snake game  " });
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.goal).toBe(
      "ship the snake game",
    );

    // Unrelated context updates keep the staged goal.
    store.setDraftThreadContext(scopeLocalThread(threadId), { branch: "feature/goal" });
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.goal).toBe(
      "ship the snake game",
    );

    store.setDraftThreadContext(scopeLocalThread(threadId), { goal: "" });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.goal,
    ).toBeUndefined();
  });

  it("registers a mapping-less temporary terminal draft for staged navigation", () => {
    const store = useComposerDraftStore.getState();

    store.registerDraftThread(scopeLocalThread(threadId), {
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
    ).toMatchObject({
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal")).toBe(
      null,
    );
  });

  it("tracks chat and terminal draft threads independently for the same project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), { entryPoint: "chat" });
    store.setProjectDraftThreadId(projectId, scopeLocalThread(otherThreadId), {
      entryPoint: "terminal",
    });

    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "chat"),
    ).toMatchObject({
      threadId: scopeLocalThread(threadId),
      projectId,
      entryPoint: "chat",
    });
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal"),
    ).toMatchObject({
      threadId: scopeLocalThread(otherThreadId),
      projectId,
      entryPoint: "terminal",
    });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.entryPoint,
    ).toBe("chat");
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(otherThreadId))?.entryPoint,
    ).toBe("terminal");
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "hello");

    store.clearProjectDraftThreadById(projectId, scopeLocalThread(otherThreadId));
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      scopeLocalThread(threadId),
    );

    store.clearProjectDraftThreadById(projectId, scopeLocalThread(threadId));
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a draft by project and thread id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.enqueueQueuedTurn(
      scopeLocalThread(threadId),
      makeQueuedChatTurn(
        "queued-project-delete",
        makeImage({ id: "queued-image-delete", previewUrl: "blob:queued-project-delete" }),
      ),
    );

    store.clearProjectDraftThreadById(projectId, scopeLocalThread(threadId));

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-delete");
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "orphan me");

    store.setProjectDraftThreadId(projectId, scopeLocalThread(otherThreadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      scopeLocalThread(otherThreadId),
    );
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
  });

  it("keeps a promoted task's retry prompt when another draft takes its project slot", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "retry failed preparation");
    store.markDraftThreadPromoting(scopeLocalThread(threadId));
    store.setProjectDraftThreadId(projectId, scopeLocalThread(otherThreadId));
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
    ).toBe("retry failed preparation");
    store.finalizePromotedDraftThread(scopeLocalThread(threadId));
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
  });

  it("keeps a sending draft and its attachments when a new draft takes the project slot", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "retryable prompt");
    store.enqueueQueuedTurn(
      scopeLocalThread(threadId),
      makeQueuedChatTurn(
        "sending-kept-thread",
        makeImage({ id: "sending-image", previewUrl: "blob:sending" }),
      ),
    );
    await runComposerSendOnce(threadId, async () => {
      store.setProjectDraftThreadId(projectId, scopeLocalThread(otherThreadId));
      expect(
        useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
      ).not.toBeNull();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
      ).toBe("retryable prompt");
      expect(revokeSpy).not.toHaveBeenCalledWith("blob:sending");
      expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
        scopeLocalThread(otherThreadId),
      );
      return false;
    });
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
    ).not.toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.queuedTurns,
    ).toHaveLength(1);
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setProjectDraftThreadId(otherProjectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "keep me");
    store.enqueueQueuedTurn(
      scopeLocalThread(threadId),
      makeQueuedChatTurn(
        "queued-kept-thread",
        makeImage({ id: "queued-image-kept", previewUrl: "blob:queued-kept-thread" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(scopeLocalThread(threadId));
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
    ).toBe("keep me");
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.queuedTurns,
    ).toHaveLength(1);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:queued-kept-thread");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "remove me");
    store.clearDraftThread(scopeLocalThread(threadId));
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
  });

  it("retires promoted draft registration without discarding newer composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "keep me while server thread hydrates");

    markPromotedDraftThreads(LOCAL_HOST_ID, new Set([threadId]));

    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))?.promotedTo,
    ).toBe(scopeLocalThread(threadId));
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
    ).toBe("keep me while server thread hydrates");

    // The send owner consumes the captured prompt; subsequent edits belong to the server task.
    store.clearComposerContent(scopeLocalThread(threadId));
    store.setPrompt(scopeLocalThread(threadId), "newer unsent edit");
    store.addImage(
      scopeLocalThread(threadId),
      makeImage({ id: "newer-image", previewUrl: "blob:newer" }),
    );
    store.enqueueQueuedTurn(scopeLocalThread(threadId), makeQueuedChatTurn("newer-queued-turn"));
    const currentDraft =
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)];

    finalizePromotedDraftThreads(LOCAL_HOST_ID, new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId))).toBeNull();
    expect(
      useComposerDraftStore.getState().projectDraftThreadIdByProjectId[projectId],
    ).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]).toBe(
      currentDraft,
    );
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:newer");
    store.finalizePromotedDraftThread(scopeLocalThread(threadId));
    expect(useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]).toBe(
      currentDraft,
    );
    store.clearDraftThread(scopeLocalThread(threadId));
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:newer");
  });

  it.each([true, false])(
    "preserves explicit Computer choice %s when a draft becomes a server thread",
    (enabled) => {
      const store = useComposerDraftStore.getState();
      store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId));
      store.setPrompt(scopeLocalThread(threadId), "already sent");
      store.setEnableComputerControl(scopeLocalThread(threadId), enabled);
      store.clearComposerContent(scopeLocalThread(threadId));

      markPromotedDraftThreads(LOCAL_HOST_ID, new Set([threadId]));
      finalizePromotedDraftThreads(LOCAL_HOST_ID, new Set([threadId]));

      const promoted = useComposerDraftStore.getState();
      expect(promoted.getDraftThread(scopeLocalThread(threadId))).toBeNull();
      expect(promoted.draftsByThreadId[scopeLocalThread(threadId)]?.prompt).toBe("");
      expect(promoted.draftsByThreadId[scopeLocalThread(threadId)]?.enableComputerControl).toBe(
        enabled,
      );
      promoted.finalizePromotedDraftThread(scopeLocalThread(threadId));
      expect(
        useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]
          ?.enableComputerControl,
      ).toBe(enabled);

      promoted.clearDraftThread(scopeLocalThread(threadId));
      expect(
        useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
      ).toBeUndefined();
    },
  );

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(scopeLocalThread(threadId), {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      scopeLocalThread(threadId),
    );
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
    ).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("moves an empty draft to another project while preserving composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(scopeLocalThread(threadId), "keep this draft");

    store.moveDraftThreadToProject(scopeLocalThread(threadId), otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId: scopeLocalThread(threadId),
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
    ).toBe("keep this draft");
  });

  it("clears the replaced target draft when moving a draft to another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(scopeLocalThread(threadId), "move this draft");
    store.setProjectDraftThreadId(otherProjectId, scopeLocalThread(otherThreadId));
    store.setPrompt(scopeLocalThread(otherThreadId), "replace this draft");
    store.enqueueQueuedTurn(
      scopeLocalThread(otherThreadId),
      makeQueuedChatTurn(
        "queued-target-replaced",
        makeImage({ id: "queued-target-replaced", previewUrl: "blob:queued-target-replaced" }),
      ),
    );

    store.moveDraftThreadToProject(scopeLocalThread(threadId), otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId: scopeLocalThread(threadId),
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.prompt,
    ).toBe("move this draft");
    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(otherThreadId)),
    ).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(otherThreadId)],
    ).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-target-replaced");
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), runtimeUndefinedOptions);

    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
    ).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, scopeLocalThread(threadId), runtimeUndefinedOptions);

    expect(
      useComposerDraftStore.getState().getDraftThread(scopeLocalThread(threadId)),
    ).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores AI-reviewed auto mode in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(scopeLocalThread(threadId), "auto");

    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]?.runtimeMode,
    ).toBe("auto");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(scopeLocalThread(threadId), "debug");

    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)]
        ?.interactionMode,
    ).toBe("debug");
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(scopeLocalThread(threadId), "approval-required");
    store.setInteractionMode(scopeLocalThread(threadId), "plan");
    store.setRuntimeMode(scopeLocalThread(threadId), null);
    store.setInteractionMode(scopeLocalThread(threadId), null);

    expect(
      useComposerDraftStore.getState().draftsByThreadId[scopeLocalThread(threadId)],
    ).toBeUndefined();
  });
});
