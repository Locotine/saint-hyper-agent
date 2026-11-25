import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_AUTO_RECONNECT_ENTRY,
  reconnectRemoteHost,
  stepAutoReconnect,
} from "./hostReconnect";

const live = { phase: "connected", streamStatus: "live" } as const;

describe("stepAutoReconnect", () => {
  it("retries a stale stream only after the grace period, then backs off", () => {
    let { entry } = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    const stale = { phase: "connected", streamStatus: "stale" } as const;
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
    expect(
      stepAutoReconnect(entry, { now: 5, phase: "error", streamStatus: "live" }).reconnect,
    ).toBe(true);
  });

  it("leaves a host that never connected, a user's disconnect and the desktop's own retries alone", () => {
    for (const phase of ["error", "idle", "reconnecting", "checking"] as const) {
      expect(
        stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, {
          now: 100,
          phase,
          streamStatus: "stale",
        }).reconnect,
      ).toBe(false);
    }
    const { entry } = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    expect(
      stepAutoReconnect(entry, { now: 5, phase: "idle", streamStatus: "stale" }).reconnect,
    ).toBe(false);
  });

  it("starts over once the host is live again", () => {
    let step = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    step = stepAutoReconnect(step.entry, { now: 1, phase: "error", streamStatus: "live" });
    expect(step.entry.attempts).toBe(1);
    step = stepAutoReconnect(step.entry, { now: 2, ...live });
    expect(step.entry.attempts).toBe(0);
  });

  it("clears everConnected on idle and stopping so subsequent errors do not auto-reconnect", () => {
    for (const resetPhase of ["idle", "stopping"] as const) {
      let step = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
      expect(step.entry.everConnected).toBe(true);
      step = stepAutoReconnect(step.entry, { now: 5, phase: resetPhase, streamStatus: "live" });
      expect(step.reconnect).toBe(false);
      expect(step.entry).toEqual(INITIAL_AUTO_RECONNECT_ENTRY);
      step = stepAutoReconnect(step.entry, { now: 10, phase: "error", streamStatus: "live" });
      expect(step.reconnect).toBe(false);
    }
  });

  it("suppresses auto-reconnect when a fast stop_server failure reports autoReconnectSuppressed", () => {
    const connected = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, { now: 0, ...live });
    const failedStop = stepAutoReconnect(connected.entry, {
      now: 5,
      phase: "error",
      streamStatus: "live",
      autoReconnectSuppressed: true,
    });
    expect(failedStop.reconnect).toBe(false);
    expect(failedStop.entry).toEqual(INITIAL_AUTO_RECONNECT_ENTRY);
  });

  it("does not reset retry backoff while the stream is still connecting, and recovers if stuck", () => {
    let step = stepAutoReconnect(INITIAL_AUTO_RECONNECT_ENTRY, {
      now: 0,
      phase: "connected",
      streamStatus: "live",
    });
    // First stale retry fires after 20s grace -> attempts becomes 1, nextAt = 21_000 + 5_000.
    step = stepAutoReconnect(step.entry, {
      now: 1_000,
      phase: "connected",
      streamStatus: "stale",
    });
    step = stepAutoReconnect(step.entry, {
      now: 21_000,
      phase: "connected",
      streamStatus: "stale",
    });
    expect(step.reconnect).toBe(true);
    expect(step.entry.attempts).toBe(1);

    // Desktop enters reconnecting, then reports connected while WS is still `connecting`.
    step = stepAutoReconnect(step.entry, {
      now: 22_000,
      phase: "reconnecting",
      streamStatus: "connecting",
    });
    step = stepAutoReconnect(step.entry, {
      now: 23_000,
      phase: "connected",
      streamStatus: "connecting",
    });
    expect(step.reconnect).toBe(false);
    // Attempts must NOT reset until streamStatus reaches `live`.
    expect(step.entry.attempts).toBe(1);

    // Still connecting within 30s grace -> do not reconnect yet.
    step = stepAutoReconnect(step.entry, {
      now: 52_999,
      phase: "connected",
      streamStatus: "connecting",
    });
    expect(step.reconnect).toBe(false);

    // Stuck in `connecting` past 30s grace -> retry with next backoff slot (attempts 1 -> 2).
    step = stepAutoReconnect(step.entry, {
      now: 53_000,
      phase: "connected",
      streamStatus: "connecting",
    });
    expect(step.reconnect).toBe(true);
    expect(step.entry.attempts).toBe(2);
    expect(step.entry.nextAt).toBe(53_000 + 15_000);

    // Once stream actually becomes `live`, attempts reset to 0.
    step = stepAutoReconnect(step.entry, {
      now: 55_000,
      phase: "connected",
      streamStatus: "live",
    });
    expect(step.reconnect).toBe(false);
    expect(step.entry.attempts).toBe(0);
  });
});

describe("reconnectRemoteHost", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("uses non-destructive bridge.reconnect without calling disconnect when available", async () => {
    const reconnect = vi.fn(async () => ({}) as never);
    const disconnect = vi.fn(async () => undefined);
    const connect = vi.fn(async () => ({}) as never);
    (globalThis as { window?: unknown }).window = {
      desktopBridge: {
        remoteSsh: { reconnect, disconnect, connect },
      },
    };

    await reconnectRemoteHost({
      host: "devbox",
      hostKey: "hk-1",
      remoteRoot: ".saint-remote",
      hostState: {
        host: "devbox",
        hostKey: "hk-1",
        epoch: 1,
        remoteRoot: ".saint-remote",
        phase: "connected",
        message: null,
        localPort: 45_000,
      },
    });

    expect(reconnect).toHaveBeenCalledWith({
      host: "devbox",
      hostKey: "hk-1",
      remoteRoot: ".saint-remote",
    });
    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
