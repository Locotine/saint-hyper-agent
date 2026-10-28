// FILE: pendingRemoteThread.ts
// Purpose: Carries the thread chosen in the Remote hosts sidebar across the window reload that switches backend.
// Layer: Sidebar support (localStorage; survives the reload, ignored once stale)
// Exports: rememberPendingRemoteThread, takePendingRemoteThread, PENDING_REMOTE_THREAD_MAX_AGE_MS

const STORAGE_KEY = "saint:pending-remote-thread";

/** A reload that takes longer than this is not the one the user asked for. */
export const PENDING_REMOTE_THREAD_MAX_AGE_MS = 60_000;

export function rememberPendingRemoteThread(
  host: string,
  threadId: string,
  now = Date.now(),
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ host, threadId, at: now }));
  } catch {
    // Storage blocked: the host still opens, just on its start page.
  }
}

/** Returns the thread once for the host this window now talks to, then forgets it. */
export function takePendingRemoteThread(host: string | null, now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    localStorage.removeItem(STORAGE_KEY);
    const value = JSON.parse(raw) as { host?: unknown; threadId?: unknown; at?: unknown } | null;
    if (
      host !== null &&
      value?.host === host &&
      typeof value.threadId === "string" &&
      typeof value.at === "number" &&
      now - value.at <= PENDING_REMOTE_THREAD_MAX_AGE_MS
    ) {
      return value.threadId;
    }
  } catch {
    // Unreadable or blocked storage means nothing to open.
  }
  return null;
}
