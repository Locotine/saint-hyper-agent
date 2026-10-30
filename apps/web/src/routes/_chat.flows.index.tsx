// FILE: _chat.flows.index.tsx
// Purpose: Registers the Flows landing page under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { FlowsIndexView } from "~/components/flows/FlowsIndexView";

export const Route = createFileRoute("/_chat/flows/")({
  component: FlowsIndexView,
});
