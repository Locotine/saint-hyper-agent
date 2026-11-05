import { describe, expect, it } from "vitest";

import { INITIAL_AUTO_RECONNECT_ENTRY, stepAutoReconnect } from "./hostReconnect";

const live = { phase: "connected", streamStale: false } as const;

describe("stepAutoReconnect", () => {
  it("retries a stale stream only after the grace period, then backs off", () => {
    let { entry } = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    const stale = { phase: "connected", streamStale: true } as const;
    let step = stepAutoReconnect(entry, { now: 1_000, ...stale });
    expect(step.reconnect).toBe(false);
    step = stepAutoReconnect(step.entry, { now: 20_999, ...stale });
    expect(step.reconnect).toBe(false);
    step = stepAutoReconnect(step.entry, { now: 21_000, ...stale });
    expect(step.reconnect).toBe(true);
    step = stepAutoReconnect(step.entry, { now: 25_000, ...stale });
    expect(step.reconnect).toBe(false);
    step = stepAutoReconnect(step.entry, { now: 26_000, ...stale });
    expect(step.reconnect).toBe(true);
  });

  it("retries at once when the desktop gave up on a host that had worked", () => {
    const { entry } = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    expect(stepAutoReconnect(entry, { now: 5, phase: "error", streamStale: false }).reconnect).toBe(
      true,
    );
  });

  it("leaves a host that never connected, a user's disconnect and the desktop's own retries alone", () => {
    for (const phase of ["error", "idle", "reconnecting", "checking"] as const) {
      expect(
        stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 100, phase, streamStale: true })
          .reconnect,
      ).toBe(false);
    }
    const { entry } = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    expect(stepAutoReconnect(entry, { now: 5, phase: "idle", streamStale: true }).reconnect).toBe(
      false,
    );
  });

  it("starts over once the host is live again", () => {
    let step = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    step = stepAutoReconnect(step.entry, { now: 1, phase: "error", streamStale: false });
    expect(step.entry.attempts).toBe(1);
    step = stepAutoReconnect(step.entry, { now: 2, ...live });
    expect(step.entry.attempts).toBe(0);
  });
});
