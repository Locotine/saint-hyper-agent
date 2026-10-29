import { LOCAL_HOST_ID, scopeLocalProject, scopeProject, sshHostId } from "@saint/shared/hostId";
// FILE: pinnedProjectsStore.test.ts
// Purpose: Verifies the capped pinned-project store mutates ids predictably.
// Layer: UI state store test

import { beforeEach, describe, expect, it } from "vitest";
import { ProjectId } from "@saint/contracts";
import { usePinnedProjectsStore } from "./pinnedProjectsStore";

const p = (id: string) => scopeLocalProject(id as ProjectId);
const remote = scopeProject(sshHostId("a1b2c3d4"), "project-2" as ProjectId);

describe("usePinnedProjectsStore", () => {
  beforeEach(() => {
    usePinnedProjectsStore.setState({ pinnedProjectIds: [] });
  });

  it("pins newest project ids first and rejects a fourth pin", () => {
    expect(usePinnedProjectsStore.getState().pinProject(p("project-1"))).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject(p("project-2"))).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject(p("project-3"))).toBe(true);
    expect(usePinnedProjectsStore.getState().pinProject(p("project-4"))).toBe(false);

    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([
      p("project-3"),
      p("project-2"),
      p("project-1"),
    ]);
  });

  it("unpins and prunes project ids that are no longer present", () => {
    usePinnedProjectsStore.setState({
      pinnedProjectIds: [p("project-3"), p("project-2"), p("project-1"), remote],
    });

    usePinnedProjectsStore.getState().unpinProject(p("project-2"));
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([
      p("project-3"),
      p("project-1"),
      remote,
    ]);

    usePinnedProjectsStore
      .getState()
      .prunePinnedProjects(LOCAL_HOST_ID, ["project-1" as ProjectId]);
    // Another host's pin survives this computer's snapshot.
    expect(usePinnedProjectsStore.getState().pinnedProjectIds).toEqual([p("project-1"), remote]);
  });
});
