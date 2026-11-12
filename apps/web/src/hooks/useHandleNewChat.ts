import type { ProjectId } from "@saint/contracts";
import { LOCAL_HOST_ID } from "@saint/shared/hostId";

import { useHostId } from "../hosts/hostScope";
import { ensureHomeChatProject } from "../lib/chatProjects";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewChat() {
  const hostId = useHostId();
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const { handleNewThread } = useHandleNewThread();

  const handleNewChat = async (options?: {
    fresh?: boolean;
    /**
     * The project a new chat opens in on another host (a host has no home chat of this
     * computer's); this computer's new chat ignores it and opens in the home chat.
     */
    hostProjectId?: ProjectId | null;
  }): Promise<StartContainerChatResult> => {
    if (hostId !== LOCAL_HOST_ID) {
      if (!options?.hostProjectId) {
        return { ok: false, error: "This host has no project to start a chat in." };
      }
      // Starts and opens the thread on the host, toasting when the host refuses.
      return { ok: true, threadId: await handleNewThread(options.hostProjectId) };
    }

    if (!homeDir) {
      return {
        ok: false,
        error: "Home folder is not available yet.",
      };
    }

    return startContainerChat({
      ensureProjectId: () => ensureHomeChatProject({ homeDir, chatWorkspaceRoot }),
      handleNewThread,
      fresh: options?.fresh,
      errorLabel: "Unable to prepare a new chat.",
    });
  };

  return { handleNewChat };
}
