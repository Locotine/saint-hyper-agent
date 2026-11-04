// Purpose: per-client ownership of orchestration data on a server shared by remote desktops.
// Layer: orchestration domain
//
// Only projects and spaces record an owner (`ownerClientId`); a thread belongs to its project's
// owner. Null is "unowned": everything on an unscoped server, and data from before scoping.
import type {
  OrchestrationCommand,
  OrchestrationEvent,
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

/** Any command, including the client-sendable subset. */
type CommandLike = { readonly type: string };

/** Owners of every thread, project and space a command names that already exists. */
export function commandTargetOwners(
  command: CommandLike,
  readModel: OrchestrationReadModel,
): ClientOwner[] {
  const target = command as {
    readonly threadId?: ThreadId;
    readonly projectId?: ProjectId;
    readonly spaceId?: SpaceId | null;
    readonly projectIds?: ReadonlyArray<ProjectId>;
    readonly parentThreadId?: ThreadId | null;
    readonly sourceThreadId?: ThreadId | null;
    readonly sidechatSourceThreadId?: ThreadId | null;
  };
  const found: Array<ClientOwner | undefined> = [
    target.threadId !== undefined ? threadOwner(readModel, target.threadId) : undefined,
    target.projectId !== undefined ? projectOwner(readModel, target.projectId) : undefined,
    target.spaceId != null ? spaceOwner(readModel, target.spaceId) : undefined,
    ...(target.projectIds ?? []).map((id) => projectOwner(readModel, id)),
    ...[target.parentThreadId, target.sourceThreadId, target.sidechatSourceThreadId].map((id) =>
      id != null ? threadOwner(readModel, id) : undefined,
    ),
  ];
  return found.filter((owner): owner is ClientOwner => owner !== undefined);
}

/**
 * The client a command acts within: the creator for project/space creation, else the owner of the
 * first existing thread, project or space it targets. Unowned when it targets nothing yet.
 */
export function commandOwner(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): ClientOwner {
  if (command.type === "project.create" || command.type === "space.create") {
    return command.ownerClientId ?? null;
  }
  return commandTargetOwners(command, readModel)[0] ?? null;
}

/** Whether `scope` may run `command`: everything it names must belong to that client. */
export function clientMayRunCommand(
  scope: ClientOwner,
  command: CommandLike,
  readModel: OrchestrationReadModel,
): boolean {
  return commandTargetOwners(command, readModel).every((owner) => owner === scope);
}

/**
 * Narrows a read model or shell snapshot to one client's projects, spaces and their threads.
 */
export function scopeSnapshotToClient<
  S extends {
    readonly projects: ReadonlyArray<{
      readonly id: ProjectId;
      readonly ownerClientId?: string | null | undefined;
    }>;
    readonly spaces: ReadonlyArray<{ readonly ownerClientId?: string | null | undefined }>;
    readonly threads: ReadonlyArray<{ readonly projectId: ProjectId }>;
  },
>(snapshot: S, scope: ClientOwner): S {
  const projects = snapshot.projects.filter((entry) => (entry.ownerClientId ?? null) === scope);
  const projectIds = new Set(projects.map((project) => project.id));
  return {
    ...snapshot,
    projects,
    spaces: snapshot.spaces.filter((entry) => (entry.ownerClientId ?? null) === scope),
    threads: snapshot.threads.filter((thread) => projectIds.has(thread.projectId)),
  };
}

/**
 * A stateful filter for one event stream: keeps events of the client's own projects, spaces and
 * threads. It learns owners as creations pass by, so it needs the stream's events in order and
 * the read model read after the stream was subscribed.
 */
export function makeClientEventFilter(
  readModel: OrchestrationReadModel,
  scope: ClientOwner,
): (event: OrchestrationEvent) => boolean {
  const owners = new Map<string, ClientOwner>();
  const projectOwners = new Map<string, ClientOwner>();
  for (const space of readModel.spaces) owners.set(space.id, space.ownerClientId ?? null);
  for (const project of readModel.projects) {
    projectOwners.set(project.id, project.ownerClientId ?? null);
    owners.set(project.id, project.ownerClientId ?? null);
  }
  for (const thread of readModel.threads) {
    owners.set(thread.id, projectOwners.get(thread.projectId) ?? null);
  }
  return (event) => {
    const id = event.aggregateId as string;
    const payload = event.payload as { ownerClientId?: string | null; projectId?: string };
    if (!owners.has(id)) {
      if (event.aggregateKind === "thread" && payload.projectId !== undefined) {
        owners.set(id, projectOwners.get(payload.projectId) ?? null);
      } else if (event.aggregateKind !== "thread") {
        owners.set(id, payload.ownerClientId ?? null);
        if (event.aggregateKind === "project") projectOwners.set(id, payload.ownerClientId ?? null);
      }
    }
    // An aggregate whose creation was never seen (purged) has no known owner: hidden.
    return owners.has(id) && owners.get(id) === scope;
  };
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
