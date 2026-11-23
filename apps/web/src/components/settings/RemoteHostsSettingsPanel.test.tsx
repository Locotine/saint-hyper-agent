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

import {
  RemoteHostListRow,
  RemoteHostsSettingsPanel,
  type RemoteHostPendingAction,
} from "./RemoteHostsSettingsPanel";
import { remoteHostRows } from "./remoteHostsSettingsModel";

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
    expect(markup).not.toContain("Stop server");
  });

  it("hides Stop server when the host failed to connect", () => {
    mockStateRef.current = {
      configHosts: [],
      defaultRemoteRoot: ".saint-remote",
      savedHosts: [{ host: "offline-box", remoteRoot: null }],
      hosts: [
        {
          host: "offline-box",
          hostKey: "cafebabe",
          epoch: 1,
          remoteRoot: ".saint-remote",
          phase: "error",
          message: "Could not reach the host (ssh exit 255): Connection reset by peer",
          localPort: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<RemoteHostsSettingsPanel active={true} />);
    expect(markup).toContain("Connect");
    expect(markup).not.toContain("Stop server");
  });

  it("keeps Stop server visible with a spinner and Stopping status while phase is stopping", () => {
    mockStateRef.current = {
      configHosts: [],
      defaultRemoteRoot: ".saint-remote",
      savedHosts: [{ host: "gpu-box", label: "GPU Box", remoteRoot: null }],
      hosts: [
        {
          host: "gpu-box",
          hostKey: "feedface",
          epoch: 2,
          remoteRoot: ".saint-remote",
          phase: "stopping",
          message: null,
          localPort: null,
        },
      ],
    };

    const markup = renderToStaticMarkup(<RemoteHostsSettingsPanel active={true} />);
    expect(markup).toContain("Stopping…");
    expect(markup).toContain("Stopping the managed Saint server on GPU Box…");
    expect(markup).toContain("Stop server");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain(">Cancel<");
    expect(markup).not.toContain(">Connect<");
  });

  it.each<{
    action: RemoteHostPendingAction;
    phase: DesktopRemoteSshState["hosts"][number]["phase"];
    expectedButton: string;
    expectedBadge: string;
  }>([
    { action: "connect", phase: "idle", expectedButton: "Connect", expectedBadge: "Connecting" },
    {
      action: "disconnect",
      phase: "connected",
      expectedButton: "Disconnect",
      expectedBadge: "Disconnecting…",
    },
    { action: "retry", phase: "connected", expectedButton: "Retry", expectedBadge: "Connecting" },
    {
      action: "stop",
      phase: "connected",
      expectedButton: "Stop server",
      expectedBadge: "Stopping…",
    },
  ])(
    "renders button spinner and badge loading state for pending $action action",
    ({ action, phase, expectedButton, expectedBadge }) => {
      const state: DesktopRemoteSshState = {
        configHosts: [],
        defaultRemoteRoot: ".saint-remote",
        savedHosts: [{ host: "devbox", remoteRoot: null }],
        hosts: [
          {
            host: "devbox",
            hostKey: "a1b2c3d4",
            epoch: 1,
            remoteRoot: ".saint-remote",
            phase,
            message: null,
            localPort: phase === "connected" ? 45123 : null,
          },
        ],
      };
      const row = remoteHostRows(state)[0]!;
      const noop = () => undefined;
      const markup = renderToStaticMarkup(
        <RemoteHostListRow
          row={row}
          testing={false}
          testResult={null}
          pendingAction={action}
          onConnect={noop}
          onRetry={noop}
          onDisconnect={noop}
          onStop={noop}
          onTest={noop}
          onEdit={noop}
          onDelete={noop}
        />,
      );

      expect(markup).toContain(expectedBadge);
      expect(markup).toMatch(
        new RegExp(`aria-busy="true"[^>]*>.*?animate-spin.*?<span>${expectedButton}</span>`),
      );
      if (action === "connect") {
        expect(markup).toContain("Checking the host…");
        expect(markup).not.toContain("Not connected");
      }
      if (action === "stop") {
        expect(markup).toContain("Stopping the server…");
      }
    },
  );
});
