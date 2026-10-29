// FILE: flow.ts
// Purpose: Flow DAG contracts — the frozen `flow-v1` spec, the schema'd handoff between nodes,
//          run/node state, and the hash-chained ledger that records every flow event.
// Layer: Shared contracts (server, web, agent gateway)

import { Schema } from "effect";

import {
  FlowRunId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ModelSelection, ProviderKind, RuntimeMode } from "./orchestration";

export const FLOW_SPEC_VERSION = "flow-v1";
export const FLOW_NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const FLOW_MAX_NODES = 64;
export const FLOW_DEFAULT_MAX_REFIX = 3;
export const FLOW_DEFAULT_MAX_PARALLEL = 3;
export const FLOW_DEFAULT_BREAKER_FAILURES = 3;
export const FLOW_DEFAULT_MAX_DEPTH = 8;
/** How deep agents may nest flows: a node of a depth-2 flow cannot start another. */
export const FLOW_MAX_NESTING_DEPTH = 2;

const FlowNodeKey = TrimmedNonEmptyString.check(Schema.isPattern(FLOW_NODE_ID_PATTERN));

/** manual: failures go to the user · gate_hold: always wait for approval · auto_refix: send the
 *  failure back up to `max_refix` times · autopilot: auto_refix that may also switch agent/provider. */
export const FlowNodeMode = Schema.Literals(["manual", "gate_hold", "auto_refix", "autopilot"]);
export type FlowNodeMode = typeof FlowNodeMode.Type;

export const FlowEdgePolicy = Schema.Literals(["auto", "hold"]);
export type FlowEdgePolicy = typeof FlowEdgePolicy.Type;

export const FlowEdgeWorkspace = Schema.Literals(["same", "fresh"]);
export type FlowEdgeWorkspace = typeof FlowEdgeWorkspace.Type;

export const FlowOnQuota = Schema.Literals(["switch", "ask", "wait"]);
export type FlowOnQuota = typeof FlowOnQuota.Type;

export const FlowGateSpec = Schema.Struct({
  id: FlowNodeKey,
  cmd: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  timeoutMs: Schema.optional(PositiveInt),
  /** Paths the agent must not edit; an edit holds the node for review whatever its mode. */
  protectedPaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(64)),
  ),
});
export type FlowGateSpec = typeof FlowGateSpec.Type;

export const FlowNodeSpec = Schema.Struct({
  id: FlowNodeKey,
  role: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  provider: Schema.optional(ProviderKind),
  model: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(FlowNodeMode),
  maxRefix: Schema.optional(NonNegativeInt),
  gate: Schema.optional(FlowGateSpec),
  onQuota: Schema.optional(FlowOnQuota),
});
export type FlowNodeSpec = typeof FlowNodeSpec.Type;

export const FlowEdgeSpec = Schema.Struct({
  from: FlowNodeKey,
  to: FlowNodeKey,
  policy: Schema.optional(FlowEdgePolicy),
  workspace: Schema.optional(FlowEdgeWorkspace),
});
export type FlowEdgeSpec = typeof FlowEdgeSpec.Type;

export const FlowBudget = Schema.Struct({
  maxParallel: Schema.optional(PositiveInt),
  maxDepth: Schema.optional(PositiveInt),
  breakerFailures: Schema.optional(PositiveInt),
  wallMs: Schema.optional(PositiveInt),
});
export type FlowBudget = typeof FlowBudget.Type;

/** Best first: zero_retention > no_training > standard. */
export const FlowDataTerms = Schema.Literals(["zero_retention", "no_training", "standard"]);
export type FlowDataTerms = typeof FlowDataTerms.Type;

export const FlowSpec = Schema.Struct({
  version: Schema.Literal(FLOW_SPEC_VERSION),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  nodes: Schema.Array(FlowNodeSpec).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FLOW_MAX_NODES),
  ),
  edges: Schema.Array(FlowEdgeSpec).check(Schema.isMaxLength(FLOW_MAX_NODES * 4)),
  budget: Schema.optional(FlowBudget),
  allowedProviders: Schema.optional(Schema.Array(ProviderKind)),
  /** How each provider treats your data; quota failover never moves to a lower tier. Unlisted
   *  providers count as `standard`. */
  dataTerms: Schema.optional(Schema.Record(ProviderKind, FlowDataTerms)),
});
export type FlowSpec = typeof FlowSpec.Type;

/** The five Orca task-spec fields, mandatory here, plus pointers instead of pasted prose. */
export const FlowHandoffV1 = Schema.Struct({
  target: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  change: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  constraints: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  ownership: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  acceptance: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  refs: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(32)),
  openQuestions: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(16)),
});
export type FlowHandoffV1 = typeof FlowHandoffV1.Type;

export const FlowNodeStatus = Schema.Literals([
  "pending",
  "ready",
  "running",
  "gating",
  "settled",
  "failed",
  "blocked",
  "needs_you",
]);
export type FlowNodeStatus = typeof FlowNodeStatus.Type;

export const FlowRunStatus = Schema.Literals([
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export type FlowRunStatus = typeof FlowRunStatus.Type;

export const FlowRun = Schema.Struct({
  id: FlowRunId,
  projectId: ProjectId,
  spec: FlowSpec,
  status: FlowRunStatus,
  statusReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  /** Applied to every node thread unless the node names its own provider/model. */
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** Node failures since the last node settled; trips the circuit breaker. */
  consecutiveFailures: NonNegativeInt,
  startedBy: TrimmedNonEmptyString,
  /** Gateway capabilities every node thread is capped at (the starting agent's own). */
  capabilityCeiling: Schema.optional(Schema.Array(Schema.String)),
  /** 0 for a flow a person started; a flow started from a flow node is one deeper. */
  nestingDepth: Schema.optional(NonNegativeInt),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FlowRun = typeof FlowRun.Type;

// ── Ledger ────────────────────────────────────────────────────────────────

/** 12 hex chars of a content hash, prefixed by its kind: `ev:b3f1c9a07e21`. */
export const LEDGER_HANDLE_PATTERN = /^[a-z]{1,8}:[0-9a-f]{12}$/;
export const LedgerHandle = TrimmedNonEmptyString.check(Schema.isPattern(LEDGER_HANDLE_PATTERN));
export type LedgerHandle = typeof LedgerHandle.Type;

export const LedgerTaint = Schema.Literals(["trusted", "internal", "untrusted"]);
export type LedgerTaint = typeof LedgerTaint.Type;

export const LedgerEvent = Schema.Struct({
  seq: PositiveInt,
  ts: IsoDateTime,
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  actor: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  flowId: Schema.NullOr(FlowRunId),
  nodeId: Schema.NullOr(Schema.String),
  payload: Schema.Unknown,
  prevHash: Schema.String,
  hash: Schema.String,
  sig: Schema.String,
});
export type LedgerEvent = typeof LedgerEvent.Type;

export const LedgerVerifyResult = Schema.Struct({
  intact: Schema.Boolean,
  count: NonNegativeInt,
  /** First sequence whose hash or signature does not match, when the chain is broken. */
  brokenAtSeq: Schema.NullOr(PositiveInt),
});
export type LedgerVerifyResult = typeof LedgerVerifyResult.Type;

export const FlowGateOutcome = Schema.Struct({
  gateId: TrimmedNonEmptyString,
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  durationMs: NonNegativeInt,
  /** Full gate output, read with `saint_get`. */
  evidence: LedgerHandle,
  protectedEdits: Schema.Array(Schema.String),
  finishedAt: IsoDateTime,
});
export type FlowGateOutcome = typeof FlowGateOutcome.Type;

export const FlowNodeRun = Schema.Struct({
  flowId: FlowRunId,
  nodeId: FlowNodeKey,
  status: FlowNodeStatus,
  threadId: Schema.NullOr(ThreadId),
  attempts: NonNegativeInt,
  depth: NonNegativeInt,
  statusReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  handoff: Schema.NullOr(FlowHandoffV1),
  /** Working-tree snapshot taken when the node started; protected-path edits count from here. */
  baselineRef: Schema.optional(Schema.NullOr(Schema.String)),
  lastGate: Schema.optional(Schema.NullOr(FlowGateOutcome)),
  /** Set by quota failover: the provider/model this step runs on instead of the spec's. */
  modelOverride: Schema.optional(Schema.NullOr(ModelSelection)),
  /** Providers this step already ran out of quota on. */
  quotaExhausted: Schema.optional(Schema.Array(ProviderKind)),
  /** The node thread's turn Saint last acted on, so a stale turn is never handled twice. */
  lastTurnId: Schema.optional(Schema.NullOr(Schema.String)),
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type FlowNodeRun = typeof FlowNodeRun.Type;

// ── RPC ───────────────────────────────────────────────────────────────────

export const FlowRunView = Schema.Struct({
  run: FlowRun,
  nodes: Schema.Array(FlowNodeRun),
  approvedEdges: Schema.Array(Schema.String),
});
export type FlowRunView = typeof FlowRunView.Type;

export const FlowListInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export const FlowListResult = Schema.Struct({ runs: Schema.Array(FlowRun) });
export const FlowGetInput = Schema.Struct({ flowId: FlowRunId });
export const FlowGetResult = Schema.Struct({ view: Schema.NullOr(FlowRunView) });

/** Start from a template (template + goal) or from flow-v1 YAML (spec). */
export const FlowStartRpcInput = Schema.Struct({
  projectId: ProjectId,
  template: Schema.optional(TrimmedNonEmptyString),
  goal: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
  gateCmd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  spec: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(100_000))),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type FlowStartRpcInput = typeof FlowStartRpcInput.Type;

export const FlowAction = Schema.Literals([
  "pause",
  "resume",
  "cancel",
  "approveEdge",
  "approveNode",
  "retryNode",
  "rerunGate",
  "continueNode",
]);
export type FlowAction = typeof FlowAction.Type;

export const FlowActionInput = Schema.Struct({
  flowId: FlowRunId,
  action: FlowAction,
  /** approveNode / retryNode / rerunGate / continueNode. */
  nodeId: Schema.optional(TrimmedNonEmptyString),
  /** approveEdge. */
  from: Schema.optional(TrimmedNonEmptyString),
  to: Schema.optional(TrimmedNonEmptyString),
});
export type FlowActionInput = typeof FlowActionInput.Type;
export const FlowActionResult = Schema.Struct({ view: Schema.NullOr(FlowRunView) });

export const FlowKillAllInput = Schema.Struct({});
export const FlowKillAllResult = Schema.Struct({ cancelled: NonNegativeInt });

export const FlowTemplateSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
});
export const FlowTemplatesInput = Schema.Struct({});
export const FlowTemplatesResult = Schema.Struct({ templates: Schema.Array(FlowTemplateSummary) });

export const LedgerListInput = Schema.Struct({
  flowId: FlowRunId,
  afterSeq: Schema.optional(NonNegativeInt),
});
export const LedgerListResult = Schema.Struct({ events: Schema.Array(LedgerEvent) });
export const LedgerVerifyInput = Schema.Struct({});
export const LedgerExportInput = Schema.Struct({});
export const LedgerExportResult = Schema.Struct({ jsonl: Schema.String });
export const LedgerHandleInput = Schema.Struct({
  handle: LedgerHandle,
  fromLine: Schema.optional(PositiveInt),
  toLine: Schema.optional(PositiveInt),
});
export const LedgerHandleResult = Schema.Struct({
  handle: Schema.NullOr(
    Schema.Struct({
      handle: LedgerHandle,
      mime: Schema.String,
      provenance: Schema.String,
      taint: LedgerTaint,
      createdAt: IsoDateTime,
      size: NonNegativeInt,
      content: Schema.String,
      totalLines: NonNegativeInt,
    }),
  ),
});
