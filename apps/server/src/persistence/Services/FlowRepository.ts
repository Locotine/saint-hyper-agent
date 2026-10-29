/**
 * Durable flow runs: the frozen spec and run state, one row per node, and the hold edges a
 * person approved. Writes check `revision` so two schedulers never both advance a node.
 */
import type {
  FlowNodeRun,
  FlowRun,
  FlowRunId,
  FlowRunStatus,
  ProjectId,
  ThreadId,
} from "@saint/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type FlowRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface FlowRunState {
  readonly run: FlowRun;
  readonly nodes: ReadonlyArray<FlowNodeRun>;
  readonly approvedEdges: ReadonlySet<string>;
}

export interface FlowRepositoryShape {
  /** Inserts the run and its node rows atomically. */
  readonly create: (
    run: FlowRun,
    nodes: ReadonlyArray<FlowNodeRun>,
  ) => Effect.Effect<void, FlowRepositoryError>;

  readonly get: (flowId: FlowRunId) => Effect.Effect<FlowRunState | null, FlowRepositoryError>;

  readonly list: (input: {
    readonly projectId?: ProjectId;
    readonly statuses?: ReadonlyArray<FlowRunStatus>;
  }) => Effect.Effect<ReadonlyArray<FlowRun>, FlowRepositoryError>;

  /** Writes `run` when the stored revision is `run.revision - 1`; false on a lost race. */
  readonly saveRun: (run: FlowRun) => Effect.Effect<boolean, FlowRepositoryError>;

  /** Writes `node` when the stored revision is `node.revision - 1`; false on a lost race. */
  readonly saveNode: (node: FlowNodeRun) => Effect.Effect<boolean, FlowRepositoryError>;

  readonly approveEdge: (input: {
    readonly flowId: FlowRunId;
    readonly edgeKey: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
  }) => Effect.Effect<void, FlowRepositoryError>;

  readonly findNodeByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<FlowNodeRun | null, FlowRepositoryError>;
}

export class FlowRepository extends ServiceMap.Service<FlowRepository, FlowRepositoryShape>()(
  "saint/persistence/Services/FlowRepository/FlowRepository",
) {}
