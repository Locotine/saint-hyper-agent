// FILE: _chat.security.tsx
// Purpose: Registers the Security screen under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { SecurityView } from "~/components/security/SecurityView";

export const Route = createFileRoute("/_chat/security")({
  component: SecurityView,
});
