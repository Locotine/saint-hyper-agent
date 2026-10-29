// FILE: storeHostIsolation.test.ts
// Purpose: A remote host's store must not touch the process-wide state that belongs to this
//          computer: remembered project UI state (by cwd) and thread-detail resume cursors.

import { ProjectId, ThreadId } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getRememberedProjectUiState,
  projectCwdKey,
  rememberProjectState,
} from "./storePersistence";
import { syncServerShellSnapshot } from "./storeProjection";
import { initialState, type AppState } from "./storeState";
import { makeProject, makeReadModelThread, makeShellSnapshot } from "./storeTestFixtures";
import {
  hasThreadDetailResumeCursor,
  resetThreadDetailResumeCursorsForTests,
  setThreadDetailResumeCursor,
} from "./threadDetailResumeCursors";

const remoteState: AppState = { ...initialState, hostId: sshHostId("a1b2c3d4") };
const localThreadId = ThreadId.makeUnsafe("local-thread");

/** A snapshot of one remote project at `workspaceRoot` with one thread. */
function remoteSnapshot(workspaceRoot: string) {
  const snapshot = makeShellSnapshot(
    makeReadModelThread({ id: ThreadId.makeUnsafe("remote-thread") }),
  );
  return {
    ...snapshot,
    snapshotSequence: 10,
    projects: snapshot.projects.map((project) => ({
      ...project,
      id: ProjectId.makeUnsafe("remote-project"),
      workspaceRoot,
    })),
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      projectId: ProjectId.makeUnsafe("remote-project"),
    })),
  };
}

describe("remote host store isolation", () => {
  beforeEach(() => {
    resetThreadDetailResumeCursorsForTests();
    // Forget whatever earlier tests remembered, then remember one local project.
    rememberProjectState([]);
  });

  it("keeps this computer's remembered project UI state when a remote snapshot arrives", () => {
    const localCwd = "/tmp/local-only";
    rememberProjectState([makeProject({ cwd: localCwd, localName: "Mine", expanded: true })]);

    syncServerShellSnapshot(remoteState, remoteSnapshot("/srv/other"));

    const remembered = getRememberedProjectUiState();
    expect(remembered.projectNameForCwd(projectCwdKey(localCwd))).toBe("Mine");
    expect(remembered.isProjectExpanded(projectCwdKey(localCwd))).toBe(true);
  });

  it("does not lend this computer's remembered name to a remote project at the same path", () => {
    rememberProjectState([makeProject({ cwd: "/srv/shared-path", localName: "Mine" })]);

    const next = syncServerShellSnapshot(remoteState, remoteSnapshot("/srv/shared-path"));

    expect(next.projects.map((project) => project.localName)).toEqual([null]);
    // And the remote project is not remembered for this computer either.
    expect(getRememberedProjectUiState().projectNameForCwd(projectCwdKey("/srv/shared-path"))).toBe(
      "Mine",
    );
  });

  it("keeps this computer's thread resume cursors when a remote snapshot arrives", () => {
    setThreadDetailResumeCursor(localThreadId, 9);

    syncServerShellSnapshot(remoteState, remoteSnapshot("/srv/other"));

    expect(hasThreadDetailResumeCursor(localThreadId)).toBe(true);
  });

  it("still prunes resume cursors for a local snapshot (behavior unchanged)", () => {
    setThreadDetailResumeCursor(localThreadId, 9);

    syncServerShellSnapshot({ ...initialState }, remoteSnapshot("/srv/other"));

    expect(hasThreadDetailResumeCursor(localThreadId)).toBe(false);
  });
});
