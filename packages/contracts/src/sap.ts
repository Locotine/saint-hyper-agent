// FILE: sap.ts
// Purpose: Saint Agent Protocol — typed messages between the agents of one flow. Messages carry
//          handles instead of pasted text; state questions are answered by Saint without a model.
// Layer: Shared contracts (server, web, agent gateway)

import { Schema } from "effect";

import { FlowRunId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const SAP_MAX_HOPS = 6;

export const SapAct = Schema.Literals([
  "ASK",
  "TELL",
  "CLAIM",
  "PROPOSE",
  "VERIFY",
  "ESCALATE",
  "DONE",
]);
export type SapAct = typeof SapAct.Type;

/** What an ASK is about. Every topic but `free` is answered from flow state, at 0 tokens. */
export const SapTopic = Schema.Literals([
  "status",
  "gate",
  "handoff",
  "ownership",
  "budget",
  "free",
]);
export type SapTopic = typeof SapTopic.Type;

/** pending: waiting for the receiver · delivered: in the receiver's thread · answered: replied ·
 *  dropped: refused (hop limit or a repeated loop). */
export const SapState = Schema.Literals(["pending", "delivered", "answered", "dropped"]);
export type SapState = typeof SapState.Type;

export const SapMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  flowId: FlowRunId,
  /** Node ids inside the flow; `user` for a person. */
  from: TrimmedNonEmptyString,
  to: TrimmedNonEmptyString,
  act: SapAct,
  topic: Schema.NullOr(SapTopic),
  body: Schema.String.check(Schema.isMaxLength(4_000)),
  refs: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(32)),
  replyTo: Schema.NullOr(TrimmedNonEmptyString),
  hops: NonNegativeInt,
  state: SapState,
  stateReason: Schema.NullOr(Schema.String),
  /** `saint` when the resolver answered without a model. */
  answeredBy: Schema.NullOr(Schema.Literals(["saint", "agent"])),
  answer: Schema.NullOr(Schema.String),
  /** CLAIM only: false when it cites no Saint handle as evidence. */
  verified: Schema.NullOr(Schema.Boolean),
  createdAt: IsoDateTime,
});
export type SapMessage = typeof SapMessage.Type;

export const SapStats = Schema.Struct({
  asks: NonNegativeInt,
  answeredBySaint: NonNegativeInt,
  unverifiedClaims: NonNegativeInt,
  dropped: NonNegativeInt,
});
export type SapStats = typeof SapStats.Type;

export const SapListInput = Schema.Struct({ flowId: FlowRunId });
export const SapListResult = Schema.Struct({
  messages: Schema.Array(SapMessage),
  stats: SapStats,
});
