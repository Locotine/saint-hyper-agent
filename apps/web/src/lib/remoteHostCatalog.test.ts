import type { DesktopRemoteSshHostState, OrchestrationShellSnapshot } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import { syncServerShellSnapshot } from "../storeProjection";
import { initialState } from "../storeState";
import { makeReadModelThread, makeShellSnapshot } from "../storeTestFixtures";
import {
  REMOTE_CATALOG_THREAD_LIMIT,
  buildRemoteCatalogFromState,
  buildRemoteCatalogProjects,
  remoteHostSidebarStatus,
} from "./remoteHostCatalog";

type ShellProject = OrchestrationShellSnapshot["projects"][number];
type ShellThread = OrchestrationShellSnapshot["threads"][number];

const project = (id: string, title: string, kind: ShellProject["kind"] = "project") =>
  ({ id, title, kind, workspaceRoot: `/srv/${id}` }) as unknown as ShellProject;

const thread = (id: string, projectId: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    projectId,
    title: `thread ${id}`,
    updatedAt: `2026-10-28T10:00:${id.padStart(2, "0")}.000Z`,
    archivedAt: null,
    parentThreadId: null,
    session: null,
    ...extra,
  }) as unknown as ShellThread;

const snapshot = (projects: ShellProject[], threads: ShellThread[]): OrchestrationShellSnapshot =>
  ({ projects, threads, spaces: [], snapshotSequence: 1 }) as unknown as OrchestrationShellSnapshot;

describe("buildRemoteCatalogProjects", () => {
  it("lists pinned projects first", () => {
    const pinned = { ...project("b", "Beta"), isPinned: true } as ShellProject;
    const result = buildRemoteCatalogProjects(snapshot([project("a", "Alpha"), pinned], []));
    expect(result.map((entry) => entry.title)).toEqual(["Beta", "Alpha"]);
    expect(result[0]?.isPinned).toBe(true);
  });

  it("lists standard projects by title with newest threads first", () => {
    const result = buildRemoteCatalogProjects(
      snapshot(
        [project("b", "Beta"), project("a", "Alpha"), project("c", "Chats", "chat")],
        [thread("10", "a"), thread("30", "a"), thread("20", "a"), thread("11", "b")],
      ),
    );
    expect(result.map((entry) => entry.title)).toEqual(["Alpha", "Beta"]);
    expect(result[0]?.threads.map((entry) => entry.id)).toEqual(["30", "20", "10"]);
    expect(result[0]?.workspaceRoot).toBe("/srv/a");
  });

  it("drops archived threads and nests sub-agent threads under their parent", () => {
    const result = buildRemoteCatalogProjects(
      snapshot(
        [project("a", "Alpha")],
        [
          thread("10", "a"),
          thread("11", "a", { archivedAt: "2026-10-28T09:00:00.000Z" }),
          thread("12", "a", { parentThreadId: "10" }),
        ],
      ),
    );
    expect(result[0]?.threads.map((entry) => entry.id)).toEqual(["10"]);
    expect(result[0]?.threads[0]?.children.map((entry) => entry.id)).toEqual(["12"]);
  });

  it("marks running and attention threads", () => {
    const result = buildRemoteCatalogProjects(
      snapshot(
        [project("a", "Alpha")],
        [
          thread("10", "a", { session: { status: "running" } }),
          thread("11", "a", { hasPendingApprovals: true, session: { status: "running" } }),
          thread("12", "a", { session: { status: "ready" } }),
        ],
      ),
    );
    const states = Object.fromEntries(
      result[0]?.threads.map((entry) => [entry.id, entry.state]) ?? [],
    );
    expect(states).toEqual({ "10": "running", "11": "attention", "12": "idle" });
  });

  it("caps listed threads and reports how many are hidden", () => {
    const total = REMOTE_CATALOG_THREAD_LIMIT + 3;
    const threads = Array.from({ length: total }, (_, index) => thread(String(index + 10), "a"));
    const result = buildRemoteCatalogProjects(snapshot([project("a", "Alpha")], threads));
    expect(result[0]?.threads).toHaveLength(REMOTE_CATALOG_THREAD_LIMIT);
    expect(result[0]?.hiddenThreadCount).toBe(3);
  });
});

describe("buildRemoteCatalogFromState", () => {
  it("matches the snapshot-built catalog once the snapshot has gone through a host store", () => {
    const base = makeShellSnapshot(makeReadModelThread({}));
    const shellThread = (id: string, projectId: string, extra: Record<string, unknown> = {}) =>
      ({
        ...base.threads[0]!,
        id,
        projectId,
        title: `thread ${id}`,
        updatedAt: `2026-10-28T10:00:${id.padStart(2, "0")}.000Z`,
        archivedAt: null,
        parentThreadId: null,
        ...extra,
      }) as unknown as ShellThread;
    const shellProject = (id: string, title: string, kind: ShellProject["kind"] = "project") =>
      ({
        ...base.projects[0]!,
        id,
        title,
        kind,
        workspaceRoot: `/srv/${id}`,
      }) as unknown as ShellProject;
    const full: OrchestrationShellSnapshot = {
      ...base,
      projects: [
        shellProject("b", "Beta"),
        shellProject("a", "Alpha"),
        shellProject("c", "Chats", "chat"),
      ],
      threads: [
        shellThread("10", "a"),
        shellThread("30", "a"),
        shellThread("20", "a", { hasPendingApprovals: true }),
        shellThread("11", "a", { archivedAt: "2026-10-28T09:00:00.000Z" }),
        shellThread("12", "a", { parentThreadId: "10" }),
        shellThread("13", "b"),
      ],
    };

    const state = syncServerShellSnapshot({ ...initialState, hostId: sshHostId("a1b2c3d4") }, full);

    expect(buildRemoteCatalogFromState(state)).toEqual(buildRemoteCatalogProjects(full));
    expect(buildRemoteCatalogFromState(state).map((entry) => entry.title)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });
});

describe("remoteHostSidebarStatus", () => {
  const state = (phase: DesktopRemoteSshHostState["phase"]): DesktopRemoteSshHostState => ({
    host: "devbox",
    hostKey: null,
    epoch: 0,
    remoteRoot: ".saint-beta-remote",
    phase,
    message: null,
    localPort: null,
  });

  it("maps phases to a dot state", () => {
    expect(remoteHostSidebarStatus(null)).toBe("offline");
    expect(remoteHostSidebarStatus(state("idle"))).toBe("offline");
    expect(remoteHostSidebarStatus(state("tunneling"))).toBe("connecting");
    expect(remoteHostSidebarStatus(state("reconnecting"))).toBe("connecting");
    expect(remoteHostSidebarStatus(state("connected"))).toBe("connected");
    expect(remoteHostSidebarStatus(state("error"))).toBe("error");
  });
});
