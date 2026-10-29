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
import { ProviderKind } from "./orchestration";

export const FLOW_SPEC_VERSION = "flow-v1";
export const FLOW_NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const FLOW_MAX_NODES = 64;
export const FLOW_DEFAULT_MAX_REFIX = 3;
export const FLOW_DEFAULT_MAX_PARALLEL = 3;
export const FLOW_DEFAULT_BREAKER_FAILURES = 3;
export const FLOW_DEFAULT_MAX_DEPTH = 8;

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
  startedBy: TrimmedNonEmptyString,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FlowRun = typeof FlowRun.Type;

export const FlowNodeRun = Schema.Struct({
  flowId: FlowRunId,
  nodeId: FlowNodeKey,
  status: FlowNodeStatus,
  threadId: Schema.NullOr(ThreadId),
  attempts: NonNegativeInt,
  depth: NonNegativeInt,
  statusReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  handoff: Schema.NullOr(FlowHandoffV1),
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type FlowNodeRun = typeof FlowNodeRun.Type;

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
