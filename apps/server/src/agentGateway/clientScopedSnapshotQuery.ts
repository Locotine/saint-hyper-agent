// Purpose: MCP tools on a server shared by several desktops read only the caller's desktop data.
// Layer: agent gateway
//
// The MCP transport provides `CurrentClientScope` (the owner of the caller thread's project) while a
// tool runs. This wrapper makes every snapshot and by-id read honor it, so tools need no per-tool
// filtering. Unscoped fibers (reactors, the local server) see the raw query. Maintenance reads
// (counts, stale threads, id-collision checks) stay global on purpose.
import type { ProjectId, ThreadId } from "@saint/contracts";
import { Effect, Option } from "effect";

import { CurrentClientScope } from "../clientScope.ts";
import { scopeSnapshotToClient } from "../orchestration/clientOwnership.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export function makeClientScopedSnapshotQuery(
  raw: ProjectionSnapshotQueryShape,
): ProjectionSnapshotQueryShape {
  const ownsProject = (scope: string, projectId: ProjectId) =>
    raw
      .getProjectShellById(projectId)
      .pipe(
        Effect.map((project) => Option.isSome(project) && project.value.ownerClientId === scope),
      );
  const ownsThread = (scope: string, threadId: ThreadId) =>
    raw
      .getThreadShellById(threadId)
      .pipe(
        Effect.flatMap((thread) =>
          Option.isSome(thread)
            ? ownsProject(scope, thread.value.projectId)
            : Effect.succeed(false),
        ),
      );
  /** Runs `read` only when the scope may see the item; otherwise it does not exist. */
  const whenVisible = <A, E>(
    visible: (scope: string) => Effect.Effect<boolean, E>,
    read: Effect.Effect<Option.Option<A>, E>,
  ): Effect.Effect<Option.Option<A>, E> =>
    Effect.flatMap(CurrentClientScope.asEffect(), (scope) =>
      scope === null
        ? read
        : Effect.flatMap(visible(scope), (ok) => (ok ? read : Effect.succeed(Option.none()))),
    );
  const forThread = <A>(
    threadId: ThreadId,
    read: Effect.Effect<Option.Option<A>, ProjectionRepositoryError>,
  ) => whenVisible((scope) => ownsThread(scope, threadId), read);
  const forProject = <A>(
    projectId: ProjectId,
    read: Effect.Effect<Option.Option<A>, ProjectionRepositoryError>,
  ) => whenVisible((scope) => ownsProject(scope, projectId), read);
  const filterScoped = <A, E>(
    read: Effect.Effect<A, E>,
    filter: (scope: string, value: A) => A,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(CurrentClientScope.asEffect(), (scope) =>
      scope === null ? read : Effect.map(read, (value) => filter(scope, value)),
    );

  return {
    ...raw,
    getSnapshot: () =>
      filterScoped(raw.getSnapshot(), (scope, s) => scopeSnapshotToClient(s, scope)),
    getShellSnapshot: () =>
      filterScoped(raw.getShellSnapshot(), (scope, s) => scopeSnapshotToClient(s, scope)),
    getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
      filterScoped(raw.getActiveProjectByWorkspaceRoot(workspaceRoot), (scope, project) =>
        Option.filter(project, (p) => p.ownerClientId === scope),
      ),
    getProjectShellById: (projectId) =>
      filterScoped(raw.getProjectShellById(projectId), (scope, project) =>
        Option.filter(project, (p) => p.ownerClientId === scope),
      ),
    getProjectShellsByIds: (projectIds) =>
      filterScoped(raw.getProjectShellsByIds(projectIds), (scope, projects) =>
        projects.filter((p) => p.ownerClientId === scope),
      ),
    getSpaceShellById: (spaceId) =>
      filterScoped(raw.getSpaceShellById(spaceId), (scope, space) =>
        Option.filter(space, (s) => s.ownerClientId === scope),
      ),
    getFirstActiveThreadIdByProjectId: (projectId) =>
      forProject(projectId, raw.getFirstActiveThreadIdByProjectId(projectId)),
    getThreadCheckpointContext: (threadId, options) =>
      forThread(threadId, raw.getThreadCheckpointContext(threadId, options)),
    getThreadTurnDiffContext: (threadId, turnId) =>
      forThread(threadId, raw.getThreadTurnDiffContext(threadId, turnId)),
    listGeneratedImageActivitiesByTurn: (threadId, turnId) =>
      Effect.flatMap(forThread(threadId, Effect.succeed(Option.some(true))), (visible) =>
        Option.isSome(visible)
          ? raw.listGeneratedImageActivitiesByTurn(threadId, turnId)
          : Effect.succeed([]),
      ),
    getFullThreadDiffContext: (threadId, toTurnCount) =>
      forThread(threadId, raw.getFullThreadDiffContext(threadId, toTurnCount)),
    getThreadShellById: (threadId, options) =>
      forThread(threadId, raw.getThreadShellById(threadId, options)),
    getThreadShellsByIds: (threadIds, options) =>
      Effect.flatMap(CurrentClientScope.asEffect(), (scope) =>
        scope === null
          ? raw.getThreadShellsByIds(threadIds, options)
          : raw
              .getThreadShellsByIds(threadIds, options)
              .pipe(
                Effect.flatMap((threads) =>
                  Effect.filter(threads, (thread) => ownsProject(scope, thread.projectId)),
                ),
              ),
      ),
    findSyntheticSubagentParentThread: (threadId) =>
      forThread(threadId, raw.findSyntheticSubagentParentThread(threadId)),
    getThreadDetailById: (threadId) => forThread(threadId, raw.getThreadDetailById(threadId)),
    getThreadDetailWithoutActivitiesById: (threadId) =>
      forThread(threadId, raw.getThreadDetailWithoutActivitiesById(threadId)),
    getThreadMentionContextById: (threadId, options) =>
      forThread(threadId, raw.getThreadMentionContextById(threadId, options)),
    getThreadDetailForExportById: (threadId) =>
      forThread(threadId, raw.getThreadDetailForExportById(threadId)),
    getThreadDetailSnapshotById: (threadId) =>
      forThread(threadId, raw.getThreadDetailSnapshotById(threadId)),
  };
}
