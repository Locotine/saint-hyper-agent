// FILE: useRemoteSshState.test.tsx
// Purpose: Verifies shared deduplicated remote SSH state subscriptions and selective host alias
//          reads so duplicate or unrelated phase ticks do not cause redundant re-renders.
// Layer: Hook unit tests

import type { DesktopRemoteSshState } from "@saint/contracts";
import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeState = vi.hoisted(() => {
  let listener: ((state: DesktopRemoteSshState) => void) | null = null;
  const getState = vi.fn<() => Promise<DesktopRemoteSshState>>();
  const onState = vi.fn((cb: (state: DesktopRemoteSshState) => void) => {
    listener = cb;
    return () => {
      if (listener === cb) listener = null;
    };
  });
  const bridge = {
    getState,
    onState,
  };
  return {
    bridge,
    getState,
    onState,
    emit(state: DesktopRemoteSshState) {
      listener?.(state);
    },
    reset() {
      listener = null;
      getState.mockReset();
      onState.mockClear();
    },
  };
});

vi.mock("../lib/devLoopbackHosts", () => ({
  remoteSshBridge: () => bridgeState.bridge,
}));

vi.mock("../lib/lanRelayRemoteSshBridge", () => ({
  isLanRelayRemoteSshAvailable: () => false,
  probeLanRelayRemoteSshAvailability: vi.fn(async () => false),
  subscribeLanRelayRemoteSshAvailability: () => () => undefined,
}));

import {
  readRemoteSshSnapshot,
  resetRemoteSshStateStoreForTests,
  subscribeRemoteSshStore,
  useRemoteHostAlias,
  useRemoteSshState,
} from "./useRemoteSshState";

function sampleState(
  phase: DesktopRemoteSshState["hosts"][number]["phase"],
): DesktopRemoteSshState {
  return {
    configHosts: ["devbox"],
    defaultRemoteRoot: ".saint-remote",
    savedHosts: [{ host: "devbox", hostKey: "a1b2c3d4", remoteRoot: null }],
    hosts: [
      {
        host: "devbox",
        hostKey: "a1b2c3d4",
        epoch: 1,
        remoteRoot: ".saint-remote",
        phase,
        message: null,
        localPort: phase === "connected" ? 45123 : null,
      },
    ],
  };
}

describe("useRemoteSshState / useRemoteHostAlias", () => {
  afterEach(() => {
    resetRemoteSshStateStoreForTests();
    bridgeState.reset();
  });

  it("shares one bridge subscription across multiple subscribers and deduplicates identical snapshots", async () => {
    bridgeState.getState.mockResolvedValue(sampleState("checking"));
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubA = subscribeRemoteSshStore(listenerA);
    const unsubB = subscribeRemoteSshStore(listenerB);
    expect(bridgeState.onState).toHaveBeenCalledTimes(1);
    expect(bridgeState.getState).toHaveBeenCalledTimes(1);

    await Promise.resolve();
    const firstSnapshot = readRemoteSshSnapshot();
    expect(firstSnapshot?.hosts[0]?.phase).toBe("checking");
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    // Identical structural payload must NOT trigger redundant notifications or replace object identity.
    bridgeState.emit(sampleState("checking"));
    expect(readRemoteSshSnapshot()).toBe(firstSnapshot);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    // Distinct phase updates once.
    bridgeState.emit(sampleState("connected"));
    expect(readRemoteSshSnapshot()?.hosts[0]?.phase).toBe("connected");
    expect(listenerA).toHaveBeenCalledTimes(2);
    expect(listenerB).toHaveBeenCalledTimes(2);

    unsubA();
    unsubB();
  });

  it("never subscribes to the SSH bridge for local chats in useRemoteHostAlias", () => {
    bridgeState.getState.mockResolvedValue(sampleState("connected"));
    function LocalProbe() {
      const alias = useRemoteHostAlias(LOCAL_HOST_ID);
      return <span>{alias ?? "local"}</span>;
    }

    const html = renderToStaticMarkup(<LocalProbe />);
    expect(html).toContain("local");
    expect(bridgeState.onState).not.toHaveBeenCalled();
    expect(bridgeState.getState).not.toHaveBeenCalled();
  });

  it("renders safely on server snapshot for both hooks before hydration", () => {
    bridgeState.getState.mockResolvedValue(sampleState("checking"));
    function Probe() {
      const full = useRemoteSshState(true);
      const alias = useRemoteHostAlias(sshHostId("a1b2c3d4"));
      return (
        <span>
          {full ? "loaded" : "pending"}:{alias ?? "unknown"}
        </span>
      );
    }

    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain("pending:unknown");
  });
});
