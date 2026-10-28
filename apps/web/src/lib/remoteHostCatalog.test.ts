import type { DesktopRemoteSshHostState, OrchestrationShellSnapshot } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  REMOTE_CATALOG_THREAD_LIMIT,
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

  it("drops archived and sub-agent threads", () => {
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

describe("remoteHostSidebarStatus", () => {
  const state = (phase: DesktopRemoteSshHostState["phase"]): DesktopRemoteSshHostState => ({
    host: "devbox",
    remoteRoot: ".saint-beta-remote",
    phase,
    message: null,
    localPort: null,
  });

  it("maps phases to a dot state", () => {
    expect(remoteHostSidebarStatus(null)).toBe("offline");
    expect(remoteHostSidebarStatus(state("idle"))).toBe("offline");
    expect(remoteHostSidebarStatus(state("tunneling"))).toBe("connecting");
    expect(remoteHostSidebarStatus(state("connected"))).toBe("connected");
    expect(remoteHostSidebarStatus(state("error"))).toBe("error");
  });
});
