// FILE: PendingRemoteThreadOpener.tsx
// Purpose: Opens the thread picked in the Remote hosts sidebar once the window has reloaded onto that host.
// Layer: App shell (renders nothing)
// Exports: PendingRemoteThreadOpener

import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { remoteWindowHost } from "../env";
import { takePendingRemoteThread } from "../lib/pendingRemoteThread";

export function PendingRemoteThreadOpener() {
  const navigate = useNavigate();
  useEffect(() => {
    const threadId = takePendingRemoteThread(remoteWindowHost);
    if (threadId) void navigate({ to: "/$threadId", params: { threadId } });
  }, [navigate]);
  return null;
}
