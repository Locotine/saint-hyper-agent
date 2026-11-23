// FILE: workspaceFileChanges.ts
// Purpose: Stream bounded change notifications for one workspace file without
//          recursively watching the workspace.
// Layer: Server filesystem utility

import { watch as watchNodeFileSystem, type FSWatcher } from "node:fs";
import * as NodeFileSystem from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_WATCH_WORKSPACE_MAX_DIRECTORIES,
  type ProjectFileChangeEvent,
  type ProjectWatchFileInput,
  type ProjectWatchWorkspaceInput,
  type ProjectWorkspaceChangeEvent,
} from "@saint/contracts";
import { Cause, Duration, Effect, Queue, Stream } from "effect";

import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import {
  resolveRealPathForCreateWithinRoot,
  resolveRealPathWithinRoot,
} from "./workspace/realPathContainment";

const FILE_CHANGE_DEBOUNCE_MS = 100;
const WORKSPACE_CHANGE_DEBOUNCE_MS = 150;
const GIT_WATCHED_ROOT_FILES = new Set([
  "HEAD",
  "index",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "packed-refs",
  "COMMIT_EDITMSG",
]);

export class WorkspaceFileWatchError extends Error {
  constructor(
    readonly operation: "prepare" | "watch" | "stat",
    readonly filePath: string,
    override readonly cause: unknown,
  ) {
    super(
      `Failed to ${operation} workspace file watch for ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "WorkspaceFileWatchError";
  }
}

function isFileNotFoundError(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function watchTargetDirectory(targetPath: string): Stream.Stream<void, WorkspaceFileWatchError> {
  const directoryPath = NodePath.dirname(targetPath);
  const targetName = NodePath.basename(targetPath);

  return Stream.callback<void, WorkspaceFileWatchError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const watcher = watchNodeFileSystem(
            directoryPath,
            { recursive: false },
            (_eventType, filename) => {
              if (filename !== null && NodePath.basename(filename.toString()) !== targetName) {
                return;
              }
              Queue.offerUnsafe(queue, undefined);
            },
          );
          const onError = (cause: Error) => {
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new WorkspaceFileWatchError("watch", targetPath, cause)),
            );
          };
          const onClose = () => Queue.endUnsafe(queue);
          watcher.on("error", onError);
          watcher.on("close", onClose);

          // Establish the watcher before emitting the initial state. The client
          // revalidates once after this event, closing the read-before-watch race.
          Queue.offerUnsafe(queue, undefined);
          return { watcher, onError, onClose };
        },
        catch: (cause) => new WorkspaceFileWatchError("watch", targetPath, cause),
      }),
      ({ watcher, onError, onClose }) =>
        Effect.sync(() => {
          watcher.off("error", onError);
          watcher.off("close", onClose);
          watcher.close();
        }),
    ).pipe(Effect.asVoid),
  );
}

async function readFileChangeState(
  input: ProjectWatchFileInput,
  targetPath: string,
): Promise<ProjectFileChangeEvent> {
  try {
    const realPath = await resolveRealPathWithinRoot(input.cwd, targetPath);
    if (realPath === null) {
      return { type: "deleted", relativePath: input.relativePath };
    }
    const stat = await NodeFileSystem.stat(realPath);
    return stat.isFile()
      ? { type: "changed", relativePath: input.relativePath, mtimeMs: stat.mtimeMs }
      : { type: "deleted", relativePath: input.relativePath };
  } catch (cause) {
    if (isFileNotFoundError(cause)) {
      return { type: "deleted", relativePath: input.relativePath };
    }
    throw new WorkspaceFileWatchError("stat", targetPath, cause);
  }
}

export function watchWorkspaceFile(
  input: ProjectWatchFileInput,
): Stream.Stream<ProjectFileChangeEvent, WorkspaceFileWatchError | WorkspacePathOutsideRootError> {
  return Stream.unwrap(
    Effect.tryPromise({
      try: () =>
        resolveRealPathForCreateWithinRoot(
          input.cwd,
          NodePath.resolve(input.cwd, input.relativePath),
        ),
      catch: (cause) =>
        new WorkspaceFileWatchError(
          "prepare",
          NodePath.resolve(input.cwd, input.relativePath),
          cause,
        ),
    }).pipe(
      Effect.flatMap((targetPath) =>
        targetPath === null
          ? Effect.fail(
              new WorkspacePathOutsideRootError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
              }),
            )
          : Effect.succeed(targetPath),
      ),
      Effect.map((targetPath) =>
        watchTargetDirectory(targetPath).pipe(
          Stream.debounce(Duration.millis(FILE_CHANGE_DEBOUNCE_MS)),
          Stream.mapEffect(() =>
            Effect.tryPromise({
              try: () => readFileChangeState(input, targetPath),
              catch: (cause) =>
                cause instanceof WorkspaceFileWatchError
                  ? cause
                  : new WorkspaceFileWatchError("stat", targetPath, cause),
            }),
          ),
        ),
      ),
    ),
  );
}

function normalizeRelativeDirectoryPath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

function parentRelativeDirectory(relativeDir: string): string {
  const slashIndex = relativeDir.lastIndexOf("/");
  return slashIndex === -1 ? "" : relativeDir.slice(0, slashIndex);
}

async function resolveGitMetadataDirectory(realRoot: string): Promise<string | null> {
  const dotGitPath = NodePath.join(realRoot, ".git");
  try {
    const stat = await NodeFileSystem.stat(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (stat.isFile()) {
      const content = await NodeFileSystem.readFile(dotGitPath, "utf8");
      const match = /^gitdir:\s*(.+)$/im.exec(content);
      const rawGitDir = match?.[1]?.trim();
      if (!rawGitDir) return null;
      const resolvedGitDir = NodePath.resolve(realRoot, rawGitDir);
      const gitDirStat = await NodeFileSystem.stat(resolvedGitDir);
      return gitDirStat.isDirectory() ? resolvedGitDir : null;
    }
  } catch {
    return null;
  }
  return null;
}

interface ResolvedWorkspaceWatchTargets {
  readonly rootRealPath: string;
  readonly directories: ReadonlyArray<{
    readonly relativePath: string;
    readonly absolutePath: string;
  }>;
  readonly gitDir: string | null;
  readonly gitRefsHeadsDir: string | null;
}

async function resolveWorkspaceWatchTargets(
  input: ProjectWatchWorkspaceInput,
): Promise<ResolvedWorkspaceWatchTargets> {
  const rootRealPath = await resolveRealPathWithinRoot(input.cwd, input.cwd);
  if (rootRealPath === null) {
    throw new WorkspacePathOutsideRootError({
      workspaceRoot: input.cwd,
      relativePath: ".",
    });
  }
  const rootStat = await NodeFileSystem.stat(rootRealPath);
  if (!rootStat.isDirectory()) {
    throw new WorkspaceFileWatchError("prepare", rootRealPath, new Error("Not a directory"));
  }

  const seenRelative = new Set<string>([""]);
  const directories: Array<{ readonly relativePath: string; readonly absolutePath: string }> = [
    { relativePath: "", absolutePath: rootRealPath },
  ];

  for (const rawDir of input.directories ?? []) {
    if (directories.length >= PROJECT_WATCH_WORKSPACE_MAX_DIRECTORIES) break;
    const relativePath = normalizeRelativeDirectoryPath(rawDir);
    if (seenRelative.has(relativePath)) continue;
    seenRelative.add(relativePath);
    const candidateAbs = NodePath.resolve(rootRealPath, relativePath);
    const containedPath = await resolveRealPathForCreateWithinRoot(rootRealPath, candidateAbs);
    if (containedPath === null) {
      throw new WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath,
      });
    }
    try {
      const resolved = await resolveRealPathWithinRoot(rootRealPath, candidateAbs);
      if (resolved === null) {
        throw new WorkspacePathOutsideRootError({
          workspaceRoot: input.cwd,
          relativePath,
        });
      }
      const stat = await NodeFileSystem.stat(resolved);
      if (!stat.isDirectory()) continue;
      directories.push({ relativePath, absolutePath: resolved });
    } catch (cause) {
      if (cause instanceof WorkspacePathOutsideRootError) {
        throw cause;
      }
      // Subdirectory may have been deleted or renamed concurrently; ignore cleanly.
    }
  }

  let gitDir: string | null = null;
  let gitRefsHeadsDir: string | null = null;
  if (input.watchGit !== false) {
    gitDir = await resolveGitMetadataDirectory(rootRealPath);
    if (gitDir) {
      const candidateRefsHeads = NodePath.join(gitDir, "refs", "heads");
      try {
        const refsStat = await NodeFileSystem.stat(candidateRefsHeads);
        if (refsStat.isDirectory()) {
          gitRefsHeadsDir = candidateRefsHeads;
        }
      } catch {
        // Repo may not have refs/heads yet (unborn branch).
      }
    }
  }

  return {
    rootRealPath,
    directories,
    gitDir,
    gitRefsHeadsDir,
  };
}

/**
 * Watches a bounded set of workspace directories (root + expanded subdirectories)
 * plus optional `.git` metadata using non-recursive `fs.watch`, so external OS /
 * terminal changes propagate to both local and remote clients without hitting
 * Linux inotify limits.
 */
export function watchWorkspaceDirectories(
  input: ProjectWatchWorkspaceInput,
  options?: {
    readonly debounceMs?: number;
    readonly onChanged?: (event: ProjectWorkspaceChangeEvent) => void;
  },
): Stream.Stream<
  ProjectWorkspaceChangeEvent,
  WorkspaceFileWatchError | WorkspacePathOutsideRootError
> {
  const debounceMs = options?.debounceMs ?? WORKSPACE_CHANGE_DEBOUNCE_MS;

  return Stream.unwrap(
    Effect.tryPromise({
      try: () => resolveWorkspaceWatchTargets(input),
      catch: (cause) =>
        cause instanceof WorkspacePathOutsideRootError || cause instanceof WorkspaceFileWatchError
          ? cause
          : new WorkspaceFileWatchError("prepare", input.cwd, cause),
    }).pipe(
      Effect.map((targets) =>
        Stream.callback<ProjectWorkspaceChangeEvent, WorkspaceFileWatchError>((queue) =>
          Effect.acquireRelease(
            Effect.try({
              try: () => {
                const watchers: Array<{
                  readonly watcher: FSWatcher;
                  readonly onError: (cause: Error) => void;
                }> = [];
                const pendingDirectories = new Set<string>();
                let pendingGitChanged = false;
                let flushTimer: ReturnType<typeof setTimeout> | null = null;
                let closed = false;

                const flush = () => {
                  flushTimer = null;
                  if (closed) return;
                  if (pendingDirectories.size === 0 && !pendingGitChanged) return;
                  const event: ProjectWorkspaceChangeEvent = {
                    type: "changed",
                    cwd: input.cwd,
                    directories: [...pendingDirectories],
                    gitChanged: pendingGitChanged,
                    timestampMs: Date.now(),
                  };
                  pendingDirectories.clear();
                  pendingGitChanged = false;
                  try {
                    options?.onChanged?.(event);
                  } catch {
                    // Cache invalidation hooks must not break the stream.
                  }
                  Queue.offerUnsafe(queue, event);
                };

                const scheduleFlush = () => {
                  if (closed || flushTimer !== null) return;
                  flushTimer = setTimeout(flush, debounceMs);
                  flushTimer.unref?.();
                };

                const markDirectoryDirty = (relativePath: string) => {
                  if (closed) return;
                  pendingDirectories.add(relativePath);
                  scheduleFlush();
                };

                const markGitDirty = () => {
                  if (closed) return;
                  pendingGitChanged = true;
                  scheduleFlush();
                };

                for (const dir of targets.directories) {
                  const isRoot = dir.relativePath === "";
                  try {
                    const watcher = watchNodeFileSystem(
                      dir.absolutePath,
                      { recursive: false },
                      (_eventType, filename) => {
                        const name = filename !== null ? filename.toString() : null;
                        if (isRoot && name === ".git") {
                          markGitDirty();
                          return;
                        }
                        if (
                          name !== null &&
                          name.endsWith(".lock") &&
                          dir.relativePath === ".git"
                        ) {
                          return;
                        }
                        markDirectoryDirty(dir.relativePath);
                      },
                    );
                    const onError = (cause: Error) => {
                      if (isRoot) {
                        Queue.failCauseUnsafe(
                          queue,
                          Cause.fail(new WorkspaceFileWatchError("watch", dir.absolutePath, cause)),
                        );
                        return;
                      }
                      // Subdirectory deleted or unmounted: close only this watcher and refresh its parent.
                      try {
                        watcher.close();
                      } catch {
                        // Best-effort cleanup.
                      }
                      markDirectoryDirty(parentRelativeDirectory(dir.relativePath));
                    };
                    watcher.on("error", onError);
                    watchers.push({ watcher, onError });
                  } catch (cause) {
                    if (isRoot) {
                      throw new WorkspaceFileWatchError("watch", dir.absolutePath, cause);
                    }
                    // Non-root subdirectory vanished between stat and watch.
                  }
                }

                if (targets.gitDir) {
                  try {
                    const gitWatcher = watchNodeFileSystem(
                      targets.gitDir,
                      { recursive: false },
                      (_eventType, filename) => {
                        const name = filename !== null ? filename.toString() : null;
                        if (name === null || GIT_WATCHED_ROOT_FILES.has(name)) {
                          markGitDirty();
                        }
                      },
                    );
                    const onError = () => {
                      try {
                        gitWatcher.close();
                      } catch {
                        // Optional git metadata watcher; never fail workspace watch.
                      }
                    };
                    gitWatcher.on("error", onError);
                    watchers.push({ watcher: gitWatcher, onError });
                  } catch {
                    // Best-effort git metadata watcher.
                  }
                }

                if (targets.gitRefsHeadsDir) {
                  try {
                    const refsWatcher = watchNodeFileSystem(
                      targets.gitRefsHeadsDir,
                      { recursive: false },
                      () => {
                        markGitDirty();
                      },
                    );
                    const onError = () => {
                      try {
                        refsWatcher.close();
                      } catch {
                        // Optional git refs watcher; never fail workspace watch.
                      }
                    };
                    refsWatcher.on("error", onError);
                    watchers.push({ watcher: refsWatcher, onError });
                  } catch {
                    // Best-effort git refs watcher.
                  }
                }

                return {
                  close: () => {
                    closed = true;
                    if (flushTimer !== null) {
                      clearTimeout(flushTimer);
                      flushTimer = null;
                    }
                    for (const { watcher, onError } of watchers) {
                      watcher.off("error", onError);
                      try {
                        watcher.close();
                      } catch {
                        // Already closed.
                      }
                    }
                    watchers.length = 0;
                  },
                };
              },
              catch: (cause) =>
                cause instanceof WorkspaceFileWatchError
                  ? cause
                  : new WorkspaceFileWatchError("watch", input.cwd, cause),
            }),
            (handle) => Effect.sync(() => handle.close()),
          ).pipe(Effect.asVoid),
        ),
      ),
    ),
  );
}
