import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { WS_METHODS } from "@saint/contracts";

import { CurrentClientScope } from "./clientScope.ts";

import {
  clientMayUsePath,
  clientRoots,
  guardClientPaths,
  isPathWithin,
  isPathWithinRoots,
} from "./clientPathAccess.ts";

describe("clientPathAccess", () => {
  it("matches the root and its children only", () => {
    expect(isPathWithin("/a/b", "/a/b")).toBe(true);
    expect(isPathWithin("/a/b", "/a/b/c/d.ts")).toBe(true);
    expect(isPathWithin("/a/b", "/a/bc")).toBe(false);
    expect(isPathWithin("/a/b", "/a/b/../x")).toBe(false);
    expect(isPathWithinRoots(["/a/b"], "relative/x")).toBe(false);
  });

  it("collects only the calling client's project folders and worktrees", () => {
    const readModel = {
      projects: [
        {
          id: "p1",
          workspaceRoot: "/mine",
          additionalFolders: ["/mine-extra"],
          ownerClientId: "alice-00000001",
        },
        {
          id: "p2",
          workspaceRoot: "/theirs",
          additionalFolders: [],
          ownerClientId: "bob-00000002",
        },
      ],
      threads: [
        {
          projectId: "p1",
          worktreePath: "/wt/mine",
          workingDirectory: null,
          associatedWorktreePath: null,
        },
        {
          projectId: "p2",
          worktreePath: "/wt/theirs",
          workingDirectory: null,
          associatedWorktreePath: null,
        },
      ],
    } as never;
    expect(clientRoots(readModel, "alice-00000001")).toEqual(["/mine", "/mine-extra", "/wt/mine"]);
  });

  it("allows a fresh worktree nobody claimed, never another client's", () => {
    const readModel = {
      projects: [
        {
          id: "p1",
          workspaceRoot: "/mine",
          additionalFolders: [],
          ownerClientId: "alice-00000001",
        },
        {
          id: "p2",
          workspaceRoot: "/theirs",
          additionalFolders: [],
          ownerClientId: "bob-00000002",
        },
      ],
      threads: [
        {
          projectId: "p2",
          worktreePath: "/wt/repo/theirs",
          workingDirectory: null,
          associatedWorktreePath: null,
        },
      ],
    } as never;
    const may = (path: string) => clientMayUsePath(readModel, "alice-00000001", "/wt", path);
    expect(may("/mine/src")).toBe(true);
    expect(may("/wt/repo/new")).toBe(true);
    expect(may("/wt/repo/theirs/x")).toBe(false);
    expect(may("/wt/repo")).toBe(false);
    expect(may("/wt")).toBe(false);
    expect(may("/theirs")).toBe(false);
    expect(may("/etc")).toBe(false);
    const reserved = new Map([["/wt/repo/new", "bob-00000002"]]);
    expect(clientMayUsePath(readModel, "alice-00000001", "/wt", "/wt/repo/new", reserved)).toBe(
      false,
    );
    expect(clientMayUsePath(readModel, "bob-00000002", "/wt", "/wt/repo/new", reserved)).toBe(true);
  });
});

describe("guardClientPaths", () => {
  const readModel = {
    projects: [
      { id: "p1", workspaceRoot: "/mine", additionalFolders: [], ownerClientId: "alice-00000001" },
    ],
    threads: [],
  } as never;
  const handlers = guardClientPaths(
    {
      [WS_METHODS.projectsReadFile]: (_input: { cwd: string }) => Effect.succeed("read"),
      [WS_METHODS.projectsSubscribeFileChange]: (_input: { cwd: string }) => Stream.make(1, 2),
      [WS_METHODS.projectsListDirectories]: (_input: { cwd: string }) => Effect.succeed("listed"),
    },
    { readModel: Effect.succeed(readModel), worktreesDir: "/wt", denied: () => "denied" },
  );
  const as = <A, E>(scope: string | null, effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(Effect.result(Effect.provideService(effect, CurrentClientScope, scope)));

  it("lets the owner through and refuses another client, for effects and streams", async () => {
    const read = (cwd: string) => handlers[WS_METHODS.projectsReadFile]({ cwd }) as never;
    expect((await as("alice-00000001", read("/mine/src") as never))._tag).toBe("Success");
    expect((await as("bob-00000002", read("/mine/src") as never))._tag).toBe("Failure");
    expect((await as("alice-00000001", read("/etc") as never))._tag).toBe("Failure");
    const watch = (cwd: string) =>
      Stream.runCollect(handlers[WS_METHODS.projectsSubscribeFileChange]({ cwd }) as never);
    expect((await as("alice-00000001", watch("/mine") as never))._tag).toBe("Success");
    expect((await as("bob-00000002", watch("/mine") as never))._tag).toBe("Failure");
  });

  it("leaves unscoped calls and add-project browsing alone", async () => {
    const read = handlers[WS_METHODS.projectsReadFile]({ cwd: "/anywhere" }) as never;
    expect((await as(null, read))._tag).toBe("Success");
    const list = handlers[WS_METHODS.projectsListDirectories]({ cwd: "/anywhere" }) as never;
    expect((await as("bob-00000002", list))._tag).toBe("Success");
  });
});
