import {
  ProjectId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type ThreadId,
} from "@saint/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { LedgerLive } from "../../ledger/Layers/Ledger.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FlowRepositoryLive } from "../../persistence/Layers/FlowRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { FlowService } from "../Services/FlowService.ts";
import { FlowServiceLive } from "./FlowService.ts";

const dispatched: OrchestrationCommand[] = [];
const turns = new Map<string, OrchestrationLatestTurn["state"]>();

const engine = {
  dispatch: (command: OrchestrationCommand) =>
    Effect.sync(() => {
      dispatched.push(command);
      return { sequence: dispatched.length };
    }),
} as unknown as OrchestrationEngineShape;

const snapshotQuery = {
  getThreadShellById: (threadId: ThreadId) =>
    Effect.succeed(
      turns.has(threadId)
        ? Option.some({
            latestTurn: {
              turnId: TurnId.makeUnsafe(`turn-${threadId}`),
              state: turns.get(threadId)!,
              requestedAt: "2026-10-29T10:00:00.000Z",
              startedAt: null,
              completedAt: null,
              assistantMessageId: null,
            },
          })
        : Option.none(),
    ),
} as unknown as ProjectionSnapshotQueryShape;

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
const layer = it.layer(
  FlowServiceLive.pipe(
    Layer.provideMerge(FlowRepositoryLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provideMerge(
      Layer.succeed(ServerSecretStore, {
        get: () => Effect.succeed(seed),
        set: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(seed),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const spec = `
version: flow-v1
name: Rate limit
nodes:
  - { id: architect, role: Architect, prompt: Plan it }
  - { id: coder, role: Coder, prompt: Build it }
  - { id: qa, role: QA, prompt: Check it }
edges:
  - { from: architect, to: coder }
  - { from: coder, to: qa, policy: hold }
`;

const startedThreads = () =>
  dispatched.flatMap((command) => (command.type === "thread.create" ? [command.threadId] : []));

layer("FlowService", (it) => {
  it.effect(
    "runs a chain: spawns, settles, holds, approves, completes, and logs to the ledger",
    () =>
      Effect.gen(function* () {
        const flows = yield* FlowService;
        const ledger = yield* Ledger;
        dispatched.length = 0;

        const started = yield* flows.start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec,
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          startedBy: "user",
        });
        const flowId = started.run.id;
        const status = (id: string) =>
          flows
            .get(flowId)
            .pipe(Effect.map((view) => view!.nodes.find((n) => n.nodeId === id)!.status));

        assert.strictEqual(startedThreads().length, 1, "only the root starts");
        assert.strictEqual(yield* status("architect"), "running");
        const turnStart = dispatched.find((command) => command.type === "thread.turn.start");
        assert.include(
          turnStart?.type === "thread.turn.start" ? turnStart.message.text : "",
          'the "Architect" step',
        );

        // A running turn changes nothing; a completed one settles and starts the child.
        const architectThread = startedThreads()[0]!;
        turns.set(architectThread, "running");
        yield* flows.reconcileThread(architectThread);
        assert.strictEqual(yield* status("architect"), "running");
        turns.set(architectThread, "completed");
        yield* flows.reconcileThread(architectThread);
        yield* flows.reconcileThread(architectThread);
        assert.strictEqual(yield* status("architect"), "settled");
        assert.strictEqual(startedThreads().length, 2);

        // The coder settles; QA waits behind the hold edge until approved.
        turns.set(startedThreads()[1]!, "completed");
        yield* flows.reconcileThread(startedThreads()[1]!);
        assert.strictEqual(yield* status("qa"), "blocked");
        yield* flows.approveEdge({ flowId, from: "coder", to: "qa", by: "user" });
        assert.strictEqual(yield* status("qa"), "running");

        turns.set(startedThreads()[2]!, "completed");
        yield* flows.reconcileThread(startedThreads()[2]!);
        assert.strictEqual((yield* flows.get(flowId))!.run.status, "completed");

        const kinds = (yield* ledger.listByFlow(flowId)).map((event) => event.kind);
        assert.deepStrictEqual(kinds.slice(0, 3), ["flow.started", "node.started", "node.settled"]);
        assert.include(kinds, "edge.approved");
        assert.strictEqual(kinds.at(-1), "flow.completed");
        assert.isTrue((yield* ledger.verify()).intact);
      }),
  );

  it.effect("fails a node on an errored turn and cancels by interrupting running nodes", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      dispatched.length = 0;
      const { run } = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      const root = startedThreads()[0]!;
      turns.set(root, "error");
      yield* flows.reconcileThread(root);
      const failed = (yield* flows.get(run.id))!;
      assert.strictEqual(failed.nodes.find((n) => n.nodeId === "architect")!.status, "failed");
      assert.strictEqual(failed.run.status, "failed");

      dispatched.length = 0;
      const second = yield* flows.start({
        projectId: ProjectId.makeUnsafe("project-1"),
        spec,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        startedBy: "user",
      });
      yield* flows.cancel(second.run.id, "user");
      assert.strictEqual((yield* flows.get(second.run.id))!.run.status, "cancelled");
      assert.isTrue(dispatched.some((command) => command.type === "thread.turn.interrupt"));
    }),
  );

  it.effect("rejects an invalid spec", () =>
    Effect.gen(function* () {
      const flows = yield* FlowService;
      const result = yield* flows
        .start({
          projectId: ProjectId.makeUnsafe("project-1"),
          spec: "version: flow-v1\nname: x\nnodes: [{ id: a, role: A, prompt: p }]\nedges: [{ from: a, to: a }]",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "full-access",
          startedBy: "user",
        })
        .pipe(Effect.flip);
      assert.include(result.message, "itself");
    }),
  );
});
