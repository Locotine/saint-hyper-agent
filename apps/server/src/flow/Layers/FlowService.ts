import {
  CommandId,
  FLOW_DEFAULT_MAX_REFIX,
  FlowRunId,
  MessageId,
  ModelSelection,
  ThreadId,
  type FlowGateOutcome,
  type FlowNodeRun,
  type FlowNodeSpec,
  type FlowRun,
  type OrchestrationEvent,
} from "@saint/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@saint/shared/DrainableWorker";
import { Cause, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import { stableGatewayDigest } from "../../agentGateway/creationUtils.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FlowRepository, type FlowRunState } from "../../persistence/Services/FlowRepository.ts";
import {
  decideFlow,
  decideNodeAfterTurn,
  flowEdgeKey,
  type NodeDecision,
} from "../flowDecision.ts";
import {
  renderFlowNodePrompt,
  renderFlowRefixMessage,
  summarizeGateFailure,
} from "../flowPrompt.ts";
import { captureGateBaseline, runFlowGate, type FlowGateResult } from "../gateRunner.ts";
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

const nodeSpecOf = (run: FlowRun, nodeId: string) =>
  run.spec.nodes.find((entry) => entry.id === nodeId)!;

const failedGate = (output: string): FlowGateResult => ({
  passed: false,
  exitCode: null,
  timedOut: false,
  durationMs: 0,
  output,
  protectedEdits: [],
});

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

  const projectCwd = (run: FlowRun) =>
    snapshotQuery.getProjectShellById(run.projectId).pipe(
      Effect.map((shell) => Option.getOrNull(shell)?.workspaceRoot ?? null),
      Effect.mapError(toError("Could not read the flow's project.")),
    );

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
      const cwd = spec.gate ? yield* projectCwd(run) : null;
      const baselineRef = cwd
        ? yield* Effect.promise(() => captureGateBaseline(cwd).catch(() => null))
        : null;
      // Claim the node before dispatching so a concurrent tick cannot start it twice.
      const claimed = yield* saveNode(node, {
        status: "running",
        threadId,
        attempts: attempt,
        statusReason: null,
        baselineRef,
        lastTurnId: null,
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
        elapsedMs: Date.now() - Date.parse(state.run.createdAt),
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

  /** Carries out what `decideNodeAfterTurn` chose. Callers hold `mutations`. */
  const applyNodeDecision = (
    flowId: FlowRunId,
    nodeId: string,
    decision: NodeDecision,
    extra: Partial<FlowNodeRun>,
  ) =>
    Effect.gen(function* () {
      const { run, nodes } = yield* load(flowId);
      const node = nodes.find((entry) => entry.nodeId === nodeId)!;
      const spec = nodeSpecOf(run, nodeId);
      const failures = (counts: boolean) =>
        counts ? run.consecutiveFailures + 1 : run.consecutiveFailures;
      switch (decision.type) {
        case "settle":
          yield* saveNode(node, { ...extra, status: "settled", statusReason: null });
          yield* saveRun(run, { consecutiveFailures: 0 });
          yield* record(run, "node.settled", "saint", null, nodeId);
          break;
        case "refix": {
          const attempt = node.attempts + 1;
          const commandKey = `flow:${flowId}:${nodeId}:${attempt}:refix`;
          yield* saveNode(node, {
            ...extra,
            status: "running",
            attempts: attempt,
            statusReason: `Refix ${attempt - 1}.`,
          });
          yield* saveRun(run, { consecutiveFailures: failures(decision.countsAsFailure) });
          const modelSelection = yield* nodeModelSelection(run, spec);
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`${commandKey}:turn-start`),
              threadId: node.threadId!,
              message: {
                messageId: MessageId.makeUnsafe(`${commandKey}:message`),
                role: "user",
                text: renderFlowRefixMessage({
                  attempt: attempt - 1,
                  maxAttempts: spec.maxRefix ?? FLOW_DEFAULT_MAX_REFIX,
                  failure: decision.failure,
                }),
                attachments: [],
              },
              modelSelection,
              dispatchMode: "queue",
              runtimeMode: run.runtimeMode,
              interactionMode: "default",
              createdAt: isoNow(),
            })
            .pipe(Effect.mapError(toError(`Could not send the refix to "${nodeId}".`)));
          yield* record(run, "node.refix", "saint", { attempt }, nodeId);
          break;
        }
        case "needs_you":
          yield* saveNode(node, { ...extra, status: "needs_you", statusReason: decision.reason });
          yield* saveRun(run, { consecutiveFailures: failures(decision.countsAsFailure) });
          yield* record(run, "node.needs_you", "saint", { reason: decision.reason }, nodeId);
          break;
        case "fail":
          yield* saveNode(node, { ...extra, status: "failed", statusReason: decision.reason });
          yield* saveRun(run, { consecutiveFailures: run.consecutiveFailures + 1 });
          yield* record(run, "node.failed", "saint", { reason: decision.reason }, nodeId);
          break;
      }
      yield* tick(flowId);
    });

  const gatesInFlight = new Set<string>();

  /** Runs a `gating` node's gate outside the lock (it can take minutes), then applies it. */
  const runGateFor = (flowId: FlowRunId, nodeId: string) =>
    Effect.gen(function* () {
      const key = `${flowId}:${nodeId}`;
      if (gatesInFlight.has(key)) return;
      gatesInFlight.add(key);
      yield* Effect.gen(function* () {
        const { run, nodes } = yield* load(flowId);
        const node = nodes.find((entry) => entry.nodeId === nodeId)!;
        const gate = nodeSpecOf(run, nodeId).gate!;
        const cwd = yield* projectCwd(run);
        const result: FlowGateResult = cwd
          ? yield* Effect.tryPromise(() =>
              runFlowGate({ gate, cwd, baseline: node.baselineRef ?? null }),
            ).pipe(
              Effect.catch((error) =>
                Effect.succeed(failedGate(`Saint could not run the gate: ${String(error)}`)),
              ),
            )
          : failedGate("Saint could not find the project folder to run the gate in.");
        const evidence = yield* ledger
          .putHandle({
            kind: "ev",
            content: result.output || "(no output)",
            mime: "text/plain",
            provenance: `gate:${gate.id}`,
            taint: "internal",
            createdBy: "saint",
          })
          .pipe(Effect.mapError(toError("Could not store the gate evidence.")));
        const outcome: FlowGateOutcome = {
          gateId: gate.id,
          passed: result.passed,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          evidence,
          protectedEdits: [...result.protectedEdits],
          finishedAt: isoNow(),
        };
        yield* locked(
          Effect.gen(function* () {
            const fresh = yield* load(flowId);
            const current = fresh.nodes.find((entry) => entry.nodeId === nodeId)!;
            // Cancelled or approved while the gate ran: keep the evidence, change nothing.
            if (current.status !== "gating") return;
            yield* record(fresh.run, "gate.finished", "saint", outcome, nodeId);
            const spec = nodeSpecOf(fresh.run, nodeId);
            const decision = decideNodeAfterTurn({
              mode: spec.mode,
              attempts: current.attempts,
              maxRefix: spec.maxRefix,
              outcome: {
                kind: "gate",
                passed: result.passed,
                protectedEdits: result.protectedEdits,
                summary: summarizeGateFailure({
                  cmd: gate.cmd,
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  output: result.output,
                  evidence,
                }),
              },
            });
            yield* applyNodeDecision(flowId, nodeId, decision, { lastGate: outcome });
          }),
        );
      }).pipe(Effect.ensuring(Effect.sync(() => gatesInFlight.delete(key))));
    });

  const reconcileThread: FlowServiceShape["reconcileThread"] = (threadId) =>
    Effect.gen(function* () {
      const gateTarget = yield* locked(
        Effect.gen(function* () {
          const node = yield* repository
            .findNodeByThread(threadId)
            .pipe(Effect.mapError(toError("Could not find the flow node.")));
          if (!node) return null;
          // A gate interrupted by a restart runs again.
          if (node.status === "gating") return node;
          if (node.status !== "running") return null;
          const shell = yield* snapshotQuery
            .getThreadShellById(threadId)
            .pipe(Effect.mapError(toError("Could not read the node thread.")));
          const turn = Option.getOrNull(shell)?.latestTurn ?? null;
          if (!turn || turn.state === "running" || turn.turnId === node.lastTurnId) return null;
          const { run } = yield* load(node.flowId);
          const spec = nodeSpecOf(run, node.nodeId);
          if (turn.state === "completed" && spec.gate) {
            const claimed = yield* saveNode(node, { status: "gating", lastTurnId: turn.turnId });
            if (claimed) yield* record(run, "gate.started", "saint", null, node.nodeId);
            return claimed ? node : null;
          }
          const decision = decideNodeAfterTurn({
            mode: spec.mode,
            attempts: node.attempts,
            maxRefix: spec.maxRefix,
            outcome:
              turn.state === "completed"
                ? { kind: "completed" }
                : {
                    kind: "turn_failed",
                    reason:
                      turn.state === "interrupted"
                        ? "The turn was interrupted."
                        : "The turn failed.",
                  },
          });
          yield* applyNodeDecision(node.flowId, node.nodeId, decision, {
            lastTurnId: turn.turnId,
          });
          return null;
        }),
      );
      if (gateTarget) yield* runGateFor(gateTarget.flowId, gateTarget.nodeId);
    });

  const requireNode = (state: FlowRunState, nodeId: string) => {
    const node = state.nodes.find((entry) => entry.nodeId === nodeId);
    return node
      ? Effect.succeed(node)
      : Effect.fail(new FlowServiceError({ message: `No node "${nodeId}" in this flow.` }));
  };

  const approveNode: FlowServiceShape["approveNode"] = ({ flowId, nodeId, by }) =>
    locked(
      Effect.gen(function* () {
        const state = yield* load(flowId);
        const node = yield* requireNode(state, nodeId);
        if (node.status !== "needs_you") {
          return yield* new FlowServiceError({ message: `"${nodeId}" is not waiting for review.` });
        }
        yield* record(state.run, "node.approved", by, null, nodeId);
        yield* applyNodeDecision(flowId, nodeId, { type: "settle" }, {});
      }),
    );

  const retryNode: FlowServiceShape["retryNode"] = ({ flowId, nodeId, by }) =>
    locked(
      Effect.gen(function* () {
        let state = yield* load(flowId);
        const node = yield* requireNode(state, nodeId);
        if (node.status !== "failed" && node.status !== "needs_you") {
          return yield* new FlowServiceError({ message: `"${nodeId}" has not failed.` });
        }
        if (state.run.status === "failed") {
          yield* saveRun(state.run, {
            status: "running",
            statusReason: null,
            consecutiveFailures: 0,
          });
          state = yield* load(flowId);
        }
        if (state.run.status !== "running") {
          return yield* new FlowServiceError({ message: `The flow is ${state.run.status}.` });
        }
        yield* record(state.run, "node.retried", by, null, nodeId);
        yield* spawnNode(state, yield* requireNode(state, nodeId));
        yield* tick(flowId);
      }),
    );

  const rerunGate: FlowServiceShape["rerunGate"] = ({ flowId, nodeId, by }) =>
    Effect.gen(function* () {
      const claimed = yield* locked(
        Effect.gen(function* () {
          const state = yield* load(flowId);
          const node = yield* requireNode(state, nodeId);
          if (!nodeSpecOf(state.run, nodeId).gate) {
            return yield* new FlowServiceError({ message: `"${nodeId}" has no gate.` });
          }
          if (node.status !== "needs_you") {
            return yield* new FlowServiceError({
              message: `"${nodeId}" is not waiting for review.`,
            });
          }
          yield* record(state.run, "gate.rerun", by, null, nodeId);
          return yield* saveNode(node, { status: "gating" });
        }),
      );
      if (claimed) yield* runGateFor(flowId, nodeId);
    });

  const killAll: FlowServiceShape["killAll"] = (by) =>
    Effect.gen(function* () {
      const runs = yield* list({ statuses: ["running", "paused"] });
      yield* Effect.forEach(runs, (run) => cancel(run.id, by), { discard: true });
      return runs.length;
    });

  const recover = Effect.gen(function* () {
    const runs = yield* list({ statuses: ["running"] });
    for (const run of runs) {
      const state = yield* load(run.id);
      for (const node of state.nodes) {
        if ((node.status === "running" || node.status === "gating") && node.threadId) {
          yield* reconcileThread(node.threadId);
        }
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
      // Budgets with a wall-clock limit need a clock even when no event arrives.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.minutes(1)).pipe(
            Effect.andThen(list({ statuses: ["running"] })),
            Effect.flatMap((runs) =>
              Effect.forEach(
                runs.filter((run) => run.spec.budget?.wallMs !== undefined),
                (run) => locked(tick(run.id)),
                { discard: true },
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("flow budget check failed", { cause: Cause.pretty(cause) }),
            ),
          ),
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
    approveNode,
    retryNode,
    rerunGate,
    killAll,
    reconcileThread,
    startReactor,
  } satisfies FlowServiceShape;
});

export const FlowServiceLive = Layer.effect(FlowService, make);
