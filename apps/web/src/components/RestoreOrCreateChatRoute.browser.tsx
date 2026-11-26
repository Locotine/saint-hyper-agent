import "../index.css";

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  refreshEmptyRouteRestoreSnapshot: vi.fn(async () => false),
  waitForEmptyRouteRestoreFallbackDelay: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../chatRouteRecovery", () => ({
  refreshEmptyRouteRestoreSnapshot: mocks.refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay: mocks.waitForEmptyRouteRestoreFallbackDelay,
}));

import { useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { RestoreOrCreateChatRoute } from "./RestoreOrCreateChatRoute";
import { persistSidebarUiState, readSidebarUiState } from "./Sidebar.uiState";

function saveLastThreadRoute(threadId: string) {
  persistSidebarUiState({
    ...readSidebarUiState(),
    lastThreadRoute: { threadId },
  });
}

describe("RestoreOrCreateChatRoute", () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.refreshEmptyRouteRestoreSnapshot.mockReset();
    mocks.refreshEmptyRouteRestoreSnapshot.mockResolvedValue(false);
    mocks.waitForEmptyRouteRestoreFallbackDelay.mockReset();
    mocks.waitForEmptyRouteRestoreFallbackDelay.mockResolvedValue(undefined);
    window.localStorage.clear();
    useStore.setState({ threadsHydrated: true, threadIds: [] });
    useSplitViewStore.setState({ hasHydrated: true, splitViewsById: {} });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("completes empty-startup recovery under StrictMode instead of hanging on the splash screen", async () => {
    saveLastThreadRoute("local-thread-1");
    const createFreshChat = vi.fn(async () => ({ ok: true as const, threadId: null }));

    const screen = await render(
      <StrictMode>
        <RestoreOrCreateChatRoute
          resolveRestoreRoute={() => null}
          createFreshChat={createFreshChat}
        />
      </StrictMode>,
    );
    try {
      await vi.waitFor(() => {
        expect(createFreshChat).toHaveBeenCalledTimes(1);
      });
      expect(mocks.refreshEmptyRouteRestoreSnapshot).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("skips local recovery when the remembered route belongs to a remote SSH host", async () => {
    saveLastThreadRoute("ssh:deadbeef~thread-remote-1");
    const createFreshChat = vi.fn(async () => ({ ok: true as const, threadId: null }));

    const screen = await render(
      <RestoreOrCreateChatRoute
        resolveRestoreRoute={() => null}
        createFreshChat={createFreshChat}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(createFreshChat).toHaveBeenCalledTimes(1);
      });
      expect(mocks.refreshEmptyRouteRestoreSnapshot).not.toHaveBeenCalled();
      expect(mocks.waitForEmptyRouteRestoreFallbackDelay).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("surfaces createFreshChat errors even if parent callbacks re-render while creation is in flight", async () => {
    let resolveCreate: ((value: { ok: false; error: string }) => void) | undefined;
    const createFreshChat = vi.fn(
      () =>
        new Promise<{ ok: false; error: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const screen = await render(
      <RestoreOrCreateChatRoute
        resolveRestoreRoute={() => null}
        createFreshChat={createFreshChat}
      />,
    );
    try {
      await vi.waitFor(() => {
        expect(createFreshChat).toHaveBeenCalledTimes(1);
      });

      // Re-render with fresh function identities (mirrors draft/store updates during stage()).
      await screen.rerender(
        <RestoreOrCreateChatRoute
          resolveRestoreRoute={() => null}
          createFreshChat={() => createFreshChat()}
        />,
      );

      resolveCreate?.({ ok: false, error: "Could not initialize local workspace" });
      await expect
        .element(page.getByText("Could not initialize local workspace"), { timeout: 4000 })
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: /retry/i })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
