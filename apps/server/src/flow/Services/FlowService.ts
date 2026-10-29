// FILE: FlowService.ts
// Purpose: Runs flow DAGs: starts a run from a spec, spawns one agent thread per node when the
//          scheduler says so, settles nodes when their turn ends, and resumes runs after restart.
// Layer: Server service contract

import type {
  FlowNodeRun,
  FlowRun,
  FlowRunId,
  FlowRunStatus,
  FlowSpec,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export class FlowServiceError extends Data.TaggedError("FlowServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FlowStartInput {
  readonly projectId: ProjectId;
  /** A decoded spec, or `flows/*.yaml` text. */
  readonly spec: FlowSpec | string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly startedBy: string;
}

export interface FlowRunView {
  readonly run: FlowRun;
  readonly nodes: ReadonlyArray<FlowNodeRun>;
  readonly approvedEdges: ReadonlyArray<string>;
}

export interface FlowServiceShape {
  readonly start: (input: FlowStartInput) => Effect.Effect<FlowRunView, FlowServiceError>;
  readonly get: (flowId: FlowRunId) => Effect.Effect<FlowRunView | null, FlowServiceError>;
  readonly list: (input: {
    readonly projectId?: ProjectId;
    readonly statuses?: ReadonlyArray<FlowRunStatus>;
  }) => Effect.Effect<ReadonlyArray<FlowRun>, FlowServiceError>;
  readonly cancel: (flowId: FlowRunId, by: string) => Effect.Effect<void, FlowServiceError>;
  readonly pause: (flowId: FlowRunId, by: string) => Effect.Effect<void, FlowServiceError>;
  readonly resume: (flowId: FlowRunId, by: string) => Effect.Effect<void, FlowServiceError>;
  readonly approveEdge: (input: {
    readonly flowId: FlowRunId;
    readonly from: string;
    readonly to: string;
    readonly by: string;
  }) => Effect.Effect<void, FlowServiceError>;
  /** Re-reads a node thread's latest turn and settles or fails its node. Idempotent. */
  readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void, FlowServiceError>;
  /** Recovers interrupted runs, then follows orchestration events. Call once at startup. */
  readonly startReactor: () => Effect.Effect<void, never, Scope.Scope>;
}

export class FlowService extends ServiceMap.Service<FlowService, FlowServiceShape>()(
  "saint/flow/Services/FlowService",
) {}
