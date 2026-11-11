// FILE: _chat.office-3d.tsx
// Purpose: Registers the 3D Virtual Office route under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { Office3dView } from "~/components/office3d/Office3dView";

export const Route = createFileRoute("/_chat/office-3d")({
  component: Office3dView,
});
