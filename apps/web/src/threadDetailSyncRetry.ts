// FILE: threadDetailSyncRetry.ts
// Purpose: Route all manual thread retries through the active subscription owner.
// Layer: Web subscription utility

import type { ThreadId } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

type ThreadDetailSyncRetry = (threadId: ThreadId) => Promise<void>;

const hostRetryByHostId = new Map<HostId, ThreadDetailSyncRetry>();
const threadRetryByHostAndThread = new Map<HostId, Map<ThreadId, ThreadDetailSyncRetry>>();

/** The owner supplies its lease checks, cursor fence and subscription queue. */
export function registerThreadDetailSyncRetry(
  retry: ThreadDetailSyncRetry,
  scope?: { readonly hostId?: HostId; readonly threadId?: ThreadId },
): () => void {
  const hostId = scope?.hostId ?? LOCAL_HOST_ID;
  const threadId = scope?.threadId;
  if (threadId !== undefined) {
    let byThread = threadRetryByHostAndThread.get(hostId);
    if (!byThread) {
      byThread = new Map();
      threadRetryByHostAndThread.set(hostId, byThread);
    }
    byThread.set(threadId, retry);
    return () => {
      const currentByThread = threadRetryByHostAndThread.get(hostId);
      if (currentByThread?.get(threadId) === retry) {
        currentByThread.delete(threadId);
        if (currentByThread.size === 0) {
          threadRetryByHostAndThread.delete(hostId);
        }
      }
    };
  }
  hostRetryByHostId.set(hostId, retry);
  return () => {
    if (hostRetryByHostId.get(hostId) === retry) {
      hostRetryByHostId.delete(hostId);
    }
  };
}

export function retryThreadDetailSync(
  threadId: ThreadId,
  hostId: HostId = LOCAL_HOST_ID,
): Promise<void> {
  const retry =
    threadRetryByHostAndThread.get(hostId)?.get(threadId) ?? hostRetryByHostId.get(hostId);
  return retry?.(threadId) ?? Promise.resolve();
}
