import type { NativeApi, TerminalEvent } from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const hostListeners = new Set<() => void>();
  const apiByHost = new Map<HostId, NativeApi>();
  return {
    hostListeners,
    apiByHost,
    notifyHostConnections() {
      for (const listener of [...hostListeners]) {
        listener();
      }
    },
  };
});

vi.mock("~/hosts/hostApi", () => ({
  apiFor: (hostId: HostId) => state.apiByHost.get(hostId),
}));

vi.mock("~/hosts/hostConnectionRegistry", () => ({
  hostConnections: {
    subscribe: (listener: () => void) => {
      state.hostListeners.add(listener);
      return () => {
        state.hostListeners.delete(listener);
      };
    },
  },
}));

vi.mock("~/nativeApi", () => ({
  readLocalNativeApi: () => undefined,
}));

import { terminalEventDispatcher } from "./terminalEventDispatcher";

function createFakeTerminalApi() {
  const listeners = new Set<(event: TerminalEvent) => void>();
  const unsubscribe = vi.fn((listener: (event: TerminalEvent) => void) => {
    listeners.delete(listener);
  });
  const onEvent = vi.fn((listener: (event: TerminalEvent) => void) => {
    listeners.add(listener);
    return () => unsubscribe(listener);
  });
  return {
    api: { terminal: { onEvent } } as unknown as NativeApi,
    onEvent,
    unsubscribe,
    emit(event: TerminalEvent) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

afterEach(() => {
  state.apiByHost.clear();
  state.hostListeners.clear();
});

describe("terminalEventDispatcher remote host lifecycle", () => {
  it("attaches when a remote host connects and re-subscribes across reconnect epochs", () => {
    const remoteHostId = sshHostId("deadbeef");
    const received: string[] = [];

    const unsubscribe = terminalEventDispatcher.subscribe(
      remoteHostId,
      "thread-1",
      "terminal-1",
      (event) => {
        if (event.type === "output") received.push(event.data);
      },
    );

    // Remote host connects after the terminal mounted.
    const firstConnection = createFakeTerminalApi();
    state.apiByHost.set(remoteHostId, firstConnection.api);
    state.notifyHostConnections();

    firstConnection.emit({
      type: "output",
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      data: "epoch-1\n",
    });
    expect(received).toEqual(["epoch-1\n"]);
    expect(firstConnection.onEvent).toHaveBeenCalledTimes(1);

    // Remote host reconnects with a fresh epoch / NativeApi instance.
    const secondConnection = createFakeTerminalApi();
    state.apiByHost.set(remoteHostId, secondConnection.api);
    state.notifyHostConnections();

    expect(firstConnection.unsubscribe).toHaveBeenCalledTimes(1);
    expect(secondConnection.onEvent).toHaveBeenCalledTimes(1);

    secondConnection.emit({
      type: "output",
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-01-01T00:00:01.000Z",
      data: "epoch-2\n",
    });
    expect(received).toEqual(["epoch-1\n", "epoch-2\n"]);

    unsubscribe();
    expect(secondConnection.unsubscribe).toHaveBeenCalledTimes(1);
    expect(state.hostListeners.size).toBe(0);
  });
});
