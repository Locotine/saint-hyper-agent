// FILE: _chat.flows.$flowId.tsx
// Purpose: One flow's Canvas and Mission Control; `new` opens a blank or saved draft.
// Layer: Route
// Exports: Route

import { ProjectId } from "@saint/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FlowView } from "~/components/flows/FlowView";

interface FlowRouteSearch {
  projectId?: ProjectId | undefined;
  path?: string | undefined;
}

function FlowRouteView() {
  const { flowId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <FlowView
      key={flowId}
      flowId={flowId}
      projectId={search.projectId ?? null}
      specPath={search.path ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/flows/$flowId")({
  validateSearch: (raw: Record<string, unknown>): FlowRouteSearch => ({
    ...(typeof raw.projectId === "string"
      ? { projectId: ProjectId.makeUnsafe(raw.projectId) }
      : {}),
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
  }),
  component: FlowRouteView,
});
