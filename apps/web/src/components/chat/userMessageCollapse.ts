// The character and wrap thresholds are first-paint overflow hints; rendered message
// height is governed by the line limit.
export const COLLAPSED_USER_MESSAGE_MAX_CHARS = 600;
export const USER_MESSAGE_COLLAPSED_MAX_LINES = 12;
export const USER_MESSAGE_COLLAPSED_FADE_LINES = 2.5;
const ESTIMATED_CHARS_PER_WRAPPED_LINE = 68;

export function userMessageLikelyOverflows(text: string): boolean {
  if (text.length > COLLAPSED_USER_MESSAGE_MAX_CHARS) {
    return true;
  }

  let estimatedLines = 0;
  let start = 0;
  while (start <= text.length) {
    const newlineIndex = text.indexOf("\n", start);
    const lineLength = (newlineIndex === -1 ? text.length : newlineIndex) - start;
    estimatedLines += Math.max(1, Math.ceil(lineLength / ESTIMATED_CHARS_PER_WRAPPED_LINE));
    if (estimatedLines > USER_MESSAGE_COLLAPSED_MAX_LINES) {
      return true;
    }
    if (newlineIndex === -1) break;
    start = newlineIndex + 1;
  }
  return false;
}
