// FILE: Economy.ts
// Purpose: Host economy: samples memory and agent processes, hibernates idle agents, and tells
//          the flow scheduler when a new step must wait.
// Layer: Server service contract

import type { EconomyStatus, EconomyUpdateInput, ThreadId } from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export class EconomyError extends Data.TaggedError("EconomyError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface EconomyShape {
  readonly status: () => Effect.Effect<EconomyStatus, EconomyError>;
  readonly agent: (
    threadId: ThreadId,
    action: "hibernate" | "wake",
  ) => Effect.Effect<EconomyStatus, EconomyError>;
  readonly update: (
    input: typeof EconomyUpdateInput.Type,
  ) => Effect.Effect<EconomyStatus, EconomyError>;
  /** Samples every minute and hibernates idle agents; wakes them on their next message. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class Economy extends ServiceMap.Service<Economy, EconomyShape>()(
  "saint/economy/Services/Economy",
) {}

// The flow scheduler lives below the provider layer that Economy needs, so the latest admission
// verdict is shared through this module rather than through the service graph (the same way the
// egress proxy reaches provider processes).
let admission: string | null = null;
let refusal: string | null = null;

/** Why a new flow step must wait right now, or null to start it. */
export const currentFlowAdmission = (): string | null => admission;
/** Why an agent may not start a child thread right now (critical memory or full seats). */
export const currentSpawnRefusal = (): string | null => refusal;
export const setFlowAdmission = (reason: string | null, hard = false): void => {
  admission = reason;
  refusal = hard ? reason : null;
};
