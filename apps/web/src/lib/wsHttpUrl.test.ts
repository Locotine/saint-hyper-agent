import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";

import { hostConnections } from "../hosts/hostConnectionRegistry";
import {
  buildTimeWsUrl,
  hostAttachmentPreviewUrl,
  isHostAttachmentPath,
  resolveHostHttpUrl,
  resolveHostHttpUrlOrNull,
  resolveWsHttpUrl,
} from "./wsHttpUrl";

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

  it("preserves LAN relay reverse-proxy path prefixes for paired mobile browsers", () => {
    vi.stubGlobal("window", { location: { origin: "http://192.168.1.5:3883" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue({
      explicitUrl: "ws://192.168.1.5:3883/api/remote-ssh/proxy/a1b2c3d4/",
    } as never);

    expect(resolveHostHttpUrl(sshHostId("a1b2c3d4"), "/attachments/pic.png")).toBe(
      "http://192.168.1.5:3883/api/remote-ssh/proxy/a1b2c3d4/attachments/pic.png",
    );
    expect(resolveHostHttpUrl(sshHostId("a1b2c3d4"), "/api/workspace/download?cwd=%2Frepo")).toBe(
      "http://192.168.1.5:3883/api/remote-ssh/proxy/a1b2c3d4/api/workspace/download?cwd=%2Frepo",
    );
  });

  it("refuses a remote host without a live connection instead of using the local server", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue(undefined);

    expect(() => resolveHostHttpUrl(sshHostId("a1b2c3d4"), "/api/x")).toThrow(/not connected/);
    expect(resolveHostHttpUrlOrNull(sshHostId("a1b2c3d4"), "/api/x")).toBeNull();
  });

  it("resolves non-throwing host URLs when a remote connection is active", () => {
    vi.stubGlobal("window", { location: { origin: "http://fallback.test" } });
    vi.spyOn(hostConnections, "peek").mockReturnValue({
      explicitUrl: "ws://127.0.0.1:5222/ws?token=remote",
    } as never);

    expect(resolveHostHttpUrlOrNull(sshHostId("a1b2c3d4"), "/api/local-image?src=a.png")).toBe(
      "http://127.0.0.1:5222/api/local-image?src=a.png&token=remote",
    );
    expect(isHostAttachmentPath("http://127.0.0.1:4111/attachments/att_1?token=local")).toBe(true);
    expect(isHostAttachmentPath("blob:http://127.0.0.1:4111/123")).toBe(false);
    expect(isHostAttachmentPath("https://example.test/photo.png")).toBe(false);
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

describe("buildTimeWsUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("drops a loopback dev server URL on a page opened from another device", () => {
    vi.stubEnv("VITE_WS_URL", "ws://localhost:3773");
    vi.stubGlobal("window", { location: { hostname: "192.168.1.20" } });
    expect(buildTimeWsUrl()).toBeNull();

    vi.stubGlobal("window", { location: { hostname: "localhost" } });
    expect(buildTimeWsUrl()).toBe("ws://localhost:3773");
  });
});
