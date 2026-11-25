// FILE: terminalImeGuard.ts
// Purpose: Stabilizes IME composition (especially WebKitGTK + fcitx5/ibus Preedit mode) inside
//          xterm.js by committing finalized composition text synchronously before trailing keydown
//          events and suppressing xterm's delayed/stale echo and WebKitGTK duplicate input events.
// Layer: Terminal runtime utility
// Exports: createTerminalImeGuard, attachTerminalImeGuard

import { normalizeTerminalInputData } from "./terminalInputNormalization";

// WebKitGTK / Safari can fire a duplicate `input` (`insertText`) or leaked committing `keydown`
// synchronously right after `compositionend` (WebKit #165004). Keep the dedup windows tight so
// rapid subsequent human typing is never swallowed.
const POST_COMPOSITION_INPUT_DEDUP_MS = 40;
const POST_COMPOSITION_SPACE_DEDUP_MS = 25;

export interface TerminalImeGuardOptions {
  readonly onCommit: (data: string) => void;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void) => () => void;
}

export interface TerminalImeInputEventLike {
  readonly inputType?: string | null;
  readonly data?: string | null;
}

export interface TerminalImeKeyDownEventLike {
  readonly key: string;
  readonly keyCode?: number;
  readonly isComposing?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

export interface TerminalImeGuard {
  readonly isComposing: () => boolean;
  readonly handleCompositionStart: () => void;
  readonly handleCompositionEnd: (rawData: string) => void;
  readonly shouldSuppressInputEvent: (event: TerminalImeInputEventLike) => boolean;
  readonly shouldSuppressKeyDown: (event: TerminalImeKeyDownEventLike) => boolean;
  readonly filterOnData: (rawData: string) => string | null;
  readonly dispose: () => void;
}

function defaultSchedule(fn: () => void): () => void {
  const id = globalThis.setTimeout(fn, 0);
  return () => {
    globalThis.clearTimeout(id);
  };
}

export function createTerminalImeGuard(options: TerminalImeGuardOptions): TerminalImeGuard {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? defaultSchedule;

  let composing = false;
  let pendingXtermFlushText: string | null = null;
  let cancelPendingFlush: (() => void) | null = null;
  let lastCommittedText = "";
  let lastCompositionEndAt = -Infinity;
  let sawNormalKeyDownSinceEnd = false;

  const clearPendingFlush = () => {
    cancelPendingFlush?.();
    cancelPendingFlush = null;
    pendingXtermFlushText = null;
  };

  return {
    isComposing: () => composing,

    handleCompositionStart: () => {
      composing = true;
      clearPendingFlush();
    },

    handleCompositionEnd: (rawData: string) => {
      composing = false;
      lastCompositionEndAt = now();
      sawNormalKeyDownSinceEnd = false;
      clearPendingFlush();

      const normalized = normalizeTerminalInputData(rawData);
      if (normalized.length === 0) {
        lastCommittedText = "";
        return;
      }

      lastCommittedText = normalized;
      pendingXtermFlushText = normalized;
      // Registered in the bubble phase after xterm's `compositionend` handler, so this timer runs
      // strictly after xterm's own `setTimeout(..., 0)` flush and clears the suppression latch.
      cancelPendingFlush = schedule(() => {
        cancelPendingFlush = null;
        pendingXtermFlushText = null;
      });
      options.onCommit(normalized);
    },

    shouldSuppressInputEvent: (event: TerminalImeInputEventLike) => {
      const inputType = event.inputType ?? "";
      if (inputType !== "insertText" && inputType !== "insertFromComposition") {
        return false;
      }
      if (composing) {
        return true;
      }
      const rawData = event.data ?? "";
      if (
        rawData.length === 0 ||
        lastCommittedText.length === 0 ||
        sawNormalKeyDownSinceEnd ||
        now() - lastCompositionEndAt > POST_COMPOSITION_INPUT_DEDUP_MS
      ) {
        return false;
      }
      return normalizeTerminalInputData(rawData) === lastCommittedText;
    },

    shouldSuppressKeyDown: (event: TerminalImeKeyDownEventLike) => {
      if (event.isComposing || event.keyCode === 229) {
        return false;
      }
      sawNormalKeyDownSinceEnd = true;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === " " || event.key === "\u00a0") &&
        lastCommittedText.endsWith(" ") &&
        now() - lastCompositionEndAt <= POST_COMPOSITION_SPACE_DEDUP_MS
      ) {
        lastCommittedText = "";
        return true;
      }
      return false;
    },

    filterOnData: (rawData: string) => {
      const normalized = normalizeTerminalInputData(rawData);
      if (pendingXtermFlushText !== null) {
        // Suppress xterm's `_finalizeComposition(true)` full echo or `_finalizeComposition(false)`
        // truncated prefix (when `_compositionPosition.end` was still stale at keydown time).
        if (
          normalized.length === 0 ||
          normalized === pendingXtermFlushText ||
          pendingXtermFlushText.startsWith(normalized)
        ) {
          clearPendingFlush();
          return null;
        }
      }
      return normalized.length > 0 ? normalized : null;
    },

    dispose: () => {
      composing = false;
      clearPendingFlush();
      lastCommittedText = "";
    },
  };
}

export interface AttachedTerminalImeGuard {
  readonly isComposing: () => boolean;
  readonly filterOnData: (rawData: string) => string | null;
  readonly dispose: () => void;
}

/**
 * Attaches capture/bubble IME guards onto a terminal's wrapper element (parent of xterm's helper
 * `<textarea>`):
 * - Capture `input` and `keydown` run strictly before xterm's listeners on `<textarea>`.
 * - Bubble `compositionend` runs immediately after xterm hides its preedit overlay and queues its
 *   `setTimeout(..., 0)` flush, letting us commit `event.data` synchronously in the exact order.
 */
export function attachTerminalImeGuard(
  wrapper: HTMLElement,
  onCommit: (data: string) => void,
): AttachedTerminalImeGuard {
  const guard = createTerminalImeGuard({ onCommit });

  const onCompositionStart = () => {
    guard.handleCompositionStart();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    guard.handleCompositionEnd(event.data ?? "");
  };
  const onInputCapture = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (guard.shouldSuppressInputEvent(inputEvent)) {
      event.stopPropagation();
    }
  };
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (guard.shouldSuppressKeyDown(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  wrapper.addEventListener("compositionstart", onCompositionStart, true);
  wrapper.addEventListener("compositionend", onCompositionEnd, false);
  wrapper.addEventListener("input", onInputCapture, true);
  wrapper.addEventListener("keydown", onKeyDownCapture, true);

  return {
    isComposing: guard.isComposing,
    filterOnData: guard.filterOnData,
    dispose: () => {
      wrapper.removeEventListener("compositionstart", onCompositionStart, true);
      wrapper.removeEventListener("compositionend", onCompositionEnd, false);
      wrapper.removeEventListener("input", onInputCapture, true);
      wrapper.removeEventListener("keydown", onKeyDownCapture, true);
      guard.dispose();
    },
  };
}
