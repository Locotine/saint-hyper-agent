import type { OrchestrationEvent, OrchestrationReadModel } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  clientMayRunCommand,
  makeClientEventFilter,
  scopeSnapshotToClient,
} from "./clientOwnership.ts";

const A = "a-0123abcd";
const B = "b-0123abcd";
const project = (id: string, ownerClientId: string | null) => ({ id, ownerClientId });
const thread = (id: string, projectId: string) => ({ id, projectId });
const model = {
  spaces: [{ id: "s-a", ownerClientId: A }],
  projects: [project("p-a", A), project("p-b", B), project("p-old", null)],
  threads: [thread("t-a", "p-a"), thread("t-b", "p-b"), thread("t-old", "p-old")],
} as unknown as OrchestrationReadModel;

const event = (
  aggregateKind: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) => ({ aggregateKind, aggregateId, payload }) as unknown as OrchestrationEvent;

describe("scopeSnapshotToClient", () => {
  it("keeps only the client's projects, spaces and their threads", () => {
    const scoped = scopeSnapshotToClient(model, A);
    expect(scoped.projects.map((p) => p.id)).toEqual(["p-a"]);
    expect(scoped.spaces).toHaveLength(1);
    expect(scoped.threads.map((t) => t.id)).toEqual(["t-a"]);
    expect(scopeSnapshotToClient(model, B).spaces).toHaveLength(0);
  });
});

describe("clientMayRunCommand", () => {
  it("allows own targets, new aggregates and creations; rejects other clients' and unowned data", () => {
    expect(clientMayRunCommand(A, { type: "thread.delete", threadId: "t-a" } as never, model)).toBe(true);
    expect(clientMayRunCommand(A, { type: "thread.delete", threadId: "t-b" } as never, model)).toBe(false);
    expect(clientMayRunCommand(A, { type: "thread.delete", threadId: "t-old" } as never, model)).toBe(false);
    expect(
      clientMayRunCommand(A, { type: "thread.create", threadId: "new", projectId: "p-a" } as never, model),
    ).toBe(true);
    expect(
      clientMayRunCommand(A, { type: "thread.create", threadId: "new", projectId: "p-b" } as never, model),
    ).toBe(false);
    expect(
      clientMayRunCommand(A, { type: "thread.create", threadId: "n", projectId: "p-a", sourceThreadId: "t-b" } as never, model),
    ).toBe(false);
    expect(clientMayRunCommand(A, { type: "project.create", projectId: "new" } as never, model)).toBe(true);
  });
});

describe("makeClientEventFilter", () => {
  it("passes only the client's events, learning owners from creations in the stream", () => {
    const keep = makeClientEventFilter(model, A);
    expect(keep(event("thread", "t-a"))).toBe(true);
    expect(keep(event("thread", "t-b"))).toBe(false);
    expect(keep(event("thread", "t-old"))).toBe(false);
    expect(keep(event("project", "p-new", { ownerClientId: A }))).toBe(true);
    expect(keep(event("thread", "t-new", { projectId: "p-new" }))).toBe(true);
    expect(keep(event("project", "p-other", { ownerClientId: B }))).toBe(false);
    expect(keep(event("thread", "t-other", { projectId: "p-other" }))).toBe(false);
    expect(keep(event("thread", "t-unknown"))).toBe(false);
  });
});
