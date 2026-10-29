// FILE: _chat.host-economy.tsx
// Purpose: Registers Host Economy under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { HostEconomyView } from "~/components/hostEconomy/HostEconomyView";

export const Route = createFileRoute("/_chat/host-economy")({
  component: HostEconomyView,
});
