import { ProjectId, ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  hostId: "" as string,
  handleNewThread: vi.fn(),
  startContainerChat: vi.fn(),
}));

vi.mock("../hosts/hostScope", () => ({ useHostId: () => harness.hostId }));
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (select: (state: object) => unknown) =>
    select({ homeDir: "/home/me", chatWorkspaceRoot: null }),
}));
vi.mock("./useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: harness.handleNewThread }),
}));
vi.mock("../lib/chatProjects", () => ({ ensureHomeChatProject: vi.fn() }));
vi.mock("../lib/startContainerChat", () => ({ startContainerChat: harness.startContainerChat }));

import { useHandleNewChat } from "./useHandleNewChat";

const HOST_PROJECT = ProjectId.makeUnsafe("host-project");
const NEW_THREAD = ThreadId.makeUnsafe("new-thread");

describe("useHandleNewChat", () => {
  beforeEach(() => {
    harness.handleNewThread.mockReset().mockResolvedValue(NEW_THREAD);
    harness.startContainerChat.mockReset().mockResolvedValue({ ok: true, threadId: NEW_THREAD });
  });

  it("opens a remote chat's new chat in the given project on its host", async () => {
    harness.hostId = "ssh:devbox" as HostId;
    const { handleNewChat } = useHandleNewChat();

    await expect(handleNewChat({ hostProjectId: HOST_PROJECT })).resolves.toEqual({
      ok: true,
      threadId: NEW_THREAD,
    });
    expect(harness.handleNewThread).toHaveBeenCalledWith(HOST_PROJECT);
    // Never this computer's home chat.
    expect(harness.startContainerChat).not.toHaveBeenCalled();
  });

  it("refuses a remote new chat without a host project instead of opening one locally", async () => {
    harness.hostId = "ssh:devbox" as HostId;
    const { handleNewChat } = useHandleNewChat();

    const result = await handleNewChat();
    expect(result.ok).toBe(false);
    expect(harness.handleNewThread).not.toHaveBeenCalled();
    expect(harness.startContainerChat).not.toHaveBeenCalled();
  });

  it("opens this computer's new chat in the home chat, ignoring a host project", async () => {
    harness.hostId = LOCAL_HOST_ID;
    const { handleNewChat } = useHandleNewChat();

    await handleNewChat({ hostProjectId: HOST_PROJECT });
    expect(harness.startContainerChat).toHaveBeenCalledTimes(1);
    expect(harness.handleNewThread).not.toHaveBeenCalled();
  });
});
