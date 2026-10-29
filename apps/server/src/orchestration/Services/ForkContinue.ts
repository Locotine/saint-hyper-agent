// FILE: ForkContinue.ts
// Purpose: Moves a thread's work into a clean session that starts from a snapshot, with lineage
//          back to the source thread.
// Layer: Server service contract

import type { ThreadId } from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class ForkContinueError extends Data.TaggedError("ForkContinueError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ForkContinueShape {
  /** The snapshot text a clean session for `threadId` starts from. */
  readonly snapshot: (
    threadId: ThreadId,
    reason: string,
  ) => Effect.Effect<string, ForkContinueError>;
  /** Creates the clean thread, starts its first turn from the snapshot, returns its id. */
  readonly forkContinue: (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
  }) => Effect.Effect<ThreadId, ForkContinueError>;
}

export class ForkContinue extends ServiceMap.Service<ForkContinue, ForkContinueShape>()(
  "saint/orchestration/Services/ForkContinue",
) {}
