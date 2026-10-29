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

export const AegisPolicyRule = Schema.Struct({
  effect: Schema.Literals(["permit", "forbid"]),
  /** Glob over the actor: `node:qa`, `thread:*`, `*`. */
  principal: TrimmedNonEmptyString,
  /** Gateway tool name or `egress`; globs allowed. */
  action: TrimmedNonEmptyString,
  /** Glob over the resource: a domain for egress, `*` otherwise. */
  resource: TrimmedNonEmptyString,
});
export type AegisPolicyRule = typeof AegisPolicyRule.Type;

export const AegisSettings = Schema.Struct({
  autonomy: AutonomyLevel,
  /** L3 needs a person to sign off; who did and when. */
  unattendedSignedOffBy: Schema.NullOr(Schema.String),
  egressAllowlist: Schema.Array(TrimmedNonEmptyString),
  egressDenylist: Schema.Array(TrimmedNonEmptyString),
  rules: Schema.Array(AegisPolicyRule),
});
export type AegisSettings = typeof AegisSettings.Type;

export const AegisStatus = Schema.Struct({
  settings: AegisSettings,
  layers: Schema.Array(AegisLayerStatus),
  /** Why each locked level is locked. */
  locked: Schema.Record(Schema.String, Schema.String),
  openAlerts: NonNegativeInt,
  egressProxyUrl: Schema.NullOr(Schema.String),
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
  egressAllowlist: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  egressDenylist: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  rules: Schema.optional(Schema.Array(AegisPolicyRule)),
});
