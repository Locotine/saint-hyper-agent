import { ServiceMap } from "effect";

export interface ProjectAgentReactorShape {
  readonly ready: true;
}

export class ProjectAgentReactor extends ServiceMap.Service<
  ProjectAgentReactor,
  ProjectAgentReactorShape
>()("saint/projectAgent/Services/ProjectAgentReactor") {}
