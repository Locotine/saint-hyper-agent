import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";

import { hostConnections } from "../hosts/hostConnectionRegistry";
import { hostAttachmentPreviewUrl, resolveHostHttpUrl, resolveWsHttpUrl } from "./wsHttpUrl";

describe("resolveWsHttpUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the websocket token to relative server routes", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:4111/ws?token=legacy-secret",
      },
      location: { origin: "http://fallback.test" },
    });

    expect(resolveWsHttpUrl("/api/attachment")).toBe(
      "http://127.0.0.1:4111/api/attachment?token=legacy-secret",
    );
  });

  it("does not forward the websocket token to an absolute external URL", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "wss://saint.test/ws?token=legacy-secret",
      },
      location: { origin: "https://fallback.test" },
    });

    expect(resolveWsHttpUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });
});

describe("resolveHostHttpUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves this computer's host like resolveWsHttpUrl", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4111/ws?token=local" },
      location: { origin: "http://fallback.test" },
    });

    expect(resolveHostHttpUrl(LOCAL_HOST_ID, "/api/x")).toBe(resolveWsHttpUrl("/api/x"));
    expect(resolveHostHttpUrl(LOCAL_HOST_ID, "/api/x")).toBe(
      "http://127.0.0.1:4111/api/x?token=local",
    );
  });

  it("targets a remote host's server with that host's token", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4111/ws?token=local" },
      location: { origin: "http://fallback.test" },
    });
    const hostId = sshHostId("a1b2c3d4");
    vi.spyOn(hostConnections, "peek").mockReturnValue({
      explicitUrl: "ws://127.0.0.1:5222/ws?token=remote",
    } as never);

    expect(resolveHostHttpUrl(hostId, "/api/x?a=1")).toBe(
      "http://127.0.0.1:5222/api/x?a=1&token=remote",
    );
  });

  it("tells a shared remote server which desktop is asking", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue({
      explicitUrl: "ws://127.0.0.1:5222/?token=remote&client=alice-a1b2c3d4",
    } as never);

    expect(resolveHostHttpUrl(sshHostId("a1b2c3d4"), "/api/x")).toBe(
      "http://127.0.0.1:5222/api/x?token=remote&client=alice-a1b2c3d4",
    );
  });

  it("refuses a remote host without a live connection instead of using the local server", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue(undefined);

    expect(() => resolveHostHttpUrl(sshHostId("a1b2c3d4"), "/api/x")).toThrow(/not connected/);
  });
});

describe("hostAttachmentPreviewUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stored = "http://127.0.0.1:4111/attachments/att_1?token=local";

  it("leaves this computer's images alone", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    expect(hostAttachmentPreviewUrl(LOCAL_HOST_ID, stored)).toBe(stored);
  });

  it("loads a remote host's image from that host with its own token, not this computer's", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue({
      explicitUrl: "ws://127.0.0.1:5222/ws?token=remote",
    } as never);

    expect(hostAttachmentPreviewUrl(sshHostId("a1b2c3d4"), stored)).toBe(
      "http://127.0.0.1:5222/attachments/att_1?token=remote",
    );
  });

  it("keeps the stored URL for other sources or a host with no live connection", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    const hostId = sshHostId("a1b2c3d4");
    vi.spyOn(hostConnections, "peek").mockReturnValue(undefined);
    expect(hostAttachmentPreviewUrl(hostId, stored)).toBe(stored);
    expect(hostAttachmentPreviewUrl(hostId, "blob:http://x/1")).toBe("blob:http://x/1");
  });
});
