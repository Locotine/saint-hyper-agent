// FILE: useComposerSingleRow.test.ts
// Purpose: Regression tests for single-row ↔ block composer transitions so link chips,
//          word wrapping, and scrollbar width cannot trigger an infinite layout oscillation loop.
// Layer: Chat composer layout unit tests

import { describe, expect, it } from "vitest";

import { resolveComposerSingleRowDecision } from "./useComposerSingleRow";

describe("resolveComposerSingleRowDecision", () => {
  it("expands to block mode and stays latched when a wrapped row unwraps near the slot edge", () => {
    const prompt = "https://github.com/elementalsouls/Claude-BugHunter kéo repo";
    // Step 1: In single-row mode, wrapping pushes lineWidth to Infinity -> expands to block mode.
    const expanded = resolveComposerSingleRowDecision({
      prompt,
      singleRow: true,
      surfaceWidth: 450,
      slotWidth: 280,
      lineWidth: Number.POSITIVE_INFINITY,
      lastOverflow: null,
    });
    expect(expanded.fits).toBe(false);
    expect(expanded.nextLastOverflow).toEqual({ prompt, surfaceWidth: 450 });

    // Step 2: In block mode, the wider editor unwraps the line to 276px (inside slotWidth - 2px,
    // which previously bounced singleRow back to true and caused an infinite render/freeze loop).
    const afterUnwrap = resolveComposerSingleRowDecision({
      prompt,
      singleRow: false,
      surfaceWidth: 450,
      slotWidth: 280,
      lineWidth: 276,
      lastOverflow: expanded.nextLastOverflow,
    });
    expect(afterUnwrap.fits).toBe(false);
    expect(afterUnwrap.nextLastOverflow).toEqual({ prompt, surfaceWidth: 450 });

    // Even typing more characters keeps it stably in block mode.
    const typedMore = resolveComposerSingleRowDecision({
      prompt: `${prompt} này`,
      singleRow: false,
      surfaceWidth: 450,
      slotWidth: 280,
      lineWidth: 240,
      lastOverflow: afterUnwrap.nextLastOverflow,
    });
    expect(typedMore.fits).toBe(false);
  });

  it("requires collapse hysteresis even after deleting characters, and collapses once clearly clear", () => {
    const longPrompt = "https://github.com/elementalsouls/Claude-BugHunter kéo repo";
    const latched = { prompt: longPrompt, surfaceWidth: 450 };

    // Deleting a few characters still within the 24px hysteresis band stays in block mode.
    const stillNearEdge = resolveComposerSingleRowDecision({
      prompt: "https://github.com/elementalsouls/Claude-BugHunter kéo",
      singleRow: false,
      surfaceWidth: 450,
      slotWidth: 280,
      lineWidth: 265,
      lastOverflow: latched,
    });
    expect(stillNearEdge.fits).toBe(false);

    // Deleting enough text to clear the 24px hysteresis collapses back cleanly.
    const clearlyFits = resolveComposerSingleRowDecision({
      prompt: "short",
      singleRow: false,
      surfaceWidth: 450,
      slotWidth: 280,
      lineWidth: 60,
      lastOverflow: latched,
    });
    expect(clearlyFits.fits).toBe(true);
    expect(clearlyFits.nextLastOverflow).toBeNull();
  });

  it("allows collapsing when the composer surface widens sufficiently", () => {
    const prompt = "https://github.com/elementalsouls/Claude-BugHunter kéo repo";
    const latched = { prompt, surfaceWidth: 450 };

    const widened = resolveComposerSingleRowDecision({
      prompt,
      singleRow: false,
      surfaceWidth: 640,
      slotWidth: 470,
      lineWidth: 276,
      lastOverflow: latched,
    });
    expect(widened.fits).toBe(true);
    expect(widened.nextLastOverflow).toBeNull();
  });

  it("always uses block mode for multi-line prompts", () => {
    const decision = resolveComposerSingleRowDecision({
      prompt: "https://github.com/elementalsouls/Claude-BugHunter\nkéo repo này",
      singleRow: true,
      surfaceWidth: 640,
      slotWidth: 470,
      lineWidth: 100,
      lastOverflow: null,
    });
    expect(decision.fits).toBe(false);
    expect(decision.nextLastOverflow).toBeNull();
  });
});
