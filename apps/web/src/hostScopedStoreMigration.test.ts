// FILE: hostScopedStoreMigration.test.ts
// Purpose: Pins that v1 rows (raw ids) of the smaller host-scoped stores hydrate as this
//          computer's threads and projects.
// Layer: UI state store test

import { ProjectId, ThreadId } from "@saint/contracts";
import { scopeLocalProject, scopeLocalThread } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { useLatestProjectStore } from "./latestProjectStore";
import { useProjectInstructionsStore } from "./projectInstructionsStore";
import { useRecentViewsStore } from "./recentViewsStore";

const RAW_THREAD = ThreadId.makeUnsafe("thread-v1");
const RAW_PROJECT = ProjectId.makeUnsafe("project-v1");

describe("host-scoped store migration", () => {
  it("reads a v1 latest project as this computer's", () => {
    const merged = useLatestProjectStore.persist
      .getOptions()
      .merge?.({ latestProjectId: RAW_PROJECT }, useLatestProjectStore.getState());
    expect(merged?.latestProjectId).toBe(scopeLocalProject(RAW_PROJECT));
  });

  it("reads v1 recent thread views as this computer's", () => {
    const merged = useRecentViewsStore.persist
      .getOptions()
      .merge?.(
        { recentViews: [{ kind: "thread", threadId: RAW_THREAD }, { kind: "plugins" }] },
        useRecentViewsStore.getState(),
      );
    expect(merged?.recentViews).toEqual([
      { kind: "thread", threadId: scopeLocalThread(RAW_THREAD) },
      { kind: "plugins" },
    ]);
  });

  it("reads v1 project instructions as this computer's and drops non-string rows", () => {
    const merged = useProjectInstructionsStore.persist
      .getOptions()
      .merge?.(
        { instructionsByProjectId: { [RAW_PROJECT]: "Use bun", broken: 42 } },
        useProjectInstructionsStore.getState(),
      );
    expect(merged?.instructionsByProjectId).toEqual({
      [scopeLocalProject(RAW_PROJECT)]: "Use bun",
    });
  });
});
