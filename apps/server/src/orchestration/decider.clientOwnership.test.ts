import { CommandId, EventId, ProjectId } from "@saint/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = new Date().toISOString();

const projectCreated = (projectId: string, ownerClientId: string | null, sequence: number) => ({
  sequence,
  eventId: EventId.makeUnsafe(`evt-${projectId}`),
  aggregateKind: "project" as const,
  aggregateId: ProjectId.makeUnsafe(projectId),
  type: "project.created" as const,
  occurredAt: now,
  commandId: CommandId.makeUnsafe(`cmd-${projectId}`),
  causationEventId: null,
  correlationId: CommandId.makeUnsafe(`cmd-${projectId}`),
  metadata: {},
  payload: {
    projectId: ProjectId.makeUnsafe(projectId),
    title: projectId,
    workspaceRoot: "/tmp/shared-root",
    defaultModelSelection: null,
    scripts: [],
    ownerClientId,
    createdAt: now,
    updatedAt: now,
  },
});

const createProject = (projectId: string, ownerClientId: string | null) => ({
  type: "project.create" as const,
  commandId: CommandId.makeUnsafe(`cmd-create-${projectId}`),
  projectId: ProjectId.makeUnsafe(projectId),
  title: projectId,
  workspaceRoot: "/tmp/shared-root",
  ownerClientId,
  createdAt: now,
});

describe("decider client ownership", () => {
  it("lets each client add the same folder without touching another client's project", async () => {
    const readModel = await Effect.runPromise(
      projectEvent(createEmptyReadModel(now), projectCreated("project-a", "a-0123abcd", 1)),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: createProject("project-b", "b-0123abcd"), readModel }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual(["project.created"]);
    expect(events[0]?.payload).toMatchObject({ ownerClientId: "b-0123abcd" });
  });

  it("still retires the same client's empty project on that folder", async () => {
    const readModel = await Effect.runPromise(
      projectEvent(createEmptyReadModel(now), projectCreated("project-a", "a-0123abcd", 1)),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({ command: createProject("project-a2", "a-0123abcd"), readModel }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual(["project.deleted", "project.created"]);
  });

  it("keeps ids unique across clients", async () => {
    const readModel = await Effect.runPromise(
      projectEvent(createEmptyReadModel(now), projectCreated("project-a", "a-0123abcd", 1)),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: createProject("project-a", "b-0123abcd"),
          readModel,
        }),
      ),
    ).rejects.toThrow(/already exists/u);
  });
});
