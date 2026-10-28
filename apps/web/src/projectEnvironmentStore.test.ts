import { scopeLocalProject } from "@saint/shared/hostId";
import { ProjectId } from "@saint/contracts";
import { assert, beforeEach, describe, expect, it } from "vitest";

import { useProjectEnvironmentStore } from "./projectEnvironmentStore";

const PROJECT_A = ProjectId.makeUnsafe("project-a");
const PROJECT_B = ProjectId.makeUnsafe("project-b");

describe("project environment preferences", () => {
  beforeEach(() => {
    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
  });

  it("remembers each project's latest choice independently", () => {
    const { setProjectEnvMode } = useProjectEnvironmentStore.getState();
    setProjectEnvMode(scopeLocalProject(PROJECT_A), "worktree");
    expect(
      useProjectEnvironmentStore.getState().envModeByProjectId[scopeLocalProject(PROJECT_B)],
    ).toBeUndefined();

    setProjectEnvMode(scopeLocalProject(PROJECT_B), "worktree");
    setProjectEnvMode(scopeLocalProject(PROJECT_A), "local");
    expect(useProjectEnvironmentStore.getState().envModeByProjectId).toEqual({
      [scopeLocalProject(PROJECT_A)]: "local",
      [scopeLocalProject(PROJECT_B)]: "worktree",
    });
  });

  it("restores both choices from persisted storage", async () => {
    const { setProjectEnvMode } = useProjectEnvironmentStore.getState();
    setProjectEnvMode(scopeLocalProject(PROJECT_A), "local");
    setProjectEnvMode(scopeLocalProject(PROJECT_B), "worktree");
    const { name, storage } = useProjectEnvironmentStore.persist.getOptions();
    assert(name);
    assert(storage);
    const saved = await storage.getItem(name);
    assert(saved);

    useProjectEnvironmentStore.setState({ envModeByProjectId: {} });
    await storage.setItem(name, saved);
    await useProjectEnvironmentStore.persist.rehydrate();

    expect(useProjectEnvironmentStore.getState().envModeByProjectId).toEqual({
      [scopeLocalProject(PROJECT_A)]: "local",
      [scopeLocalProject(PROJECT_B)]: "worktree",
    });
  });

  it("ignores invalid stored choices while preserving valid preferences", () => {
    const { merge } = useProjectEnvironmentStore.persist.getOptions();
    expect(
      merge!(
        // v1 rows use raw ids: they are read as this computer's projects.
        { envModeByProjectId: { [PROJECT_A]: "worktree", [PROJECT_B]: "invalid" } },
        useProjectEnvironmentStore.getState(),
      ).envModeByProjectId,
    ).toEqual({ [scopeLocalProject(PROJECT_A)]: "worktree" });
  });
});
