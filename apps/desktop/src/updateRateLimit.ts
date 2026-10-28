// FILE: updateRateLimit.ts
// Purpose: Recognizes an update feed's HTTP 429 in electron-updater's error text and
//          turns it into a retry time and a short message.
// Layer: Desktop update runtime
// Exports: parseUpdateRateLimit, describeUpdateRateLimit
//
// Release hosts limit anonymous API traffic per IP address, so every Saint behind one
// office NAT shares a budget. electron-updater wraps the HttpError into a plain
// message that also dumps every response header; the status and the retry hints
// are only recoverable from that text.

const RATE_LIMITED_RE = /\bHttpError: 429\b|\bstatus(?:Code)?[ :=]+429\b/u;
const RETRY_AFTER_RE = /["']?retry-after["']?\s*:\s*["']?(\d{1,6})["']?/iu;
const RATELIMIT_RESET_RE = /["']?ratelimit-reset["']?\s*:\s*["']?(\d{9,11})["']?/iu;

/** Used when a 429 carries no usable hint. */
export const UPDATE_RATE_LIMIT_DEFAULT_DELAY_MS = 15 * 60 * 1000;
const MIN_DELAY_MS = 60 * 1000;
const MAX_DELAY_MS = 2 * 60 * 60 * 1000;

export interface UpdateRateLimit {
  /** When the feed should be asked again, in epoch milliseconds. */
  readonly retryAtMs: number;
}

export function parseUpdateRateLimit(message: string, nowMs: number): UpdateRateLimit | null {
  if (!RATE_LIMITED_RE.test(message)) return null;
  let delayMs = UPDATE_RATE_LIMIT_DEFAULT_DELAY_MS;
  const retryAfterSeconds = RETRY_AFTER_RE.exec(message)?.[1];
  const resetEpochSeconds = RATELIMIT_RESET_RE.exec(message)?.[1];
  if (retryAfterSeconds !== undefined) {
    delayMs = Number(retryAfterSeconds) * 1000;
  } else if (resetEpochSeconds !== undefined) {
    delayMs = Number(resetEpochSeconds) * 1000 - nowMs;
  }
  return { retryAtMs: nowMs + Math.min(Math.max(delayMs, MIN_DELAY_MS), MAX_DELAY_MS) };
}

export function describeUpdateRateLimit(
  rateLimit: UpdateRateLimit,
  formatTime: (date: Date) => string = (date) =>
    date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
): string {
  return `The update server is limiting requests from this network. Saint will check again at ${formatTime(new Date(rateLimit.retryAtMs))}.`;
}
