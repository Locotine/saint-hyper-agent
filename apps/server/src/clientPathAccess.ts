// Purpose: which folders one desktop client may touch on a server shared by several desktops.
// Layer: server transport support
//
// A client's roots are its own projects' folders and the worktrees of its own threads. Folder
// browsing for "add project" stays open elsewhere; reading, writing and git are held to these roots.
import nodePath from "node:path";

import { Effect, Stream } from "effect";

import { WS_METHODS, type OrchestrationReadModel } from "@saint/contracts";

import { CurrentClientScope, type ClientScope } from "./clientScope.ts";

const caseFold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

/** Whether `candidate` is `root` or lies below it (separator-aware, so `/a/bc` is not under `/a/b`). */
export function isPathWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(
    caseFold(nodePath.resolve(root)),
    caseFold(nodePath.resolve(candidate)),
  );
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

export function isPathWithinRoots(roots: Iterable<string>, candidate: string): boolean {
  if (!nodePath.isAbsolute(candidate)) return false;
  for (const root of roots) if (isPathWithin(root, candidate)) return true;
  return false;
}

/** Project folders and thread worktrees owned by `scope`. */
export function clientRoots(
  readModel: Pick<OrchestrationReadModel, "projects" | "threads">,
  scope: Exclude<ClientScope, null>,
): string[] {
  const roots: string[] = [];
  const ownedProjects = new Set<string>();
  for (const project of readModel.projects) {
    if ((project.ownerClientId ?? null) !== scope) continue;
    ownedProjects.add(project.id);
    roots.push(project.workspaceRoot, ...(project.additionalFolders ?? []));
  }
  for (const thread of readModel.threads) {
    if (!ownedProjects.has(thread.projectId)) continue;
    for (const path of [
      thread.worktreePath,
      thread.workingDirectory,
      thread.associatedWorktreePath,
    ]) {
      if (path) roots.push(path);
    }
  }
  return roots;
}

/**
 * A worktree the server just created in the shared worktrees folder, before any thread records
 * it: git runs on it first, so it is allowed until some thread claims it.
 * ponytail: another client can use such a path in that short window; record creators if it matters.
 */
function isUnclaimedWorktree(
  readModel: Pick<OrchestrationReadModel, "threads">,
  worktreesDir: string,
  candidate: string,
  scope: string,
  reserved: ReadonlyMap<string, string>,
): boolean {
  if (!isPathWithin(worktreesDir, candidate) || isPathWithin(candidate, worktreesDir)) return false;
  for (const [path, creator] of reserved) {
    if (creator !== scope && (isPathWithin(path, candidate) || isPathWithin(candidate, path))) {
      return false;
    }
  }
  return !readModel.threads.some((thread) =>
    [thread.worktreePath, thread.workingDirectory, thread.associatedWorktreePath].some(
      (path) => path && (isPathWithin(path, candidate) || isPathWithin(candidate, path)),
    ),
  );
}

/** Whether `scope` may read, write or run git at `candidate`. */
export function clientMayUsePath(
  readModel: Pick<OrchestrationReadModel, "projects" | "threads">,
  scope: Exclude<ClientScope, null>,
  worktreesDir: string,
  candidate: string,
  reserved: ReadonlyMap<string, string> = new Map(),
): boolean {
  return (
    isPathWithinRoots(clientRoots(readModel, scope), candidate) ||
    (nodePath.isAbsolute(candidate) &&
      isUnclaimedWorktree(readModel, worktreesDir, candidate, scope, reserved))
  );
}

const CWD = ["cwd"] as const;
const CREATES_WORKTREE = new Set<string>([
  WS_METHODS.gitCreateWorktree,
  WS_METHODS.gitCreateDetachedWorktree,
]);

/**
 * RPCs held to the client's roots, and the input fields that name a path. Left out on purpose:
 * `projects.listDirectories`, `projects.searchLocalEntries`, `git.init` and
 * `projects.provisionFromGitHub` run on folders that are not a project yet (add-project flow).
 */
export const CLIENT_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [
      WS_METHODS.projectsSearchEntries,
      WS_METHODS.projectsSearchContent,
      WS_METHODS.projectsPrewarmSearchIndex,
      WS_METHODS.projectsDiscoverScripts,
      WS_METHODS.projectsReadFile,
      WS_METHODS.projectsSubscribeFileChange,
      WS_METHODS.projectsResolveWorkspaceFileReferences,
      WS_METHODS.projectsResolveOutOfRootFileReference,
      WS_METHODS.projectsWriteFile,
      WS_METHODS.projectsCreateEntry,
      WS_METHODS.projectsDeleteEntry,
      WS_METHODS.projectsMoveEntry,
      WS_METHODS.projectsRenameEntry,
      WS_METHODS.projectsRunDevServer,
      WS_METHODS.editorDebugStart,
      WS_METHODS.editorIntelligence,
      WS_METHODS.gitPull,
      WS_METHODS.gitGithubRepository,
      WS_METHODS.gitStatus,
      WS_METHODS.gitReadWorkingTreeDiff,
      WS_METHODS.gitBlameLine,
      WS_METHODS.gitReadFileAtRev,
      WS_METHODS.gitWorkingTreeDiffStats,
      WS_METHODS.gitSummarizeDiff,
      WS_METHODS.gitRunStackedAction,
      WS_METHODS.gitListBranches,
      WS_METHODS.gitListRecentCommits,
      WS_METHODS.gitCreateBranch,
      WS_METHODS.gitCheckout,
      WS_METHODS.gitStashAndCheckout,
      WS_METHODS.gitStashDrop,
      WS_METHODS.gitStashInfo,
      WS_METHODS.gitRemoveIndexLock,
      WS_METHODS.gitStageFiles,
      WS_METHODS.gitUnstageFiles,
      WS_METHODS.gitResolvePullRequest,
      WS_METHODS.gitPullRequestSnapshot,
      WS_METHODS.gitPreparePullRequestThread,
    ].map((method) => [method, CWD]),
  ),
  [WS_METHODS.projectsCreateLocalFilePreviewGrant]: ["path"],
  [WS_METHODS.projectsCreateHtmlPreviewGrant]: ["path"],
  [WS_METHODS.gitCreateWorktree]: ["cwd", "path"],
  [WS_METHODS.gitCreateDetachedWorktree]: ["cwd", "path", "copyChangesFrom"],
  [WS_METHODS.gitRemoveWorktree]: ["cwd", "path"],
  [WS_METHODS.gitHandoffThread]: ["cwd", "worktreePath"],
};

/**
 * Wraps the handlers of CLIENT_PATH_FIELDS so each first checks that the folders its input names
 * belong to the calling client. Handlers return an Effect or a Stream; an unscoped call (null
 * scope) passes straight through.
 */
export function guardClientPaths<H extends object, E>(
  handlers: H,
  deps: {
    readonly readModel: Effect.Effect<Pick<OrchestrationReadModel, "projects" | "threads">>;
    readonly worktreesDir: string;
    readonly denied: () => E;
  },
): H {
  // Worktrees this server created, by creating client, until a thread claims them.
  // ponytail: entries live until restart (one short string per worktree created).
  const reserved = new Map<string, string>();
  const reserve = (value: unknown, scope: string | null) => {
    const path = (value as { worktree?: { path?: unknown } } | null)?.worktree?.path;
    if (scope !== null && typeof path === "string") reserved.set(path, scope);
  };
  const check = (method: string, input: Record<string, unknown>) =>
    Effect.gen(function* () {
      const scope = yield* CurrentClientScope;
      if (scope === null) return;
      const readModel = yield* deps.readModel;
      for (const field of CLIENT_PATH_FIELDS[method] ?? []) {
        const value = input[field];
        if (typeof value !== "string" || value.length === 0) continue;
        if (!clientMayUsePath(readModel, scope, deps.worktreesDir, value, reserved)) {
          return yield* Effect.fail(deps.denied());
        }
      }
    });
  const guarded = { ...handlers } as Record<string, unknown>;
  for (const method of Object.keys(CLIENT_PATH_FIELDS)) {
    const handler = guarded[method] as
      | ((input: Record<string, unknown>, options: unknown) => unknown)
      | undefined;
    if (handler === undefined) continue;
    guarded[method] = (input: Record<string, unknown>, options: unknown) => {
      const allowed = check(method, input);
      const result = handler(input, options);
      if (!CREATES_WORKTREE.has(method)) {
        return Stream.isStream(result)
          ? Stream.unwrap(Effect.as(allowed, result))
          : Effect.andThen(allowed, result as Effect.Effect<unknown, unknown, unknown>);
      }
      const remember = <A>(created: unknown, value: A) =>
        Effect.map(CurrentClientScope.asEffect(), (scope) => {
          reserve(created, scope);
          return value;
        });
      return Stream.isStream(result)
        ? Stream.unwrap(
            Effect.as(
              allowed,
              Stream.mapEffect(
                result as Stream.Stream<{ kind?: string; result?: unknown }>,
                (event) =>
                  event.kind === "completed"
                    ? remember(event.result, event)
                    : Effect.succeed(event),
              ),
            ),
          )
        : Effect.andThen(
            allowed,
            Effect.flatMap(result as Effect.Effect<unknown>, (value) => remember(value, value)),
          );
    };
  }
  return guarded as H;
}
