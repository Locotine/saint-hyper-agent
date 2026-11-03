// FILE: _chat.cyber-security.$projectId.tsx
// Purpose: Registers one project's Cyber Security screen under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import type { ProjectId } from "@saint/contracts";

import { CyberSecurityView } from "~/components/cyberSecurity/CyberSecurityView";

function CyberSecurityProjectRouteView() {
  const { projectId } = Route.useParams();
  return <CyberSecurityView projectId={projectId as ProjectId} />;
}

export const Route = createFileRoute("/_chat/cyber-security/$projectId")({
  component: CyberSecurityProjectRouteView,
});
