// FILE: _chat.cyber-security.index.tsx
// Purpose: Registers the Cyber Security entry page (project picker) under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { CyberSecurityOverview } from "~/components/cyberSecurity/CyberSecurityOverview";

export const Route = createFileRoute("/_chat/cyber-security/")({
  component: CyberSecurityOverview,
});
