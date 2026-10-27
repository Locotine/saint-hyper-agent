import type { ExecutionEnvironmentDescriptor } from "@saint/contracts";
import { Effect, ServiceMap } from "effect";

export interface ServerEnvironmentShape {
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends ServiceMap.Service<
  ServerEnvironment,
  ServerEnvironmentShape
>()("saint/environment/Services/ServerEnvironment") {}
