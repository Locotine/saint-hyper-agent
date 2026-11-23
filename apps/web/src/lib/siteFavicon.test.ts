// FILE: siteFavicon.test.ts
// Purpose: Verifies hostname extraction and that the favicon proxy URL is keyed by
//          host, so every link on a site dedupes onto one cacheable request.
// Layer: Web utility tests

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractHostname,
  isWaitingForDesktopWsUrl,
  resolveSiteFaviconUrl,
  subscribeDesktopWsUrl,
} from "./siteFavicon";

describe("extractHostname", () => {
  it("returns null for a bare domain without a scheme", () => {
    expect(extractHostname("example.com")).toBeNull();
  });
});

describe("resolveSiteFaviconUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys the request by hostname so links on one site share a cache entry", () => {
    const first = resolveSiteFaviconUrl("https://x.com/a/long/path");
    const second = resolveSiteFaviconUrl("https://x.com/another/path?q=1");
    expect(first).toBe(second);
    expect(first).toContain("/api/site-favicon");
    expect(first).toContain("domain=x.com");
  });

  it("carries the WebSocket startup token for desktop image requests", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3000" },
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4567/ws?token=dev-secret" },
    });

    const url = resolveSiteFaviconUrl("https://openai.com/research");

    expect(url).toBe("http://127.0.0.1:4567/api/site-favicon?domain=openai.com&token=dev-secret");
  });

  it("supports fallback=none so UI components can render crisp local fallbacks", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3000" },
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4567/ws?token=dev-secret" },
    });

    const url = resolveSiteFaviconUrl("https://github.com/org/repo", { fallback: "none" });
    expect(url).toBe(
      "http://127.0.0.1:4567/api/site-favicon?domain=github.com&fallback=none&token=dev-secret",
    );
  });

  it("reports waiting state before desktop sidecar WS URL is ready and notifies on desktop:ws-url-changed", () => {
    const listeners = new Map<string, Set<() => void>>();
    let wsUrl: string | null = null;
    vi.stubGlobal("window", {
      location: { origin: "tauri://localhost" },
      desktopBridge: { getWsUrl: () => wsUrl },
      addEventListener: (name: string, fn: () => void) => {
        const set = listeners.get(name) ?? new Set();
        set.add(fn);
        listeners.set(name, set);
      },
      removeEventListener: (name: string, fn: () => void) => {
        listeners.get(name)?.delete(fn);
      },
    });

    expect(isWaitingForDesktopWsUrl()).toBe(true);
    const onChange = vi.fn();
    const unsubscribe = subscribeDesktopWsUrl(onChange);

    wsUrl = "ws://127.0.0.1:4567/ws";
    for (const fn of listeners.get("desktop:ws-url-changed") ?? []) {
      fn();
    }

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isWaitingForDesktopWsUrl()).toBe(false);
    unsubscribe();
  });
});
