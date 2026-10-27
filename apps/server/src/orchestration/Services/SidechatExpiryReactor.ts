import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { ThreadId } from "@saint/contracts";

export interface SidechatExpiryReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly viewStarted: (threadId: ThreadId) => Effect.Effect<void>;
  readonly viewEnded: (threadId: ThreadId) => Effect.Effect<void>;
}

export class SidechatExpiryReactor extends ServiceMap.Service<
  SidechatExpiryReactor,
  SidechatExpiryReactorShape
>()("saint/orchestration/Services/SidechatExpiryReactor") {}
