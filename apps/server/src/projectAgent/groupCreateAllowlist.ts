import type { ProjectId } from "@saint/contracts";

export function isAllowedGroupCoordinatorCreateTarget(input: {
  readonly targetProjectId: ProjectId;
  readonly groupProjectId: ProjectId;
  readonly linkedProjectIds: ReadonlyArray<ProjectId>;
}): boolean {
  return (
    input.targetProjectId === input.groupProjectId ||
    input.linkedProjectIds.includes(input.targetProjectId)
  );
}
