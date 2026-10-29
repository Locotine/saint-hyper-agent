// FILE: SampleFlowStep.tsx
// Purpose: Onboarding step "Run a sample flow": the Flows template starter on the project the
//          user just added, so the first flow runs before the tour ends.
// Layer: Onboarding step
// Exports: SampleFlowStep

import type { ProjectId } from "@saint/contracts";

import { FlowTemplateStarter } from "~/components/flows/FlowsIndexView";

export function SampleFlowStep(props: {
  projectId: ProjectId | null;
  started: boolean;
  onStarted: () => void;
}) {
  if (!props.projectId) {
    return (
      <p className="text-ui text-muted-foreground">
        Add a project in the previous step to run a sample flow, or open Flows later from the
        sidebar.
      </p>
    );
  }
  if (props.started) {
    return (
      <p className="text-ui text-foreground">
        Your flow is running. Follow it from Flows in the sidebar once setup is done.
      </p>
    );
  }
  return <FlowTemplateStarter projectId={props.projectId} onStarted={props.onStarted} />;
}
