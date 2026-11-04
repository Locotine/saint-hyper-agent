// Purpose: per-client ownership of orchestration data on a server shared by remote desktops.
// Layer: orchestration domain
//
// Only projects and spaces record an owner (`ownerClientId`); a thread belongs to its project's
// owner. Null is "unowned": everything on an unscoped server, and data from before scoping.
import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  ProjectId,
  SpaceId,
  ThreadId,
} from "@saint/contracts";

export type ClientOwner = string | null;

export function projectOwner(
  readModel: Pick<OrchestrationReadModel, "projects">,
  projectId: ProjectId,
): ClientOwner | undefined {
  const project = readModel.projects.find((entry) => entry.id === projectId);
  return project ? (project.ownerClientId ?? null) : undefined;
}

export function threadOwner(
  readModel: Pick<OrchestrationReadModel, "projects" | "threads">,
  threadId: ThreadId,
): ClientOwner | undefined {
  const thread = readModel.threads.find((entry) => entry.id === threadId);
  return thread ? projectOwner(readModel, thread.projectId) : undefined;
}

function spaceOwner(
  readModel: Pick<OrchestrationReadModel, "spaces">,
  spaceId: SpaceId,
): ClientOwner | undefined {
  const space = readModel.spaces.find((entry) => entry.id === spaceId);
  return space ? (space.ownerClientId ?? null) : undefined;
}

/**
 * The client a command acts within: the creator for project/space creation, else the owner of the
 * thread, project or space it targets. Undefined when its target does not exist yet.
 */
export function commandOwner(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): ClientOwner | undefined {
  if (command.type === "project.create" || command.type === "space.create") {
    return command.ownerClientId ?? null;
  }
  const target = command as {
    readonly threadId?: ThreadId;
    readonly projectId?: ProjectId;
    readonly spaceId?: SpaceId | null;
  };
  return (
    (target.threadId !== undefined ? threadOwner(readModel, target.threadId) : undefined) ??
    (target.projectId !== undefined ? projectOwner(readModel, target.projectId) : undefined) ??
    (target.spaceId != null ? spaceOwner(readModel, target.spaceId) : undefined)
  );
}

/**
 * The read model as one client sees it: its own projects and spaces and the threads in them. The
 * same object when nothing is owned (an unscoped server), so the common path costs one scan.
 */
export function readModelForOwner(
  readModel: OrchestrationReadModel,
  owner: ClientOwner,
): OrchestrationReadModel {
  const owns = (entry: { readonly ownerClientId?: string | null | undefined }) =>
    (entry.ownerClientId ?? null) === owner;
  if (
    owner === null &&
    readModel.projects.every((entry) => !entry.ownerClientId) &&
    readModel.spaces.every((entry) => !entry.ownerClientId)
  ) {
    return readModel;
  }
  const projects = readModel.projects.filter(owns);
  const projectIds = new Set(projects.map((project) => project.id));
  return {
    ...readModel,
    projects,
    spaces: readModel.spaces.filter(owns),
    threads: readModel.threads.filter((thread) => projectIds.has(thread.projectId)),
  };
}
