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

export interface AegisKillInput {
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly flowId?: FlowRunId | null;
  readonly reason: string;
  readonly by: string;
  /** Worktrees Saint created for the killed work; frozen read-only (never a user's checkout). */
  readonly worktrees?: ReadonlyArray<string>;
}

export interface AegisKillReport {
  readonly threads: number;
  readonly processes: number;
  readonly forced: number;
  readonly frozen: ReadonlyArray<string>;
  /** Time until every process was gone and capabilities were revoked. */
  readonly stopMs: number;
  /** Including the worktree freeze and the ledger write. */
  readonly totalMs: number;
}

export interface AegisFlowPrincipal {
  readonly flowId: string;
  readonly nodeId: string;
  readonly autopilot: boolean;
  /** The flow's Saint-managed worktree, frozen by a kill. */
  readonly worktree: string | null;
}

export type AegisPrincipalResolver = (threadId: string) => Effect.Effect<AegisFlowPrincipal | null>;

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
    readonly threadId?: ThreadId | null;
  }) => Effect.Effect<GateSandbox | null, AegisError>;
  /**
   * Cedar check before a gateway tool runs. A forbid refuses the call and raises a
   * `capability_denied` alert.
   */
  readonly authorizeTool: (input: {
    readonly threadId: string;
    readonly tool: string;
  }) => Effect.Effect<{ readonly allowed: boolean; readonly reason: string }>;
  /** Of these protected-zone edits, the ones Cedar did not permit for the thread. */
  readonly unpermittedWrites: (input: {
    readonly threadId: string;
    readonly paths: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * The kill switch: revoke Saint capabilities (persisted), kill the provider process trees,
   * interrupt the turns, freeze Saint-managed worktrees and write a ledger record.
   */
  readonly kill: (input: AegisKillInput) => Effect.Effect<AegisKillReport, AegisError>;
  readonly unfreeze: (id: string, by: string) => Effect.Effect<AegisStatus, AegisError>;
  /** Called with each killed thread, e.g. to cancel its flow. */
  readonly onKill: (handler: (threadId: ThreadId) => Effect.Effect<void>) => void;
  /** Maps a thread to its flow step (Cedar principal, autopilot), installed by the flow service. */
  readonly setPrincipalResolver: (resolver: AegisPrincipalResolver) => void;
  /** Starts the egress proxy (when the level needs it) and the tripwire watcher. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class Aegis extends ServiceMap.Service<Aegis, AegisShape>()("saint/aegis/Services/Aegis") {}
