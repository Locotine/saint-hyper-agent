// FILE: Ledger.ts
// Purpose: The Saint Ledger — append-only, hash-chained, Ed25519-signed event log (flow event
//          store and audit log in one) plus content-addressed handles that agents pass instead
//          of pasting logs and diffs.
// Layer: Server service contract

import type {
  FlowRunId,
  LedgerEvent,
  LedgerHandle,
  LedgerTaint,
  LedgerVerifyResult,
} from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class LedgerError extends Data.TaggedError("LedgerError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface LedgerAppendInput {
  readonly kind: string;
  readonly actor: string;
  readonly flowId?: FlowRunId | null;
  readonly nodeId?: string | null;
  readonly payload: unknown;
}

export interface LedgerPutHandleInput {
  /** Short handle prefix: `ev` evidence, `diff`, `plan`, `h` handoff, `log`… */
  readonly kind: string;
  readonly content: string;
  readonly mime: string;
  readonly provenance: string;
  readonly taint: LedgerTaint;
  readonly createdBy: string;
}

export interface LedgerHandleRecord {
  readonly handle: LedgerHandle;
  readonly mime: string;
  readonly provenance: string;
  readonly taint: LedgerTaint;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly size: number;
  /** The requested line range (1-based, inclusive) or the whole content. */
  readonly content: string;
  readonly totalLines: number;
}

export interface LedgerShape {
  readonly append: (input: LedgerAppendInput) => Effect.Effect<LedgerEvent, LedgerError>;
  readonly listByFlow: (
    flowId: FlowRunId,
    afterSeq?: number,
  ) => Effect.Effect<ReadonlyArray<LedgerEvent>, LedgerError>;
  readonly verify: () => Effect.Effect<LedgerVerifyResult, LedgerError>;
  /** One JSON event per line, oldest first, with the public key on the first line. */
  readonly exportJsonl: () => Effect.Effect<string, LedgerError>;
  readonly putHandle: (input: LedgerPutHandleInput) => Effect.Effect<LedgerHandle, LedgerError>;
  readonly getHandle: (
    handle: LedgerHandle,
    lines?: { readonly from: number; readonly to: number },
  ) => Effect.Effect<LedgerHandleRecord | null, LedgerError>;
}

export class Ledger extends ServiceMap.Service<Ledger, LedgerShape>()(
  "saint/ledger/Services/Ledger",
) {}
