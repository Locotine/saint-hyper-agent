import { ProjectId, ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PERSISTED_STATE_KEY } from "../storePersistence";
import { makeFakeWindow, makeReadModelThread, makeShellSnapshot } from "../storeTestFixtures";
import { collectHostProjects } from "./hostStores";

const hostA = sshHostId("a1b2c3d4");
const hostB = sshHostId("b2c3d4e5");

/** The same raw ids on every host, as two servers would hand out. */
function snapshotAt(workspaceRoot: string, title: string, sequence = 5) {
  const snapshot = makeShellSnapshot(makeReadModelThread({ id: ThreadId.makeUnsafe("thread-1") }));
  return {
    ...snapshot,
    snapshotSequence: sequence,
    projects: snapshot.projects.map((project) => ({
      ...project,
      id: ProjectId.makeUnsafe("project-1"),
      title,
      workspaceRoot,
    })),
  };
}

async function freshRegistry() {
  vi.resetModules();
  const { createHostStore, useStore } = await import("../store");
  const { createHostStoreRegistry: create } = await import("./hostStores");
  return { registry: create(useStore, createHostStore), useStore };
}

describe("hostStores", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves this computer's own store for the local host and one store per remote host", async () => {
    const { registry, useStore } = await freshRegistry();
    expect(registry.get(LOCAL_HOST_ID)).toBe(useStore);
    const a = registry.get(hostA);
    expect(a).not.toBe(useStore);
    expect(registry.get(hostA)).toBe(a);
    expect(a.getState().hostId).toBe(hostA);
    expect(registry.hostIds()).toEqual([LOCAL_HOST_ID, hostA]);
  });

  it("keeps hosts apart: a snapshot on one never touches another", async () => {
    const { registry, useStore } = await freshRegistry();
    registry.get(hostA).getState().syncServerShellSnapshot(snapshotAt("/srv/a", "On A"));

    expect(
      registry
        .get(hostA)
        .getState()
        .projects.map((p) => p.name),
    ).toEqual(["On A"]);
    expect(registry.get(hostB).getState().projects).toEqual([]);
    expect(useStore.getState().projects).toEqual([]);
  });

  it("lists two hosts' projects that share a raw id as two rows", async () => {
    const { registry } = await freshRegistry();
    registry.get(hostA).getState().syncServerShellSnapshot(snapshotAt("/srv/a", "On A"));
    registry.get(hostB).getState().syncServerShellSnapshot(snapshotAt("/srv/b", "On B"));

    const rows = collectHostProjects(registry);
    expect(rows.map((row) => [row.hostId, row.project.id, row.project.name])).toEqual([
      [hostA, "project-1", "On A"],
      [hostB, "project-1", "On B"],
    ]);
  });

  it("returns the same aggregate until a host's projects change", async () => {
    const { registry } = await freshRegistry();
    const store = registry.get(hostA);
    store.getState().syncServerShellSnapshot(snapshotAt("/srv/a", "On A"));
    const first = registry.projectsSnapshot();
    expect(registry.projectsSnapshot()).toBe(first);

    store.getState().syncServerShellSnapshot(snapshotAt("/srv/a", "Renamed", 6));
    const second = registry.projectsSnapshot();
    expect(second).not.toBe(first);
    expect(second.map((row) => row.project.name)).toEqual(["Renamed"]);
  });

  it("notifies subscribers when a host joins, changes or is removed", async () => {
    const { registry } = await freshRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    const store = registry.get(hostA);
    expect(listener).toHaveBeenCalledTimes(1);
    store.getState().syncServerShellSnapshot(snapshotAt("/srv/a", "On A"));
    expect(listener.mock.calls.length).toBeGreaterThan(1);

    const before = listener.mock.calls.length;
    registry.remove(hostA);
    expect(listener.mock.calls.length).toBe(before + 1);
    expect(registry.hostIds()).toEqual([LOCAL_HOST_ID]);
    store.getState().syncServerShellSnapshot(snapshotAt("/srv/a", "Late", 9));
    expect(listener.mock.calls.length).toBe(before + 1);

    unsubscribe();
  });

  it("tracks each host's stream status, notifies on change, and forgets it on removal", async () => {
    const { registry } = await freshRegistry();
    expect(registry.status(hostA)).toEqual({ status: "stale" });
    const listener = vi.fn();
    registry.subscribe(listener);

    registry.setStatus(hostA, "live");
    expect(registry.status(hostA)).toEqual({ status: "live" });
    const first = registry.status(hostA);
    registry.setStatus(hostA, "live");
    expect(registry.status(hostA)).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.setStatus(hostA, "stale", "tunnel closed");
    expect(registry.status(hostA)).toEqual({ status: "stale", message: "tunnel closed" });

    registry.get(hostA);
    registry.remove(hostA);
    expect(registry.status(hostA)).toEqual({ status: "stale" });
  });

  it("never removes this computer's store", async () => {
    const { registry, useStore } = await freshRegistry();
    registry.remove(LOCAL_HOST_ID);
    expect(registry.get(LOCAL_HOST_ID)).toBe(useStore);
  });

  it("does not persist a remote host's store or read this computer's saved state into it", async () => {
    const storage = new Map<string, string>();
    storage.set(
      PERSISTED_STATE_KEY,
      JSON.stringify({ version: 8, projectNamesByCwd: { "/srv/a": "Mine" } }),
    );
    vi.stubGlobal("window", makeFakeWindow(storage));
    const { registry } = await freshRegistry();
    const before = storage.get(PERSISTED_STATE_KEY);

    const store = registry.get(hostA);
    store.getState().syncServerShellSnapshot(snapshotAt("/srv/a", "On A"));
    const projectId = store.getState().projects[0]!.id;
    store.getState().renameProjectLocally(projectId, "Remote rename");
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(storage.get(PERSISTED_STATE_KEY)).toBe(before);
    expect(store.getState().projects[0]?.localName).toBe("Remote rename");
  });
});
