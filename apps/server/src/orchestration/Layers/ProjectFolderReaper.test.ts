import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectId } from "@saint/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { folderState, projectsToReap, type FolderState } from "./ProjectFolderReaper";

const base = mkdtempSync(path.join(os.tmpdir(), "saint-reaper-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const project = (id: string, kind: string, deletedAt: string | null = null) =>
  ({ id: ProjectId.makeUnsafe(id), kind, deletedAt }) as never;

describe("project folder reaper", () => {
  it("tells a deleted folder from an unmounted volume", async () => {
    expect(await folderState(base)).toBe("present");
    expect(await folderState(path.join(base, "gone"))).toBe("missing");
    expect(await folderState(path.join(base, "no-parent", "gone"))).toBe("unknown");
  });

  it("removes only folder projects missing on two sweeps in a row", () => {
    const a = ProjectId.makeUnsafe("a");
    const states = new Map<ProjectId, FolderState>([
      [a, "missing"],
      [ProjectId.makeUnsafe("b"), "missing"],
      [ProjectId.makeUnsafe("chat"), "missing"],
      [ProjectId.makeUnsafe("c"), "unknown"],
    ]);
    const readModel = {
      projects: [
        project("a", "project"),
        project("b", "project"),
        project("chat", "chat"),
        project("c", "project"),
      ],
    };
    expect(
      projectsToReap({
        readModel,
        states,
        missingBefore: new Set([a, ProjectId.makeUnsafe("chat"), ProjectId.makeUnsafe("c")]),
      }),
    ).toEqual([a]);
  });
});
