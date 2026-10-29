import {
  CommandId,
  FlowRunId,
  MessageId,
  ModelSelection,
  ThreadId,
  type FlowNodeRun,
  type FlowNodeSpec,
  type FlowRun,
  type OrchestrationEvent,
} from "@saint/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@saint/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FlowRepository, type FlowRunState } from "../../persistence/Services/FlowRepository.ts";
import { decideFlow, flowEdgeKey } from "../flowDecision.ts";
import { renderFlowNodePrompt } from "../flowPrompt.ts";
import { decodeFlowSpec, flowNodeDepths, parseFlowSpecYaml } from "../flowSpec.ts";
import {
  FlowService,
  FlowServiceError,
  type FlowRunView,
  type FlowServiceShape,
} from "../Services/FlowService.ts";

// Events that can end a node's turn; token-level message events stay off this path.
const RECONCILE_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.turn-diff-completed",
  "thread.turn-interrupt-requested",
  "thread.session-set",
]);

const isoNow = () => new Date().toISOString();
const toError = (message: string) => (cause: unknown) =>
  cause instanceof FlowServiceError ? cause : new FlowServiceError({ message, cause });
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

export const flowNodeThreadId = (flowId: string, nodeId: string, attempt: number) =>
  ThreadId.makeUnsafe(`flow-${stableGatewayDigest({ flowId, nodeId, attempt }, 32)}`);

const view = (state: FlowRunState): FlowRunView => ({
  run: state.run,
  nodes: state.nodes,
  approvedEdges: [...state.approvedEdges],
});

const make = Effect.gen(function* () {
  const repository = yield* FlowRepository;
  const ledger = yield* Ledger;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  // ponytail: one lock for every flow mutation; per-flow locks if many flows run at once.
  const mutations = yield* Semaphore.make(1);

  const record = (
    run: FlowRun,
    kind: string,
    actor: string,
    payload: unknown,
    nodeId: string | null = null,
  ) =>
    ledger
      .append({ kind, actor, flowId: run.id, nodeId, payload })
      .pipe(Effect.asVoid, Effect.mapError(toError("Could not write the flow ledger.")));

  const load = (flowId: FlowRunId) =>
    repository.get(flowId).pipe(
      Effect.mapError(toError("Could not load the flow.")),
      Effect.flatMap((state) =>
        state
          ? Effect.succeed(state)
          : Effect.fail(new FlowServiceError({ message: "Flow not found." })),
      ),
    );

  const saveNode = (node: FlowNodeRun, patch: Partial<FlowNodeRun>) =>
    repository
      .saveNode({ ...node, ...patch, revision: node.revision + 1, updatedAt: isoNow() })
      .pipe(Effect.mapError(toError("Could not save the flow node.")));

  const saveRun = (run: FlowRun, patch: Partial<FlowRun>) =>
    repository
      .saveRun({ ...run, ...patch, revision: run.revision + 1, updatedAt: isoNow() })
      .pipe(Effect.mapError(toError("Could not save the flow.")));

  const nodeModelSelection = (run: FlowRun, spec: FlowNodeSpec) =>
    spec.provider || spec.model
      ? decodeModelSelection({
          provider: spec.provider ?? run.modelSelection.provider,
          model: spec.model ?? (spec.provider ? undefined : run.modelSelection.model),
        }).pipe(Effect.mapError(toError(`Node "${spec.id}" names an unknown provider or model.`)))
      : Effect.succeed(run.modelSelection);

  const spawnNode = (state: FlowRunState, node: FlowNodeRun, failure?: string) =>
    Effect.gen(function* () {
      const { run } = state;
      const spec = run.spec.nodes.find((entry) => entry.id === node.nodeId)!;
      const attempt = node.attempts + 1;
      const threadId = flowNodeThreadId(run.id, node.nodeId, attempt);
      const commandKey = `flow:${run.id}:${node.nodeId}:${attempt}`;
      const modelSelection = yield* nodeModelSelection(run, spec);
      const incoming = run.spec.edges
        .filter((edge) => edge.to === node.nodeId)
        .map((edge) => ({
          from: edge.from,
          handoff: state.nodes.find((entry) => entry.nodeId === edge.from)?.handoff ?? null,
        }));
      // Claim the node before dispatching so a concurrent tick cannot start it twice.
      const claimed = yield* saveNode(node, {
        status: "running",
        threadId,
        attempts: attempt,
        statusReason: null,
      });
      if (!claimed) return;
      const now = isoNow();
      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`${commandKey}:thread-create`),
          threadId,
          projectId: run.projectId,
          title: `${run.spec.name} · ${spec.role}`,
          creationSource: "flow_node",
          modelSelection,
          runtimeMode: run.runtimeMode,
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt: now,
        })
        .pipe(Effect.mapError(toError(`Could not create the thread for "${spec.id}".`)));
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`${commandKey}:turn-start`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(`${commandKey}:message`),
            role: "user",
            text: renderFlowNodePrompt({
              spec: run.spec,
              node: spec,
              incoming,
              ...(failure ? { failure } : {}),
            }),
            attachments: [],
          },
          modelSelection,
          dispatchMode: "queue",
          runtimeMode: run.runtimeMode,
          interactionMode: "default",
          createdAt: now,
        })
        .pipe(Effect.mapError(toError(`Could not start "${spec.id}".`)));
      yield* record(run, "node.started", "saint", { attempt, threadId }, node.nodeId);
    });

  /** Applies scheduler decisions until nothing changes. Callers hold `mutations`. */
  const tick = (flowId: FlowRunId): Effect.Effect<void, FlowServiceError> =>
    Effect.gen(function* () {
      const state = yield* load(flowId);
      const actions = decideFlow({
        spec: state.run.spec,
        status: state.run.status,
        nodes: state.nodes,
        approvedEdges: state.approvedEdges,
        consecutiveFailures: state.run.consecutiveFailures,
      });
      let changed = false;
      for (const action of actions) {
        const node = (id: string) => state.nodes.find((entry) => entry.nodeId === id)!;
        switch (action.type) {
          case "promote":
            changed = (yield* saveNode(node(action.nodeId), { status: "ready" })) || changed;
            break;
          case "spawn": {
            // Re-read: the promote above bumped the revision.
            const fresh = yield* load(flowId);
            const target = fresh.nodes.find((entry) => entry.nodeId === action.nodeId)!;
            if (target.status !== "ready") break;
            yield* spawnNode(fresh, target);
            changed = true;
            break;
          }
          case "await_edge": {
            const target = node(action.to);
            if (target.status === "blocked") break;
            yield* saveNode(target, {
              status: "blocked",
              statusReason: `Waiting for approval of ${flowEdgeKey(action.from, action.to)}.`,
            });
            yield* record(state.run, "edge.awaiting", "saint", action, action.to);
            break;
          }
          case "complete":
            yield* saveRun(state.run, { status: "completed", statusReason: null });
            yield* record(state.run, "flow.completed", "saint", null);
            break;
          case "fail":
            yield* saveRun(state.run, { status: "failed", statusReason: action.reason });
            yield* record(state.run, "flow.failed", "saint", { reason: action.reason });
            break;
        }
      }
      if (changed) yield* tick(flowId);
    }).pipe(Effect.mapError(toError("Could not advance the flow.")));

  const locked = <A>(effect: Effect.Effect<A, FlowServiceError>) =>
    mutations.withPermits(1)(effect);

  const start: FlowServiceShape["start"] = (input) =>
    locked(
      Effect.gen(function* () {
        const parsed =
          typeof input.spec === "string"
            ? parseFlowSpecYaml(input.spec)
            : decodeFlowSpec(input.spec);
        if (parsed._tag === "invalid") {
          return yield* new FlowServiceError({ message: parsed.errors.join("\n") });
        }
        const spec = parsed.spec;
        const depths = flowNodeDepths(spec)!;
        const now = isoNow();
        const id = FlowRunId.makeUnsafe(`flow-${crypto.randomUUID()}`);
        const run: FlowRun = {
          id,
          projectId: input.projectId,
          spec,
          status: "running",
          statusReason: null,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          consecutiveFailures: 0,
          startedBy: input.startedBy,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        };
        const nodes: FlowNodeRun[] = spec.nodes.map((node) => ({
          flowId: id,
          nodeId: node.id,
          status: "pending",
          threadId: null,
          attempts: 0,
          depth: depths.get(node.id) ?? 0,
          statusReason: null,
          handoff: null,
          revision: 0,
          updatedAt: now,
        }));
        yield* repository
          .create(run, nodes)
          .pipe(Effect.mapError(toError("Could not save the flow.")));
        yield* record(run, "flow.started", input.startedBy, {
          name: spec.name,
          nodes: nodes.length,
        });
        yield* tick(id);
        return view(yield* load(id));
      }).pipe(Effect.mapError(toError("Could not start the flow."))),
    );

  const get: FlowServiceShape["get"] = (flowId) =>
    repository.get(flowId).pipe(
      Effect.map((state) => (state ? view(state) : null)),
      Effect.mapError(toError("Could not load the flow.")),
    );

  const list: FlowServiceShape["list"] = (input) =>
    repository.list(input).pipe(Effect.mapError(toError("Could not list flows.")));

  const setRunStatus = (flowId: FlowRunId, status: FlowRun["status"], by: string, kind: string) =>
    locked(
      Effect.gen(function* () {
        const state = yield* load(flowId);
        if (state.run.status === status) return;
        if (state.run.status !== "running" && state.run.status !== "paused") {
          return yield* new FlowServiceError({
            message: `The flow is already ${state.run.status}.`,
          });
        }
        yield* saveRun(state.run, { status, statusReason: null });
        yield* record(state.run, kind, by, null);
        if (status === "running") yield* tick(flowId);
        return state;
      }),
    );

  const cancel: FlowServiceShape["cancel"] = (flowId, by) =>
    Effect.gen(function* () {
      const state = yield* setRunStatus(flowId, "cancelled", by, "flow.cancelled");
      if (!state) return;
      const now = isoNow();
      yield* Effect.forEach(
        state.nodes.filter(
          (node) => node.threadId && (node.status === "running" || node.status === "gating"),
        ),
        (node) =>
          orchestrationEngine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe(
                `flow:${flowId}:${node.nodeId}:${node.attempts}:cancel`,
              ),
              threadId: node.threadId!,
              requestedBy: "system",
              createdAt: now,
            })
            .pipe(Effect.ignore),
        { discard: true },
      );
    });

  const approveEdge: FlowServiceShape["approveEdge"] = ({ flowId, from, to, by }) =>
    locked(
      Effect.gen(function* () {
        const state = yield* load(flowId);
        const edge = state.run.spec.edges.find((entry) => entry.from === from && entry.to === to);
        if (!edge || edge.policy !== "hold") {
          return yield* new FlowServiceError({ message: `No hold edge ${flowEdgeKey(from, to)}.` });
        }
        yield* repository
          .approveEdge({
            flowId,
            edgeKey: flowEdgeKey(from, to),
            approvedBy: by,
            approvedAt: isoNow(),
          })
          .pipe(Effect.mapError(toError("Could not approve the edge.")));
        yield* record(state.run, "edge.approved", by, { from, to }, to);
        const target = state.nodes.find((node) => node.nodeId === to);
        if (target?.status === "blocked")
          yield* saveNode(target, { status: "pending", statusReason: null });
        yield* tick(flowId);
      }),
    );

  const reconcileThread: FlowServiceShape["reconcileThread"] = (threadId) =>
    locked(
      Effect.gen(function* () {
        const node = yield* repository
          .findNodeByThread(threadId)
          .pipe(Effect.mapError(toError("Could not find the flow node.")));
        if (!node || node.status !== "running") return;
        const shell = yield* snapshotQuery
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(toError("Could not read the node thread.")));
        const turn = Option.getOrNull(shell)?.latestTurn ?? null;
        if (!turn || turn.state === "running") return;
        const state = yield* load(node.flowId);
        if (turn.state === "completed") {
          yield* saveNode(node, { status: "settled", statusReason: null });
          yield* saveRun(state.run, { consecutiveFailures: 0 });
          yield* record(state.run, "node.settled", "saint", { turnId: turn.turnId }, node.nodeId);
        } else {
          const reason =
            turn.state === "interrupted" ? "The turn was interrupted." : "The turn failed.";
          yield* saveNode(node, { status: "failed", statusReason: reason });
          yield* saveRun(state.run, { consecutiveFailures: state.run.consecutiveFailures + 1 });
          yield* record(
            state.run,
            "node.failed",
            "saint",
            { reason, turnId: turn.turnId },
            node.nodeId,
          );
        }
        yield* tick(node.flowId);
      }),
    );

  const recover = Effect.gen(function* () {
    const runs = yield* list({ statuses: ["running"] });
    for (const run of runs) {
      const state = yield* load(run.id);
      for (const node of state.nodes) {
        if (node.status === "running" && node.threadId) yield* reconcileThread(node.threadId);
      }
      yield* locked(tick(run.id));
    }
  });

  const worker = yield* makeDrainableWorker(
    (threadId: ThreadId) =>
      reconcileThread(threadId).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("flow reactor failed to reconcile thread", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
    { capacity: 128 },
  );

  const startReactor: FlowServiceShape["startReactor"] = () =>
    Effect.gen(function* () {
      yield* recover.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("flow recovery failed", { cause: Cause.pretty(cause) }),
        ),
      );
      yield* startDrainableWorkerProducers(
        worker,
        Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
            if (!RECONCILE_EVENT_TYPES.has(event.type) || !("threadId" in event.payload)) {
              return Effect.void;
            }
            const threadId = event.payload.threadId;
            return threadId.startsWith("flow-")
              ? worker.enqueue(threadId).pipe(Effect.asVoid)
              : Effect.void;
          }),
        ).pipe(Effect.asVoid),
      );
    });

  return {
    start,
    get,
    list,
    cancel: (flowId, by) => cancel(flowId, by).pipe(Effect.asVoid),
    pause: (flowId, by) => setRunStatus(flowId, "paused", by, "flow.paused").pipe(Effect.asVoid),
    resume: (flowId, by) => setRunStatus(flowId, "running", by, "flow.resumed").pipe(Effect.asVoid),
    approveEdge,
    reconcileThread,
    startReactor,
  } satisfies FlowServiceShape;
});

export const FlowServiceLive = Layer.effect(FlowService, make);
