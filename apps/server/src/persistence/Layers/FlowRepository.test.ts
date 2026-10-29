import { FlowRunId, ProjectId, ThreadId, type FlowNodeRun, type FlowRun } from "@saint/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { FlowRepository } from "../Services/FlowRepository";
import { FlowRepositoryLive } from "./FlowRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(FlowRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const flowId = FlowRunId.makeUnsafe("flow-1");
const now = "2026-10-29T10:00:00.000Z";

const run: FlowRun = {
  id: flowId,
  projectId: ProjectId.makeUnsafe("project-1"),
  spec: {
    version: "flow-v1",
    name: "two steps",
    nodes: [
      { id: "a", role: "A", prompt: "do a" },
      { id: "b", role: "B", prompt: "do b" },
    ],
    edges: [{ from: "a", to: "b", policy: "hold" }],
  },
  status: "running",
  statusReason: null,
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  consecutiveFailures: 0,
  startedBy: "user",
  revision: 0,
  createdAt: now,
  updatedAt: now,
};

const node = (nodeId: string): FlowNodeRun => ({
  flowId,
  nodeId,
  status: "pending",
  threadId: null,
  attempts: 0,
  depth: nodeId === "a" ? 0 : 1,
  statusReason: null,
  handoff: null,
  revision: 0,
  updatedAt: now,
});

layer("FlowRepository", (it) => {
  it.effect("stores a run with nodes, guards revisions, approves edges, finds by thread", () =>
    Effect.gen(function* () {
      const repository = yield* FlowRepository;
      yield* repository.create(run, [node("a"), node("b")]);

      const stored = yield* repository.get(flowId);
      assert.strictEqual(stored?.run.spec.name, "two steps");
      assert.deepStrictEqual(
        stored?.nodes.map((entry) => entry.nodeId),
        ["a", "b"],
      );

      const threadId = ThreadId.makeUnsafe("thread-a");
      const running = { ...node("a"), status: "running" as const, threadId, revision: 1 };
      assert.isTrue(yield* repository.saveNode(running));
      assert.isFalse(yield* repository.saveNode(running), "stale revision must lose");
      assert.strictEqual((yield* repository.findNodeByThread(threadId))?.status, "running");

      assert.isTrue(yield* repository.saveRun({ ...run, status: "paused", revision: 1 }));
      assert.isFalse(yield* repository.saveRun({ ...run, status: "cancelled", revision: 1 }));

      yield* repository.approveEdge({
        flowId,
        edgeKey: "a->b",
        approvedBy: "user",
        approvedAt: now,
      });
      yield* repository.approveEdge({
        flowId,
        edgeKey: "a->b",
        approvedBy: "user",
        approvedAt: now,
      });
      assert.deepStrictEqual([...(yield* repository.get(flowId))!.approvedEdges], ["a->b"]);

      assert.strictEqual((yield* repository.list({ statuses: ["paused"] })).length, 1);
      assert.strictEqual((yield* repository.list({ statuses: ["running"] })).length, 0);
      assert.isNull(yield* repository.get(FlowRunId.makeUnsafe("missing")));
    }),
  );
});
