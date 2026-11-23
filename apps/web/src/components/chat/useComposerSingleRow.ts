// FILE: useComposerSingleRow.ts
// Purpose: Decides whether a started thread's composer renders as one pill row
// (+ / editor / mic / send) or the full block.
// A newline, or a draft line wider than the row's editor slot, expands it to the block;
// it collapses back once the line fits that slot again. The slot width is recorded while
// the row shows, so the block never collapses into a row that would wrap at once.
// Layer: Chat composer layout
// Exports: useComposerSingleRow

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const SURFACE_SELECTOR = "[data-chat-composer-surface]";
/** Share of the surface assumed to be row chrome before the row has ever been measured. */
const UNMEASURED_ROW_CHROME_SHARE = 0.5;
/** A line must clear the slot by this much to stay in single-row mode. */
const SLOT_FIT_MARGIN_PX = 2;
/** Extra margin required to collapse back from block -> single-row so inline chips (which
 *  carry horizontal margins excluded from Range.getBoundingClientRect), word-wrap boundaries,
 *  and classic non-overlay scrollbars (Linux WebKitGTK) cannot oscillate row ↔ block forever. */
const COLLAPSE_HYSTERESIS_PX = 24;

export interface ComposerSingleRowDecisionInput {
  readonly prompt: string;
  readonly singleRow: boolean;
  readonly surfaceWidth: number;
  readonly slotWidth: number;
  readonly lineWidth: number;
  readonly lastOverflow: { readonly prompt: string; readonly surfaceWidth: number } | null;
}

export interface ComposerSingleRowDecision {
  readonly fits: boolean;
  readonly nextLastOverflow: { readonly prompt: string; readonly surfaceWidth: number } | null;
}

/**
 * Pure decision function for single-row ↔ block transitions with hysteresis and latching.
 * Expanding from row -> block latches `(prompt, surfaceWidth)` so a line that wrapped inside
 * the narrow row slot can never immediately bounce back to row mode once unwrapped in the
 * wider block slot.
 */
export function resolveComposerSingleRowDecision(
  input: ComposerSingleRowDecisionInput,
): ComposerSingleRowDecision {
  const { prompt, singleRow, surfaceWidth, slotWidth, lineWidth, lastOverflow } = input;
  if (prompt.includes("\n")) {
    return { fits: false, nextLastOverflow: null };
  }

  if (singleRow) {
    const fitsRow = lineWidth <= slotWidth - SLOT_FIT_MARGIN_PX;
    return {
      fits: fitsRow,
      nextLastOverflow: fitsRow ? null : { prompt, surfaceWidth },
    };
  }

  // Already in block mode: refuse to collapse back for the same (or longer) prompt at the
  // same (or narrower) surface width that just overflowed the single-row slot.
  if (
    lastOverflow !== null &&
    prompt.length >= lastOverflow.prompt.length &&
    surfaceWidth <= lastOverflow.surfaceWidth + 1
  ) {
    return { fits: false, nextLastOverflow: lastOverflow };
  }

  const fitsWithHysteresis = lineWidth <= slotWidth - COLLAPSE_HYSTERESIS_PX;
  return {
    fits: fitsWithHysteresis,
    nextLastOverflow: fitsWithHysteresis ? null : lastOverflow,
  };
}

/** Horizontal margins of inline descendant elements (e.g. link/mention chips with `mx-0.5`),
 *  which CSS line-breaking includes but `Range.getBoundingClientRect()` can undercount. */
function measureInlineHorizontalMargins(line: Element): number {
  let margins = 0;
  for (const child of line.querySelectorAll("*")) {
    const style = getComputedStyle(child);
    const left = Number.parseFloat(style.marginLeft);
    const right = Number.parseFloat(style.marginRight);
    if (Number.isFinite(left) && left > 0) margins += left;
    if (Number.isFinite(right) && right > 0) margins += right;
  }
  return margins;
}

/** Natural width of the draft's only line, or Infinity once it spans more than one. */
function measureDraftLineWidth(editor: HTMLElement): number {
  const [line, ...rest] = Array.from(editor.children);
  if (rest.length > 0) return Number.POSITIVE_INFINITY;
  if (!line) return 0;
  // Selecting the paragraph's contents (not the paragraph) measures the inline text and
  // chips, not the block box that always spans the editor's full width.
  const range = document.createRange();
  range.selectNodeContents(line);
  const rect = range.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  if (Number.isFinite(lineHeight) && rect.height > lineHeight * 1.5) {
    return Number.POSITIVE_INFINITY;
  }
  return rect.width + measureInlineHorizontalMargins(line);
}

/** Inner content width of the editor (excludes classic scrollbars and horizontal padding). */
function measureEditorContentWidth(editor: HTMLElement): number {
  const clientWidth = editor.clientWidth;
  const baseWidth = clientWidth > 0 ? clientWidth : editor.getBoundingClientRect().width;
  const style = getComputedStyle(editor);
  const padLeft = Number.parseFloat(style.paddingLeft);
  const padRight = Number.parseFloat(style.paddingRight);
  const padding =
    (Number.isFinite(padLeft) ? padLeft : 0) + (Number.isFinite(padRight) ? padRight : 0);
  return Math.max(0, baseWidth - padding);
}

export function useComposerSingleRow(input: {
  formRef: RefObject<HTMLFormElement | null>;
  eligible: boolean;
  prompt: string;
}): boolean {
  const { formRef, eligible, prompt } = input;
  const [fits, setFits] = useState(true);
  const singleRow = eligible && fits;
  // Surface width minus editor content width while the row shows: controls + gutters beside the slot.
  const rowChromeWidthRef = useRef<number | null>(null);
  const lastOverflowRef = useRef<{ readonly prompt: string; readonly surfaceWidth: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!eligible) {
      lastOverflowRef.current = null;
      return;
    }
    const editor = formRef.current?.querySelector<HTMLElement>(EDITOR_SELECTOR);
    const surface = editor?.closest<HTMLElement>(SURFACE_SELECTOR);
    if (!editor || !surface) return;
    const sync = () => {
      // Fractional widths: rounded clientWidth would leave a sub-pixel band where the row
      // wraps while the block measures the same line as fitting.
      const surfaceWidth = surface.getBoundingClientRect().width;
      const editorWidth = measureEditorContentWidth(editor);
      // Dictation and hidden panes have no measurable editor slot. Preserve the last
      // visible layout until ResizeObserver sees the editor again.
      if (surfaceWidth <= 0 || editorWidth <= 0) return;
      if (singleRow) {
        rowChromeWidthRef.current = surfaceWidth - editorWidth;
      }
      const rowChromeWidth =
        rowChromeWidthRef.current ?? surfaceWidth * UNMEASURED_ROW_CHROME_SHARE;
      const slotWidth = surfaceWidth - rowChromeWidth;
      const lineWidth = prompt.includes("\n")
        ? Number.POSITIVE_INFINITY
        : measureDraftLineWidth(editor);
      const decision = resolveComposerSingleRowDecision({
        prompt,
        singleRow,
        surfaceWidth,
        slotWidth,
        lineWidth,
        lastOverflow: lastOverflowRef.current,
      });
      lastOverflowRef.current = decision.nextLastOverflow;
      setFits((current) => (current === decision.fits ? current : decision.fits));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(editor);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [eligible, formRef, prompt, singleRow]);

  return singleRow;
}
