import { Effect, ServiceMap } from "effect";

export interface ProjectFaviconResolverShape {
  readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
}

export class ProjectFaviconResolver extends ServiceMap.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("saint/project/Services/ProjectFaviconResolver") {}
