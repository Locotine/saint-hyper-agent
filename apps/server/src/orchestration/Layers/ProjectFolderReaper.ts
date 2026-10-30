// FILE: ProjectFolderReaper.ts
// Purpose: Removes projects whose folder was deleted from disk, with their threads, so a deleted
//          folder disappears from Saint on this machine. Every host runs its own server, so a
//          remote host's deleted folders leave its project list the same way. The folder itself
//          is never touched: removing a project in Saint only unregisters it.
// Layer: Server orchestration (background sweep)

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectId,
} from "@saint/contracts";
import { Cause, Duration, Effect, Layer, Schedule } from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type FolderState = "present" | "missing" | "unknown";

export async function folderState(dir: string): Promise<FolderState> {
  try {
    return (await stat(dir)).isDirectory() ? "present" : "missing";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
    // A missing parent means an unmounted volume or a disconnected drive, not a deleted folder.
    try {
      await stat(path.dirname(dir));
      return "missing";
    } catch {
      return "unknown";
    }
  }
}

/**
 * Projects to remove: folder projects whose folder was missing on this sweep and on the one
 * before it, so a folder being moved or re-cloned is not removed mid-way.
 */
export function projectsToReap(input: {
  readonly readModel: Pick<OrchestrationReadModel, "projects">;
  readonly states: ReadonlyMap<ProjectId, FolderState>;
  readonly missingBefore: ReadonlySet<ProjectId>;
}): ReadonlyArray<ProjectId> {
  return input.readModel.projects
    .filter(
      (project) =>
        project.deletedAt === null &&
        (project.kind ?? "project") === "project" &&
        input.states.get(project.id) === "missing" &&
        input.missingBefore.has(project.id),
    )
    .map((project) => project.id);
}

const commandId = () => CommandId.makeUnsafe(`project-folder-reaper:${randomUUID()}`);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  let missingBefore = new Set<ProjectId>();

  const sweep = Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    const candidates = readModel.projects.filter(
      (project) => project.deletedAt === null && (project.kind ?? "project") === "project",
    );
    const states = new Map<ProjectId, FolderState>();
    for (const project of candidates) {
      states.set(project.id, yield* Effect.promise(() => folderState(project.workspaceRoot)));
    }
    const reap = projectsToReap({ readModel, states, missingBefore });
    missingBefore = new Set(
      [...states].flatMap(([projectId, state]) => (state === "missing" ? [projectId] : [])),
    );
    const reapOne = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const threads = readModel.threads.filter(
          (thread) => thread.projectId === projectId && thread.deletedAt === null,
        );
        yield* Effect.forEach(
          threads,
          (thread) =>
            engine.dispatch({
              type: "thread.delete",
              commandId: commandId(),
              threadId: thread.id,
            } as OrchestrationCommand),
          { discard: true },
        );
        yield* engine.dispatch({
          type: "project.delete",
          commandId: commandId(),
          projectId,
          createdAt: new Date().toISOString(),
        } as OrchestrationCommand);
        yield* Effect.logInfo("removed a project whose folder was deleted", {
          projectId,
          threads: threads.length,
        });
      });
    // One project that cannot be removed (a thread still busy) must not block the others.
    yield* Effect.forEach(
      reap,
      (projectId) =>
        reapOne(projectId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("could not remove a project whose folder was deleted", {
              projectId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );
  });

  yield* Effect.forkScoped(
    sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project folder sweep failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(SWEEP_INTERVAL_MS))),
    ),
  );
});

export const ProjectFolderReaperLive = Layer.effectDiscard(make);
