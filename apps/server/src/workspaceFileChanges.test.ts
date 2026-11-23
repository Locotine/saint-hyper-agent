// FILE: workspaceFileChanges.test.ts
// Purpose: Verifies bounded file watching across replace/delete/recreate saves.
// Layer: Server filesystem utility tests

import * as NodeFileSystem from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import { watchWorkspaceDirectories, watchWorkspaceFile } from "./workspaceFileChanges";

const temporaryRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await NodeFileSystem.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "saint-file-watch-"),
  );
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((workspaceRoot) => NodeFileSystem.rm(workspaceRoot, { recursive: true, force: true })),
  );
});

describe("watchWorkspaceFile", () => {
  it("emits the initial state and survives delete-and-recreate saves", async () => {
    const workspaceRoot = await makeWorkspace();
    const relativePath = "src/example.ts";
    const absolutePath = NodePath.join(workspaceRoot, relativePath);
    await NodeFileSystem.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFileSystem.writeFile(absolutePath, "first\n");

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.take(3),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await NodeFileSystem.rm(absolutePath);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await NodeFileSystem.writeFile(absolutePath, "second\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("file watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.map((event) => event.type)).toEqual(["changed", "deleted", "changed"]);
      expect(events.every((event) => event.relativePath === relativePath)).toBe(true);
    } finally {
      abortController.abort();
    }
  });

  it.each(["file", "directory"] as const)(
    "rejects an outside-root symlink through a %s",
    async (kind) => {
      const workspaceRoot = await makeWorkspace();
      const outsideRoot = await makeWorkspace();
      await NodeFileSystem.writeFile(NodePath.join(outsideRoot, "target.ts"), "outside");
      await NodeFileSystem.symlink(
        kind === "file" ? NodePath.join(outsideRoot, "target.ts") : outsideRoot,
        NodePath.join(workspaceRoot, "link"),
      );
      const error = await Effect.runPromise(
        watchWorkspaceFile({
          cwd: workspaceRoot,
          relativePath: kind === "file" ? "link" : "link/target.ts",
        }).pipe(Stream.runHead, Effect.flip),
      );
      expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
    },
  );

  it("allows an in-root symlink and emits the requested relative path", async () => {
    const workspaceRoot = await makeWorkspace();
    await NodeFileSystem.writeFile(NodePath.join(workspaceRoot, "target.ts"), "inside");
    await NodeFileSystem.symlink("target.ts", NodePath.join(workspaceRoot, "link.ts"));
    const events = await Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "link.ts" }).pipe(
        Stream.take(1),
        Stream.runCollect,
      ),
    );
    expect(Array.from(events)).toEqual([
      { type: "changed", relativePath: "link.ts", mtimeMs: expect.any(Number) },
    ]);
  });

  it("rejects paths outside the workspace root before opening a watcher", async () => {
    const workspaceRoot = await makeWorkspace();
    const error = await Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "../outside.ts" }).pipe(
        Stream.runHead,
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
  });
});

describe("watchWorkspaceDirectories", () => {
  it("emits workspace changes for root and expanded subdirectories", async () => {
    const workspaceRoot = await makeWorkspace();
    const subDir = NodePath.join(workspaceRoot, "src");
    await NodeFileSystem.mkdir(subDir, { recursive: true });

    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceDirectories({
        cwd: workspaceRoot,
        directories: ["src", "missing-dir"],
      }).pipe(Stream.take(2), Stream.runCollect),
      { signal: abortController.signal },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await NodeFileSystem.writeFile(NodePath.join(workspaceRoot, "root.txt"), "hello\n");
      await new Promise((resolve) => setTimeout(resolve, 260));
      await NodeFileSystem.writeFile(NodePath.join(subDir, "nested.ts"), "export const a = 1;\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("workspace watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.length).toBe(2);
      expect(events.some((event) => event.directories.includes(""))).toBe(true);
      expect(events.some((event) => event.directories.includes("src"))).toBe(true);
    } finally {
      abortController.abort();
    }
  });

  it("reports gitChanged when .git metadata updates", async () => {
    const workspaceRoot = await makeWorkspace();
    const gitDir = NodePath.join(workspaceRoot, ".git");
    await NodeFileSystem.mkdir(NodePath.join(gitDir, "refs", "heads"), { recursive: true });
    await NodeFileSystem.writeFile(NodePath.join(gitDir, "HEAD"), "ref: refs/heads/main\n");

    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceDirectories({
        cwd: workspaceRoot,
        watchGit: true,
      }).pipe(Stream.take(1), Stream.runCollect),
      { signal: abortController.signal },
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await NodeFileSystem.writeFile(NodePath.join(gitDir, "HEAD"), "ref: refs/heads/feat\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("git workspace watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events).toHaveLength(1);
      expect(events[0]?.gitChanged).toBe(true);
    } finally {
      abortController.abort();
    }
  });

  it("rejects directories outside the workspace root", async () => {
    const workspaceRoot = await makeWorkspace();
    const error = await Effect.runPromise(
      watchWorkspaceDirectories({ cwd: workspaceRoot, directories: ["../outside"] }).pipe(
        Stream.runHead,
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
  });
});
