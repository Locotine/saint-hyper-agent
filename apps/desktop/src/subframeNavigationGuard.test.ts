import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { attachAppSubframeNavigationGuard } from "./subframeNavigationGuard";

function navigate(emitter: EventEmitter, url: string, isMainFrame: boolean): boolean {
  let prevented = false;
  emitter.emit("will-frame-navigate", {
    url,
    isMainFrame,
    preventDefault: () => {
      prevented = true;
    },
  });
  return prevented;
}

describe("attachAppSubframeNavigationGuard", () => {
  const emitter = new EventEmitter();
  attachAppSubframeNavigationGuard(emitter as unknown as Pick<WebContents, "on">);

  it.each([
    "https://attacker.example/collect?data=secret",
    "http://127.0.0.1:3773/api/auth/session",
    "data:text/html,<script>1</script>",
    "saint://app/settings",
    "javascript:alert(1)",
  ])("keeps an embedded document from navigating its frame to %s", (url) => {
    expect(navigate(emitter, url, false)).toBe(true);
  });

  it("lets a frame load its own inline document", () => {
    expect(navigate(emitter, "about:srcdoc", false)).toBe(false);
    expect(navigate(emitter, "about:blank", false)).toBe(false);
  });

  it("leaves the app window's own navigation to its existing handling", () => {
    expect(navigate(emitter, "https://example.com", true)).toBe(false);
  });
});

describe("attachAppSubframeNavigationGuard with the window's server", () => {
  const emitter = new EventEmitter();
  attachAppSubframeNavigationGuard(
    emitter as unknown as Pick<WebContents, "on">,
    () => "ws://127.0.0.1:3773/?token=secret",
  );

  it("lets an HTML preview load and follow links inside the server's preview route", () => {
    expect(navigate(emitter, "http://127.0.0.1:3773/api/html-preview/g/index.html", false)).toBe(
      false,
    );
    expect(navigate(emitter, "http://127.0.0.1:3773/api/html-preview/g/docs/a.html", false)).toBe(
      false,
    );
  });

  it.each([
    "http://127.0.0.1:3773/api/auth/session",
    "http://127.0.0.1:3773/api/html-preview/../auth/session",
    "http://127.0.0.1:3773/api/html-preview/%2e%2e/auth/session",
    "http://127.0.0.1:3773/api/html-previewx/g/index.html",
    "http://127.0.0.1:4000/api/html-preview/g/index.html",
    "https://attacker.example/api/html-preview/g/index.html",
  ])("keeps a preview from leaving the server's preview route for %s", (url) => {
    expect(navigate(emitter, url, false)).toBe(true);
  });
});
