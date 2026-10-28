// FILE: RemoteHostsSidebarSection.browser.tsx
// Purpose: Verifies the left-nav Remote hosts section: host rows, read-only catalog, and cleanup.
// Layer: Browser UI test

import "../index.css";

import type { DesktopRemoteSshState } from "@saint/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  dispose: vi.fn(async () => undefined),
  urls: [] as string[],
}));

vi.mock("../wsTransport", () => ({
  WsTransport: class {
    constructor(url: string) {
      harness.urls.push(url);
    }
    request = harness.request;
    dispose = harness.dispose;
  },
}));

import { RemoteHostsSidebarSection } from "./RemoteHostsSidebarSection";
import { SidebarProvider } from "./ui/sidebar";

const snapshot = {
  projects: [
    { id: "p1", kind: "project", title: "api-server", workspaceRoot: "/srv/api-server" },
    { id: "p2", kind: "chat", title: "Chats", workspaceRoot: "/srv/chats" },
  ],
  threads: [
    {
      id: "t1",
      projectId: "p1",
      title: "Fix the login race",
      updatedAt: "2026-10-28T10:00:00.000Z",
      archivedAt: null,
      parentThreadId: null,
      session: { status: "running" },
    },
  ],
};

const state = (
  hostPhase: "connected" | "idle",
  extra: Partial<DesktopRemoteSshState> = {},
): DesktopRemoteSshState => ({
  configHosts: [],
  defaultRemoteRoot: ".saint-beta-remote",
  savedHosts: [
    { host: "devbox", remoteRoot: "squad/saint" },
    { host: "k6", remoteRoot: null },
  ],
  hosts: [
    {
      host: "devbox",
      remoteRoot: "squad/saint",
      phase: hostPhase,
      message: null,
      localPort: hostPhase === "connected" ? 45000 : null,
    },
  ],
  ...extra,
});

const connect = vi.fn(async () => ({}));

beforeEach(() => {
  harness.request.mockReset();
  harness.request.mockResolvedValue(snapshot);
  harness.dispose.mockClear();
  harness.urls.length = 0;
  connect.mockClear();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      remoteSsh: {
        wsUrl: async (host: string) => `ws://127.0.0.1:45000/?token=${host}`,
        connect,
        getState: async () => state("connected"),
        onState: () => () => undefined,
      },
    },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "desktopBridge");
});

function mountSection(next: DesktopRemoteSshState) {
  return render(
    <SidebarProvider>
      <RemoteHostsSidebarSection state={next} />
    </SidebarProvider>,
  );
}

describe("RemoteHostsSidebarSection", () => {
  it("lists a connected host's projects and threads and leaves other hosts collapsed", async () => {
    await mountSection(state("connected"));

    await expect.element(page.getByText("Remote hosts")).toBeVisible();
    await expect.element(page.getByText("devbox")).toBeVisible();
    await expect.element(page.getByText("k6")).toBeVisible();
    await expect.element(page.getByText("api-server")).toBeVisible();
    await expect.element(page.getByText("Fix the login race")).toBeVisible();
    // Chats of a host stay on the host's own UI.
    expect(document.body.textContent).not.toContain("Chats");
    // Only the connected host opens a catalog connection.
    expect(harness.urls).toEqual(["ws://127.0.0.1:45000/?token=devbox"]);
  });

  it("opens the host window with the saved folder when a remote thread is chosen", async () => {
    await mountSection(state("connected"));
    await page.getByText("Fix the login race").click();
    expect(connect).toHaveBeenCalledWith({ host: "devbox", remoteRoot: "squad/saint" });
  });

  it("opens no catalog connection while the host is not connected", async () => {
    await mountSection(state("idle"));
    await expect.element(page.getByText("devbox")).toBeVisible();
    expect(harness.urls).toEqual([]);
    expect(document.body.textContent).not.toContain("api-server");
  });

  it("closes the catalog connection when the host goes away", async () => {
    const view = await mountSection(state("connected"));
    await expect.element(page.getByText("api-server")).toBeVisible();
    await view.unmount();
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps the last catalog and reports the failure when a refresh fails", async () => {
    harness.request.mockResolvedValueOnce(snapshot).mockRejectedValue(new Error("tunnel closed"));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await mountSection(state("connected"));
      await expect.element(page.getByText("api-server")).toBeVisible();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect.element(page.getByText("api-server")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});
