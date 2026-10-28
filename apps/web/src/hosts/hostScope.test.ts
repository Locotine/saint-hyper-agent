import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeWindow } from "../storeTestFixtures";

const hostA = sshHostId("a1b2c3d4");

async function load() {
  vi.resetModules();
  const scope = await import("./hostScope");
  const { useStore, useHostStore } = await import("../store");
  const { hostStores } = await import("./hostStores");
  return { ...scope, useStore, useHostStore, hostStores };
}

describe("HostScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("points useStore and useHostStore at the scoped host, and nothing else", async () => {
    const { HostScope, useHostId, useStore, useHostStore, hostStores } = await load();
    const seen: Array<{ hostId: string; stateHostId: unknown; store: unknown }> = [];
    function Probe() {
      seen.push({
        hostId: useHostId(),
        stateHostId: useStore((state) => state.hostId),
        store: useHostStore(),
      });
      return null;
    }
    renderToString(createElement(Probe));
    renderToString(createElement(HostScope, { hostId: hostA }, createElement(Probe)));

    // This computer's state leaves `hostId` unset.
    expect(seen[0]).toMatchObject({ hostId: LOCAL_HOST_ID, stateHostId: undefined });
    expect((seen[0]?.store as typeof useStore).getState).toBe(useStore.getState);
    expect(seen[1]).toEqual({ hostId: hostA, stateHostId: hostA, store: hostStores.get(hostA) });
    // The imperative API stays this computer's store.
    expect(useStore.getState().hostId).toBeUndefined();
  });

  it("has no API for a host without a live connection", async () => {
    const { apiFor } = await load();
    expect(apiFor(hostA)).toBeUndefined();
  });

  it("builds one API per host transport and leaves this computer's streams closed", async () => {
    vi.stubGlobal("window", makeFakeWindow());
    const { apiFor } = await load();
    const { hostConnections } = await import("./hostConnectionRegistry");
    const transport = {
      subscribe: vi.fn(() => () => undefined),
      request: vi.fn(),
      onShellStreamFailure: vi.fn(),
      onThreadStreamFailure: vi.fn(),
    };
    vi.spyOn(hostConnections, "peek").mockReturnValue(transport as never);

    const api = apiFor(hostA);
    expect(apiFor(hostA)).toBe(api);
    void api?.orchestration.subscribeThread({ threadId: "t1" } as never);
    expect(transport.request).toHaveBeenCalledWith("orchestration.subscribeThread", {
      threadId: "t1",
    });
    const channels = transport.subscribe.mock.calls.map((call) => (call as unknown[])[0]);
    expect(channels).toContain("orchestration.threadEvent");
    expect(channels).not.toContain("automation.event");
  });
});
