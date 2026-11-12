// FILE: _chat.office-3d.tsx
// Purpose: Registers the virtual office route under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { OfficeView } from "~/components/office/OfficeView";

export const Route = createFileRoute("/_chat/office-3d")({
  component: OfficeView,
});
