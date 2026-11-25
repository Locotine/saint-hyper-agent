// FILE: terminalImeGuard.test.ts
// Purpose: Covers WebKitGTK + fcitx5/ibus Preedit IME composition ordering and deduplication.
// Layer: Web terminal unit tests

import { describe, expect, it } from "vitest";

import { createTerminalImeGuard } from "./terminalImeGuard";

function makeGuard() {
  let clock = 1_000;
  const committed: string[] = [];
  const pendingTimers: Array<{ fn: () => void; cancelled: boolean }> = [];
  const guard = createTerminalImeGuard({
    onCommit: (data) => committed.push(data),
    now: () => clock,
    schedule: (fn) => {
      const entry = { fn, cancelled: false };
      pendingTimers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  const flushTimers = () => {
    for (const entry of pendingTimers.splice(0)) {
      if (!entry.cancelled) entry.fn();
    }
  };
  return { guard, committed, advance, flushTimers };
}

describe("createTerminalImeGuard", () => {
  it("commits Preedit text synchronously before trailing Space/Enter and drops xterm stale flush", () => {
    const { guard, committed, flushTimers } = makeGuard();

    guard.handleCompositionStart();
    expect(guard.isComposing()).toBe(true);
    expect(guard.shouldSuppressInputEvent({ inputType: "insertText", data: "g" })).toBe(true);

    // fcitx5-lotus commits "git" right before WebKitGTK fires keydown(Space).
    guard.handleCompositionEnd("git");
    expect(guard.isComposing()).toBe(false);
    expect(committed).toEqual(["git"]);

    // Trailing Space keydown must pass through when the IME did not include a space.
    expect(guard.shouldSuppressKeyDown({ key: " ", keyCode: 32 })).toBe(false);
    // xterm's `_finalizeComposition(false)` fires with a stale truncated prefix ("gi"): suppressed.
    expect(guard.filterOnData("gi")).toBeNull();
    // xterm then emits the actual Space key: passes through in exact order ("git" then " ").
    expect(guard.filterOnData(" ")).toBe(" ");
    flushTimers();
  });

  it("suppresses xterm's delayed setTimeout flush and WebKitGTK duplicate insertText input", () => {
    const { guard, committed, advance, flushTimers } = makeGuard();

    guard.handleCompositionStart();
    guard.handleCompositionEnd("tiếng");
    expect(committed).toEqual(["tiếng"]);

    // WebKitGTK duplicate `input` (`insertText`) right after compositionend is suppressed.
    advance(5);
    expect(guard.shouldSuppressInputEvent({ inputType: "insertText", data: "tiếng" })).toBe(true);

    // xterm's delayed `_finalizeComposition(true)` flush is suppressed once.
    expect(guard.filterOnData("tiếng")).toBeNull();
    flushTimers();

    // Subsequent ordinary typing of the same text passes through cleanly.
    advance(50);
    expect(guard.shouldSuppressKeyDown({ key: "t", keyCode: 84 })).toBe(false);
    expect(guard.shouldSuppressInputEvent({ inputType: "insertText", data: "t" })).toBe(false);
    expect(guard.filterOnData("t")).toBe("t");
  });

  it("deduplicates a WebKitGTK-leaked Space keydown when the IME already committed a trailing space", () => {
    const { guard, committed, advance, flushTimers } = makeGuard();

    guard.handleCompositionStart();
    guard.handleCompositionEnd("git\u00a0");
    // NBSP is normalized to ASCII space on commit.
    expect(committed).toEqual(["git "]);

    // Leaked Space keydown within 25ms of trailing-space commit is suppressed.
    advance(5);
    expect(guard.shouldSuppressKeyDown({ key: " ", keyCode: 32 })).toBe(true);
    // xterm's delayed flush is still suppressed.
    expect(guard.filterOnData("git\u00a0")).toBeNull();
    flushTimers();

    // A later intentional Space from the user passes through.
    advance(40);
    expect(guard.shouldSuppressKeyDown({ key: " ", keyCode: 32 })).toBe(false);
    expect(guard.filterOnData(" ")).toBe(" ");
  });

  it("does not swallow an intentional Enter after committing the final word", () => {
    const { guard, committed, flushTimers } = makeGuard();

    guard.handleCompositionStart();
    guard.handleCompositionEnd("pull");
    expect(committed).toEqual(["pull"]);

    expect(guard.shouldSuppressKeyDown({ key: "Enter", keyCode: 13 })).toBe(false);
    expect(guard.filterOnData("pull")).toBeNull();
    expect(guard.filterOnData("\r")).toBe("\r");
    flushTimers();
  });

  it("does not emit anything on cancelled empty compositionend", () => {
    const { guard, committed } = makeGuard();

    guard.handleCompositionStart();
    guard.handleCompositionEnd("");
    expect(committed).toEqual([]);
    expect(guard.isComposing()).toBe(false);
  });
});
