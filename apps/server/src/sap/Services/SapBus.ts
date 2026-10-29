// FILE: SapBus.ts
// Purpose: Carries SAP messages between the agents of a flow: answers state questions itself,
//          marks claims without evidence, stops hop and loop runaways, and delivers the rest to
//          the receiving agent's thread as one queued turn.
// Layer: Server service contract

import type { FlowRunId, SapAct, SapMessage, SapStats, SapTopic, ThreadId } from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class SapBusError extends Data.TaggedError("SapBusError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SapSendInput {
  readonly fromThreadId: ThreadId;
  /** A node id of the sender's flow, or `user`. */
  readonly to: string;
  readonly act: SapAct;
  readonly topic?: SapTopic;
  readonly body: string;
  readonly refs?: ReadonlyArray<string>;
}

export interface SapReplyInput {
  readonly fromThreadId: ThreadId;
  readonly messageId: string;
  readonly body: string;
  readonly refs?: ReadonlyArray<string>;
}

export interface SapBusShape {
  readonly send: (input: SapSendInput) => Effect.Effect<SapMessage, SapBusError>;
  readonly reply: (input: SapReplyInput) => Effect.Effect<SapMessage, SapBusError>;
  readonly list: (
    flowId: FlowRunId,
  ) => Effect.Effect<
    { readonly messages: ReadonlyArray<SapMessage>; readonly stats: SapStats },
    SapBusError
  >;
}

export class SapBus extends ServiceMap.Service<SapBus, SapBusShape>()(
  "saint/sap/Services/SapBus",
) {}
