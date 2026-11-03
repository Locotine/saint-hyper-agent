// FILE: useFixInChat.ts
// Purpose: "Fix" and "Fix all": starts a chat in the finding's project on its host, sends the fix
//          prompt as the first turn, marks the findings
//          "fixing", and opens the chat.
// Layer: Web cyber security hook
// Exports: useFixInChat

import type { CyberFinding, CyberSecurityStatus, ProjectId } from "@saint/contracts";
import { scopeThread } from "@saint/shared/hostId";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "~/components/ui/toast";
import { createHostThread } from "~/hosts/hostThreadCreate";
import { hostHandle, useHostId } from "~/hosts/hostScope";
import { DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { flowQueryKeys } from "~/lib/flowQueryOptions";
import { newCommandId, newMessageId } from "~/lib/utils";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "~/types";
import { buildFixPrompt } from "./cyberSecurity.logic";

export function useFixInChat(projectId: ProjectId) {
  const hostId = useHostId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { readonly findings: ReadonlyArray<CyberFinding> }) => {
      const api = hostHandle(hostId).requireApi();
      const queryKey = flowQueryKeys.cyberSecurity(hostId, projectId);
      // The cards glide into Fixing at once; the chat opens after they have landed.
      await queryClient.cancelQueries({ queryKey });
      const ids = new Set(input.findings.map((finding) => finding.id));
      queryClient.setQueryData<CyberSecurityStatus>(queryKey, (current) =>
        current
          ? {
              ...current,
              findings: current.findings.map((finding) =>
                ids.has(finding.id) ? { ...finding, status: "fixing" } : finding,
              ),
            }
          : current,
      );
      const shownAt = Date.now();
      const threadId = await createHostThread(hostId, projectId);
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildFixPrompt(input.findings),
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        createdAt: new Date().toISOString(),
      });
      await Promise.all(
        input.findings
          .filter((finding) => finding.status !== "fixing")
          .map((finding) =>
            api.cyberSecurity.setFindingStatus({
              projectId,
              findingId: finding.id,
              status: "fixing",
              fixThreadId: threadId,
            }),
          ),
      );
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const landing = DISCLOSURE_TRANSITION_MS + 40 * (input.findings.length - 1) + 300;
      const remaining = reduceMotion ? 0 : landing - (Date.now() - shownAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      await navigate({ to: "/$threadId", params: { threadId: scopeThread(hostId, threadId) } });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: flowQueryKeys.cyberSecurity(hostId, projectId) }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't open the fix chat",
        description: error instanceof Error ? error.message : "Try again.",
      }),
  });
}
