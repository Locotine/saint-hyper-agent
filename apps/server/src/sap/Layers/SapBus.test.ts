import {
  FlowRunId,
  ProjectId,
  ThreadId,
  type FlowNodeRun,
  type FlowRun,
  type OrchestrationCommand,
} from "@saint/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { FlowService, type FlowServiceShape } from "../../flow/Services/FlowService.ts";
import { LedgerLive } from "../../ledger/Layers/Ledger.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SapBus } from "../Services/SapBus.ts";
import { SapBusLive } from "./SapBus.ts";

const now = "2026-10-29T10:00:00.000Z";
const flowId = FlowRunId.makeUnsafe("flow-1");
const run: FlowRun = {
  id: flowId,
  projectId: ProjectId.makeUnsafe("project-1"),
  spec: {
    version: "flow-v1",
    name: "f",
    nodes: [
      { id: "coder", role: "Coder", prompt: "p", gate: { id: "g7", cmd: "bun run test" } },
      { id: "qa", role: "QA", prompt: "p" },
    ],
    edges: [{ from: "coder", to: "qa" }],
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
const node = (nodeId: string, patch: Partial<FlowNodeRun> = {}): FlowNodeRun => ({
  flowId,
  nodeId,
  status: "running",
  threadId: ThreadId.makeUnsafe(`t-${nodeId}`),
  attempts: 1,
  depth: 0,
  statusReason: null,
  handoff: null,
  revision: 0,
  updatedAt: now,
  ...patch,
});
const nodes = [
  node("coder", {
    lastGate: {
      gateId: "g7",
      passed: true,
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      evidence: "ev:0123456789ab" as never,
      protectedEdits: [],
      finishedAt: now,
    },
  }),
  node("qa"),
];

const dispatched: OrchestrationCommand[] = [];
const flows = {
  nodeForThread: (threadId: ThreadId) =>
    Effect.succeed(
      nodes.find((entry) => entry.threadId === threadId)
        ? { run, node: nodes.find((entry) => entry.threadId === threadId)! }
        : null,
    ),
  get: () => Effect.succeed({ run, nodes, approvedEdges: [] }),
} as unknown as FlowServiceShape;
const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const layer = it.layer(
  SapBusLive.pipe(
    Layer.provideMerge(
      LedgerLive.pipe(
        Layer.provide(
          Layer.succeed(ServerSecretStore, {
            get: () => Effect.succeed(seed),
            set: () => Effect.void,
            getOrCreateRandom: () => Effect.succeed(seed),
            remove: () => Effect.void,
          }),
        ),
      ),
    ),
    Layer.provideMerge(Layer.succeed(FlowService, flows)),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as never),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("SapBus", (it) => {
  it.effect("answers state questions itself, delivers the rest, and stops loops", () =>
    Effect.gen(function* () {
      const sap = yield* SapBus;
      const ledger = yield* Ledger;
      const qa = ThreadId.makeUnsafe("t-qa");
      const coder = ThreadId.makeUnsafe("t-coder");

      const gate = yield* sap.send({
        fromThreadId: qa,
        to: "coder",
        act: "ASK",
        topic: "gate",
        body: "did g7 pass?",
      });
      assert.strictEqual(gate.answeredBy, "saint");
      assert.include(gate.answer!, "passed");
      assert.include(gate.answer!, "ev:0123456789ab");
      assert.strictEqual(dispatched.length, 0);

      const free = yield* sap.send({
        fromThreadId: qa,
        to: "coder",
        act: "ASK",
        body: "why a token bucket?",
      });
      assert.strictEqual(free.state, "pending");
      assert.strictEqual(dispatched.length, 1);
      assert.strictEqual(dispatched[0]!.type, "thread.turn.start");

      const reply = yield* sap.reply({
        fromThreadId: coder,
        messageId: free.id,
        body: "bursty clients",
      });
      assert.strictEqual(reply.replyTo, free.id);
      assert.strictEqual(reply.hops, 1);

      const claim = yield* sap.send({
        fromThreadId: coder,
        to: "qa",
        act: "CLAIM",
        body: "tests pass",
      });
      assert.isFalse(claim.verified);
      const handle = yield* ledger.putHandle({
        kind: "ev",
        content: "ok",
        mime: "text/plain",
        provenance: "gate",
        taint: "internal",
        createdBy: "saint",
      });
      const backed = yield* sap.send({
        fromThreadId: coder,
        to: "qa",
        act: "CLAIM",
        body: "tests pass now",
        refs: [handle],
      });
      assert.isTrue(backed.verified);

      for (let index = 0; index < 2; index += 1) {
        yield* sap.send({ fromThreadId: qa, to: "coder", act: "TELL", body: "Ping" });
      }
      const looped = yield* sap.send({
        fromThreadId: qa,
        to: "coder",
        act: "TELL",
        body: "  ping ",
      });
      assert.strictEqual(looped.state, "dropped");

      const { stats } = yield* sap.list(flowId);
      assert.deepStrictEqual(stats, {
        asks: 2,
        answeredBySaint: 1,
        unverifiedClaims: 1,
        dropped: 1,
      });

      const unknown = yield* Effect.flip(
        sap.send({ fromThreadId: qa, to: "nobody", act: "TELL", body: "x" }),
      );
      assert.include(unknown.message, "not a step");
    }),
  );
});
