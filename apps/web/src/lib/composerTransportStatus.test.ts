import { sshHostId } from "@saint/shared/hostId";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitWsTransportState } from "../wsTransportEvents";
import { subscribeComposerTransportStatus } from "./composerTransportStatus";

const REMOTE_HOST_ID = sshHostId("a1b2c3d4");

describe("composer transport status", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    emitWsTransportState("open");
    emitWsTransportState("open", REMOTE_HOST_ID);
  });

  afterEach(() => {
    unsubscribe?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["connecting", "closed"] as const)("delays %s by 1.5 seconds", (state) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState(state);
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("Reconnecting to Saint…");
    emitWsTransportState("open");
    expect(message).toBeNull();
  });

  it("does not restart the delay as reconnect attempts cycle between closed and connecting", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1000);
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(500);
    expect(message).toBe("Reconnecting to Saint…");
  });

  it("cancels brief blips and starts a fresh delay for the next outage", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1400);
    emitWsTransportState("open");
    vi.advanceTimersByTime(200);
    expect(message).toBeNull();
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("Reconnecting to Saint…");
  });

  it.each([
    ["incompatible", "Saint connection is incompatible."],
    ["disposed", "Disconnected from Saint."],
  ] as const)("does not promise reconnection for %s", (state, expected) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1500);
    emitWsTransportState(state);
    expect(message).toBe(expected);
  });

  it("replays an existing outage and cancels the timer and listener on unmount", () => {
    emitWsTransportState("closed");
    const messages: (string | null)[] = [];
    unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
    vi.advanceTimersByTime(1500);
    expect(messages).toEqual(["Reconnecting to Saint…"]);
    emitWsTransportState("open");
    emitWsTransportState("closed");
    unsubscribe();
    vi.advanceTimersByTime(2000);
    emitWsTransportState("open");
    expect(messages).toEqual(["Reconnecting to Saint…", null]);
  });

  it("isolates a remote host subscription from local outages and tracks the remote transport", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value), REMOTE_HOST_ID);

    // Local transport closing must not warn on a healthy remote host chat.
    emitWsTransportState("closed");
    vi.advanceTimersByTime(2000);
    expect(message).toBeNull();

    // Outages on the remote host itself still surface after the delay and clear on recovery.
    emitWsTransportState("closed", REMOTE_HOST_ID);
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("Reconnecting to Saint…");

    emitWsTransportState("open", REMOTE_HOST_ID);
    expect(message).toBeNull();
  });
});
