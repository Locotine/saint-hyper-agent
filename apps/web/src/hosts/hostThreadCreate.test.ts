import { ProjectId, ThreadId } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn(async () => undefined);
vi.mock("./hostScope", () => ({
  hostHandle: () => ({ requireApi: () => ({ orchestration: { dispatchCommand } }) }),
}));

import { renameHostProject, setHostProjectPinned, updateHostThreadMeta } from "./hostThreadCreate";

const hostId = sshHostId("a1b2c3d4");
const projectId = ProjectId.makeUnsafe("project-1");

describe("host project commands", () => {
  it("renames a project on the host through project.meta.update", async () => {
    await renameHostProject(hostId, projectId, "Renamed");
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId, title: "Renamed" }),
    );
  });

  it("pins and unpins a project on the host", async () => {
    await setHostProjectPinned(hostId, projectId, true);
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "project.meta.update", projectId, isPinned: true }),
    );
    await setHostProjectPinned(hostId, projectId, false);
    expect(dispatchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ isPinned: false }));
  });
});

describe("host thread commands", () => {
  it("renames and pins a thread on the host through thread.meta.update", async () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    await updateHostThreadMeta(hostId, threadId, { title: "Renamed" });
    expect(dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "thread.meta.update", threadId, title: "Renamed" }),
    );
    await updateHostThreadMeta(hostId, threadId, { isPinned: true });
    expect(dispatchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ isPinned: true }));
  });
});
