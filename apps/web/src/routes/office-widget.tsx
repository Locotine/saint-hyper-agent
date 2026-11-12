// FILE: office-widget.tsx
// Purpose: Registers the floating office window's route outside the chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { OfficeWidgetView } from "~/components/office/OfficeWidgetView";

export const Route = createFileRoute("/office-widget")({
  component: OfficeWidgetView,
});
