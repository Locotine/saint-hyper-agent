// FILE: aegis.ts
// Purpose: Aegis security contracts — hard-rule alerts, the L0–L4 autonomy ladder, the egress
//          allowlist, and the live status of each protection layer.
// Layer: Shared contracts (server, web)

import { Schema } from "effect";

import {
  FlowRunId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/** L0 suggest · L1 worktree · L2 allowlist · L3 unattended · L4 self-planning (locked). */
export const AutonomyLevel = Schema.Literals(["L0", "L1", "L2", "L3", "L4"]);
export type AutonomyLevel = typeof AutonomyLevel.Type;

export const AegisAlertKind = Schema.Literals([
  "gate_file_edited",
  "claim_unverified",
  "breaker",
  "capability_denied",
  "new_domain",
  "tripwire",
  "rule_of_two",
]);
export type AegisAlertKind = typeof AegisAlertKind.Type;

export const AegisSeverity = Schema.Literals(["critical", "high", "medium", "low"]);
export type AegisSeverity = typeof AegisSeverity.Type;

/** open: waits for a person · allowed / denied: decided · noted: acknowledged, nothing to decide. */
export const AegisAlertState = Schema.Literals(["open", "allowed", "denied", "noted"]);
export type AegisAlertState = typeof AegisAlertState.Type;

export const AegisAlert = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: AegisAlertKind,
  severity: AegisSeverity,
  title: TrimmedNonEmptyString,
  detail: Schema.String,
  /** The "why" chain: each line one hop from the cause to this alert. */
  why: Schema.Array(Schema.String),
  flowId: Schema.NullOr(FlowRunId),
  nodeId: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  /** new_domain: the host asked for. */
  domain: Schema.NullOr(TrimmedNonEmptyString),
  state: AegisAlertState,
  decidedBy: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AegisAlert = typeof AegisAlert.Type;

export const AegisLayerStatus = Schema.Struct({
  id: Schema.Literals(["sandbox", "egress", "policy", "tripwire", "ledger", "capabilities"]),
  enabled: Schema.Boolean,
  available: Schema.Boolean,
  detail: Schema.String,
});
export type AegisLayerStatus = typeof AegisLayerStatus.Type;

/** Aegis policy, version 1: Cedar text plus the egress lists and the protected zones. */
export const PolicyV1 = Schema.Struct({
  version: Schema.Literal(1),
  /**
   * Cedar policies. Principals are `Saint::Thread::"<threadId>"` or `Saint::Node::"<flowId>/<nodeId>"`
   * (a member of `Saint::Flow::"<flowId>"`); actions are `Saint::Action::"<gateway tool>"`,
   * `Saint::Action::"egress"` (resource `Saint::Host::"<host>"`) and `Saint::Action::"write"`
   * (resource `Saint::Path::"<path relative to the workspace>"`).
   */
  cedar: Schema.String,
  egressAllowlist: Schema.Array(TrimmedNonEmptyString),
  egressDenylist: Schema.Array(TrimmedNonEmptyString),
  /** Workspace globs (`**` crosses folders) an agent may write only when Cedar permits it. */
  protectedZones: Schema.Array(TrimmedNonEmptyString),
});
export type PolicyV1 = typeof PolicyV1.Type;

export const AegisSettings = Schema.Struct({
  autonomy: AutonomyLevel,
  /** L3 needs a person to sign off; who did and when. */
  unattendedSignedOffBy: Schema.NullOr(Schema.String),
  policy: PolicyV1,
  /** Threads a person chose to run without the OS sandbox ("Run without sandbox"). */
  unsandboxedThreads: Schema.Array(ThreadId),
});
export type AegisSettings = typeof AegisSettings.Type;

/** A worktree the kill switch made read-only; Unfreeze restores the recorded modes. */
export const AegisFrozenWorktree = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  threadId: Schema.NullOr(ThreadId),
  flowId: Schema.NullOr(FlowRunId),
  files: NonNegativeInt,
  frozenAt: IsoDateTime,
});
export type AegisFrozenWorktree = typeof AegisFrozenWorktree.Type;

export const AegisStatus = Schema.Struct({
  settings: AegisSettings,
  layers: Schema.Array(AegisLayerStatus),
  /** Why each locked level is locked. */
  locked: Schema.Record(Schema.String, Schema.String),
  openAlerts: NonNegativeInt,
  /** One proxy port per provider session while egress control is on. */
  egressSessions: NonNegativeInt,
  /** Threads whose Saint capabilities the kill switch revoked (kept across restarts). */
  revokedThreads: Schema.Array(ThreadId),
  frozen: Schema.Array(AegisFrozenWorktree),
});
export type AegisStatus = typeof AegisStatus.Type;

export const AegisStatusInput = Schema.Struct({});
export const AegisAlertsInput = Schema.Struct({
  includeResolved: Schema.optional(Schema.Boolean),
});
export const AegisAlertsResult = Schema.Struct({ alerts: Schema.Array(AegisAlert) });
export const AegisResolveInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  decision: Schema.Literals(["allow", "deny", "note"]),
});
export const AegisUpdateInput = Schema.Struct({
  autonomy: Schema.optional(AutonomyLevel),
  signOffUnattended: Schema.optional(Schema.Boolean),
  /** Fields left out keep their value; the Cedar text is validated before it is saved. */
  policy: Schema.optional(
    Schema.Struct({
      cedar: Schema.optional(Schema.String),
      egressAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      egressDenylist: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      protectedZones: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
  ),
  /** "Run without sandbox" for one thread; takes effect on its next provider session. */
  runWithoutSandbox: Schema.optional(
    Schema.Struct({ threadId: ThreadId, enabled: Schema.Boolean }),
  ),
});
export const AegisUnfreezeInput = Schema.Struct({ id: TrimmedNonEmptyString });
