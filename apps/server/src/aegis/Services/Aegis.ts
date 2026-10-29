// FILE: Aegis.ts
// Purpose: Saint's security layer: hard-rule alerts, the autonomy ladder, the egress allowlist
//          and proxy, the gate sandbox, and tripwires that stop an agent touching credentials.
// Layer: Server service contract

import type {
  AegisAlert,
  AegisAlertKind,
  AegisSettings,
  AegisSeverity,
  AegisStatus,
  FlowRunId,
  RuntimeMode,
  ThreadId,
} from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type { AegisUpdateInput } from "@saint/contracts";

export class AegisError extends Data.TaggedError("AegisError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AegisRaiseInput {
  readonly kind: AegisAlertKind;
  readonly severity: AegisSeverity;
  readonly title: string;
  readonly detail: string;
  readonly why: ReadonlyArray<string>;
  readonly flowId?: FlowRunId | null;
  readonly nodeId?: string | null;
  readonly threadId?: ThreadId | null;
  readonly domain?: string | null;
  /** Alerts with nothing to decide start as `noted`. */
  readonly decidable?: boolean;
}

export interface GateSandbox {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
}

export interface AegisShape {
  readonly status: () => Effect.Effect<AegisStatus, AegisError>;
  readonly settings: () => Effect.Effect<AegisSettings, AegisError>;
  readonly update: (
    input: typeof AegisUpdateInput.Type,
    by: string,
  ) => Effect.Effect<AegisStatus, AegisError>;
  readonly alerts: (
    includeResolved: boolean,
  ) => Effect.Effect<ReadonlyArray<AegisAlert>, AegisError>;
  readonly raise: (input: AegisRaiseInput) => Effect.Effect<AegisAlert, AegisError>;
  readonly resolve: (
    ids: ReadonlyArray<string>,
    decision: "allow" | "deny" | "note",
    by: string,
  ) => Effect.Effect<ReadonlyArray<AegisAlert>, AegisError>;
  /** The approval mode a flow step may use at the current autonomy level. */
  readonly capRuntimeMode: (requested: RuntimeMode) => Effect.Effect<RuntimeMode, AegisError>;
  /** How to run a gate command sandboxed, or null when the level does not require it. */
  readonly gateSandbox: (input: {
    readonly cwd: string;
    readonly command: string;
  }) => Effect.Effect<GateSandbox | null, AegisError>;
  /** Called with the thread a tripwire fired on, e.g. to cancel its flow. */
  readonly onKill: (handler: (threadId: ThreadId) => Effect.Effect<void>) => void;
  /** Starts the egress proxy (when the level needs it) and the tripwire watcher. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class Aegis extends ServiceMap.Service<Aegis, AegisShape>()("saint/aegis/Services/Aegis") {}
