// FILE: useHostThreadActions.ts
// Purpose: Starts a thread in a connected host's project (or adds a project on the host first)
//          and opens it in this window, toasting when the host refuses.
// Layer: Hook
// Exports: useHostThreadActions

import type { ProjectId } from "@saint/contracts";
import { scopeThread, type HostId } from "@saint/shared/hostId";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import { addHostProject, createHostThread } from "~/hosts/hostThreadCreate";

export function useHostThreadActions() {
  const navigate = useNavigate();

  const startThread = useCallback(
    async (hostId: HostId, host: string, projectId: ProjectId) => {
      try {
        const threadId = await createHostThread(hostId, projectId);
        await navigate({ to: "/$threadId", params: { threadId: scopeThread(hostId, threadId) } });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not start a thread on ${host}`,
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [navigate],
  );

  /** Picks a folder on the host, adds it as a project there, then starts a thread in it. */
  const startThreadInNewProject = useCallback(
    async (hostId: HostId, host: string) => {
      try {
        const projectId = await addHostProject(hostId, host);
        if (projectId) await startThread(hostId, host, projectId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not add the project on ${host}`,
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [startThread],
  );

  return { startThread, startThreadInNewProject };
}
