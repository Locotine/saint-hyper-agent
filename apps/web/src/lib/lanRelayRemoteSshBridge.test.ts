import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isLanRelayRemoteSshAvailable,
  lanRelayRemoteSshBridge,
  probeLanRelayRemoteSshAvailability,
  resetLanRelayRemoteSshBridgeForTests,
} from "./lanRelayRemoteSshBridge";

describe("lanRelayRemoteSshBridge", () => {
  afterEach(() => {
    resetLanRelayRemoteSshBridgeForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("activates synchronously when the paired saint_lan_relay cookie is present", async () => {
    vi.stubGlobal("window", { location: { origin: "http://192.168.1.5:3883" } });
    vi.stubGlobal("document", { cookie: "other=1; saint_lan_relay=1" });

    expect(isLanRelayRemoteSshAvailable()).toBe(true);
    const bridge = lanRelayRemoteSshBridge();
    expect(bridge).toBeDefined();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ proxyPath: "/api/remote-ssh/proxy/hk-1/" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Saint-Lan-Relay": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: "http://192.168.1.5:41234/" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Saint-Lan-Relay": "1" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(bridge?.wsUrl("devbox")).resolves.toBe(
      "ws://192.168.1.5:3883/api/remote-ssh/proxy/hk-1/",
    );
    await expect(bridge?.forwardPort?.({ host: "devbox", remotePort: 5173 })).resolves.toBe(
      "http://192.168.1.5:41234/",
    );
  });

  it("ignores SPA HTML 200 fallbacks without the X-Saint-Lan-Relay header when probing", async () => {
    vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:5733" } });
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );

    await expect(probeLanRelayRemoteSshAvailability()).resolves.toBe(false);
    expect(isLanRelayRemoteSshAvailable()).toBe(false);
    expect(lanRelayRemoteSshBridge()).toBeUndefined();
  });

  it("enables the bridge asynchronously when probing sees X-Saint-Lan-Relay: 1", async () => {
    vi.stubGlobal("window", { location: { origin: "https://relay.tail.ts.net" } });
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            configHosts: [],
            savedHosts: [],
            hosts: [],
            defaultRemoteRoot: ".saint-remote",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", "X-Saint-Lan-Relay": "1" },
          },
        ),
      ),
    );

    await expect(probeLanRelayRemoteSshAvailability()).resolves.toBe(true);
    expect(isLanRelayRemoteSshAvailable()).toBe(true);
    expect(lanRelayRemoteSshBridge()).toBeDefined();
  });

  it("reconnects with backoff and resyncs state when EventSource enters CLOSED after an error", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", { location: { origin: "http://192.168.1.5:3883" } });
      vi.stubGlobal("document", { cookie: "saint_lan_relay=1" });

      const instances: Array<{
        readyState: number;
        onopen: (() => void) | null;
        onmessage: ((event: { data: string }) => void) | null;
        onerror: (() => void) | null;
        close: ReturnType<typeof vi.fn>;
      }> = [];
      class FakeEventSource {
        static readonly CLOSED = 2;
        readyState = 1;
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        close = vi.fn(() => {
          this.readyState = FakeEventSource.CLOSED;
        });
        constructor(_url: string, _init?: unknown) {
          instances.push(this);
        }
      }
      vi.stubGlobal("EventSource", FakeEventSource);

      const resyncedState = {
        configHosts: [],
        savedHosts: [],
        hosts: [],
        defaultRemoteRoot: ".saint-remote",
      };
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(resyncedState), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Saint-Lan-Relay": "1" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const bridge = lanRelayRemoteSshBridge();
      const listener = vi.fn();
      const unsubscribe = bridge?.onState(listener);
      expect(instances).toHaveLength(1);

      const first = instances[0]!;
      first.readyState = FakeEventSource.CLOSED;
      first.onerror?.();
      expect(first.close).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(instances).toHaveLength(2);
      vi.useRealTimers();

      instances[1]!.onopen?.();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/remote-ssh/state",
          expect.objectContaining({ method: "GET" }),
        );
        expect(listener).toHaveBeenCalledWith(resyncedState);
      });
      unsubscribe?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
