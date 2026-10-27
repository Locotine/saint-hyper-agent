import type { ServerAuthDescriptor } from "@saint/contracts";
import { Effect, ServiceMap } from "effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends ServiceMap.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "saint/auth/Services/ServerAuthPolicy",
) {}
