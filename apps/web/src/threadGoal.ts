import { type ThreadGoalStartBehavior, type ThreadId } from "@saint/contracts";

import { newCommandId } from "./lib/utils";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import { apiFor } from "./hosts/hostApi";

export async function dispatchThreadGoal(
  threadId: ThreadId,
  goal: string,
  options: { readonly startBehavior?: ThreadGoalStartBehavior } = {},
  hostId: HostId = LOCAL_HOST_ID,
): Promise<void> {
  const api = apiFor(hostId);
  if (!api) {
    throw new Error("Saint API is unavailable.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    goal,
    ...(options.startBehavior !== undefined ? { goalStartBehavior: options.startBehavior } : {}),
  });
}

export async function dispatchThreadGoalPaused(
  threadId: ThreadId,
  paused: boolean,
  hostId: HostId = LOCAL_HOST_ID,
): Promise<void> {
  const api = apiFor(hostId);
  if (!api) {
    throw new Error("Saint API is unavailable.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    goalPaused: paused,
  });
}
