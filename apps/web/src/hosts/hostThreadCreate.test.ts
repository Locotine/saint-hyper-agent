import { ProjectId } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn(async () => undefined);
vi.mock("./hostScope", () => ({
  hostHandle: () => ({ requireApi: () => ({ orchestration: { dispatchCommand } }) }),
}));

import { renameHostProject, setHostProjectPinned } from "./hostThreadCreate";

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
