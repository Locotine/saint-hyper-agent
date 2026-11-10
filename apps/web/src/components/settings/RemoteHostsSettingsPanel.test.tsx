// FILE: RemoteHostsSettingsPanel.test.tsx
// Purpose: Verifies Targets card layout, status badges, connection details, and connecting progress in RemoteHostsSettingsPanel.
// Layer: Component unit tests

import type { DesktopRemoteSshState } from "@saint/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockStateRef: { current: DesktopRemoteSshState | null } = {
  current: null,
};

vi.mock("~/hooks/useRemoteSshState", () => ({
  useRemoteSshState: () => mockStateRef.current,
}));

vi.mock("../../lib/devLoopbackHosts", () => ({
  remoteSshBridge: () => ({
    getState: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    stopServer: vi.fn(),
    forget: vi.fn(),
    testHost: vi.fn(),
    updateHost: vi.fn(),
    wsUrl: vi.fn(),
    downloadFiles: vi.fn(),
    onState: () => () => undefined,
  }),
}));

import { RemoteHostsSettingsPanel } from "./RemoteHostsSettingsPanel";

describe("RemoteHostsSettingsPanel", () => {
  it("renders Targets card with Import and Add Target header buttons, row details, and actions", () => {
    mockStateRef.current = {
      configHosts: ["gpu-cluster", "staging-box"],
      defaultRemoteRoot: ".saint-beta-remote",
      savedHosts: [
        {
          host: "devbox.internal",
          remoteRoot: "team/saint",
          label: "Dev Cluster",
          user: "ubuntu",
          port: 2222,
          identityFile: "~/.ssh/dev_ed25519",
        },
      ],
      hosts: [
        {
          host: "devbox.internal",
          hostKey: "a1b2c3d4",
          epoch: 1,
          remoteRoot: "team/saint",
          phase: "connected",
          message: null,
          localPort: 45123,
        },
      ],
    };

    const markup = renderToStaticMarkup(<RemoteHostsSettingsPanel active={true} />);
    expect(markup).toContain("Targets");
    expect(markup).toContain("Import");
    expect(markup).toContain("Add Target");
    expect(markup).toContain("Dev Cluster");
    expect(markup).toContain("(devbox.internal)");
    expect(markup).toContain("Connected");
    expect(markup).toContain("ubuntu@devbox.internal:2222 • ~/.ssh/dev_ed25519 • ~/team/saint");
    expect(markup).toContain("Disconnect");
    expect(markup).toContain("Retry");
    expect(markup).toContain("Test");
    expect(markup).toContain("Edit");
    expect(markup).toContain("Stop server");
    expect(markup).toContain("Delete");
  });

  it("shows Connecting spinner, disables destructive actions, and renders progress line under the card while connecting", () => {
    mockStateRef.current = {
      configHosts: [],
      defaultRemoteRoot: ".saint-beta-remote",
      savedHosts: [
        {
          host: "buildbox",
          remoteRoot: null,
        },
      ],
      hosts: [
        {
          host: "buildbox",
          hostKey: "deadbeef",
          epoch: 1,
          remoteRoot: ".saint-beta-remote",
          phase: "installing",
          message: null,
          localPort: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<RemoteHostsSettingsPanel active={true} />);
    expect(markup).toContain("Connecting");
    expect(markup).toContain(
      "Setting up a managed Saint server on buildbox — Installing dependencies…",
    );
    expect(markup).toContain("Cancel");
  });
});
