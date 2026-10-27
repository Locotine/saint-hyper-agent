// FILE: UpdatesSettingsPanel.browser.tsx
// Purpose: Lock the desktop-only Updates panel and the Beta channel card copy/entry points.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopBetaChannelState, DesktopUpdateState } from "@saint/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  openExternalLink: vi.fn(),
  persistAppStateNow: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: true }));

vi.mock("~/lib/linkChips", () => ({ openExternalLink: harness.openExternalLink }));

vi.mock("~/store", () => ({
  useStore: Object.assign((selector: (store: Record<string, unknown>) => unknown) => selector({}), {
    getState: () => ({}),
  }),
  persistAppStateNow: harness.persistAppStateNow,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { BetaChannelSettingsPanel, UpdatesSettingsPanel } from "./DesktopSettingsPanels";

const RELEASES_URL = "https://gitlab.com/locotine/saint-releases/-/releases";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function withQueryClient(children: ReactNode) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const IDLE_STATE: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.2.3-beta.4",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  flavor: "beta",
  releaseUrl: RELEASES_URL,
};

const BETA_STATE: DesktopBetaChannelState = {
  supported: true,
  flavor: "beta",
  installed: true,
  version: "1.2.3-beta.4",
  canInstall: false,
  running: true,
  lastImportAt: null,
  lastImportError: null,
  downloadUrl: RELEASES_URL,
  install: null,
  stableInstalled: false,
  canMoveBetaToTrash: false,
  stableDownloadUrl: RELEASES_URL,
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

function updaterBridge(initial: DesktopUpdateState) {
  const listenerRef: { current: ((state: DesktopUpdateState) => void) | null } = {
    current: null,
  };
  const unsubscribe = vi.fn();
  const bridge = {
    getUpdateState: vi.fn().mockResolvedValue(initial),
    checkForUpdates: vi.fn().mockResolvedValue({ ...initial, status: "up-to-date" }),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
    onUpdateState: vi.fn((listener: (state: DesktopUpdateState) => void) => {
      listenerRef.current = listener;
      return unsubscribe;
    }),
  };
  return { bridge, listenerRef, unsubscribe };
}

beforeEach(() => {
  harness.openExternalLink.mockReset();
  harness.persistAppStateNow.mockReset();
  harness.toastAdd.mockReset();
  queryClient.clear();
  setDesktopBridge(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  setDesktopBridge(undefined);
});

describe("UpdatesSettingsPanel", () => {
  it("shows the version, checks for updates, installs, and links to all releases", async () => {
    const { bridge, listenerRef, unsubscribe } = updaterBridge(IDLE_STATE);
    const downloaded: DesktopUpdateState = {
      ...IDLE_STATE,
      status: "downloaded",
      availableVersion: "1.2.3-beta.5",
      downloadedVersion: "1.2.3-beta.5",
    };
    bridge.installUpdate.mockResolvedValue({ accepted: true, completed: false, state: downloaded });
    setDesktopBridge(bridge);

    const mounted = await render(<UpdatesSettingsPanel active />);
    await expect.element(mounted.getByText("1.2.3-beta.4")).toBeVisible();
    await expect.element(mounted.getByText("Not checked yet.")).toBeVisible();

    await mounted.getByRole("button", { name: "Check for updates" }).click();
    await expect
      .element(mounted.getByText("You're up to date on 1.2.3-beta.4. Click to check again."))
      .toBeVisible();
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce();

    listenerRef.current?.(downloaded);
    await expect
      .element(mounted.getByText("Update 1.2.3-beta.5 is ready. Click to restart and install."))
      .toBeVisible();
    await mounted.getByRole("button", { name: "Restart to update" }).click();
    await vi.waitFor(() => {
      expect(harness.persistAppStateNow).toHaveBeenCalledOnce();
      expect(bridge.installUpdate).toHaveBeenCalledOnce();
    });
    await expect.element(mounted.getByRole("button", { name: "Restarting…" })).toBeDisabled();

    await mounted.getByRole("button", { name: "All releases" }).click();
    expect(harness.openExternalLink).toHaveBeenCalledWith(RELEASES_URL);

    await mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("works the same for the Stable (production) flavor", async () => {
    const { bridge } = updaterBridge({
      ...IDLE_STATE,
      flavor: "production",
      currentVersion: "1.3.0",
    });
    setDesktopBridge(bridge);

    const mounted = await render(<UpdatesSettingsPanel active />);
    await expect.element(mounted.getByText("1.3.0")).toBeVisible();
    await mounted.getByRole("button", { name: "Check for updates" }).click();
    await expect
      .element(mounted.getByText("You're up to date on 1.3.0. Click to check again."))
      .toBeVisible();
    await mounted.unmount();
  });

  it("disables the check when automatic updates are off", async () => {
    const { bridge } = updaterBridge({ ...IDLE_STATE, enabled: false, status: "disabled" });
    setDesktopBridge(bridge);

    const mounted = await render(<UpdatesSettingsPanel active />);
    await expect
      .element(mounted.getByText("Automatic updates are not available right now."))
      .toBeVisible();
    await expect.element(mounted.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await mounted.unmount();
  });

  it("renders nothing without the desktop updater bridge", async () => {
    const mounted = await render(<UpdatesSettingsPanel active />);
    expect(mounted.container.textContent).toBe("");
    await mounted.unmount();
  });
});

describe("BetaChannelSettingsPanel", () => {
  it("does not claim Beta shares diagnostics when diagnostics are off", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    const getState = vi.fn().mockResolvedValue(BETA_STATE);
    setDesktopBridge({ beta: { getState }, openExternal });

    const mounted = await render(withQueryClient(<BetaChannelSettingsPanel active />));
    await expect.element(mounted.getByText("You're on Saint Beta")).toBeVisible();
    expect(mounted.container.textContent).not.toContain("shares");
    expect(mounted.getByRole("button", { name: "What Beta shares" }).query()).toBeNull();

    await mounted.getByRole("button", { name: "Get Saint" }).click();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(RELEASES_URL));
    await mounted.unmount();
  });

  it("keeps the sharing disclosure when the operator enabled diagnostics", async () => {
    setDesktopBridge({
      beta: { getState: vi.fn().mockResolvedValue(BETA_STATE) },
      betaDiagnostics: { rendererReady: vi.fn() },
      openExternal: vi.fn(),
    });

    const mounted = await render(withQueryClient(<BetaChannelSettingsPanel active />));
    await expect
      .element(mounted.getByRole("button", { name: "What Beta shares" }))
      .toBeInTheDocument();
    await mounted.unmount();
  });

  it("hides the Stable → Beta card when Beta is not installed and cannot be installed", async () => {
    const getState = vi.fn().mockResolvedValue({
      ...BETA_STATE,
      flavor: "production",
      installed: false,
      version: null,
      running: false,
    } satisfies DesktopBetaChannelState);
    setDesktopBridge({ beta: { getState }, openExternal: vi.fn() });

    const mounted = await render(withQueryClient(<BetaChannelSettingsPanel active />));
    await vi.waitFor(() => expect(getState).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mounted.container.textContent).toBe("");
    await mounted.unmount();
  });

  it("keeps the local handoff for an installed Beta without sharing claims", async () => {
    setDesktopBridge({
      beta: {
        getState: vi.fn().mockResolvedValue({
          ...BETA_STATE,
          flavor: "production",
          running: false,
        } satisfies DesktopBetaChannelState),
      },
      openExternal: vi.fn(),
    });

    const mounted = await render(withQueryClient(<BetaChannelSettingsPanel active />));
    await expect.element(mounted.getByRole("button", { name: "Open Beta" })).toBeVisible();
    expect(mounted.container.textContent).not.toContain("shares");
    expect(mounted.getByRole("button", { name: "Install Saint Beta" }).query()).toBeNull();
    await mounted.unmount();
  });
});
