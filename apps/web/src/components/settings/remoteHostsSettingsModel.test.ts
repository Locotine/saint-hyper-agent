import type { DesktopRemoteSshHostState } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  formatRemoteHostConnectionDetails,
  isRemoteHostBusy,
  remoteHostBadgeLabel,
  remoteHostConnectingProgress,
  remoteHostRows,
  remoteHostStatus,
  remoteHostStatusTone,
} from "./remoteHostsSettingsModel";

const hostState = (
  host: string,
  phase: DesktopRemoteSshHostState["phase"],
  extra: Partial<DesktopRemoteSshHostState> = {},
): DesktopRemoteSshHostState => ({
  host,
  hostKey: null,
  epoch: 0,
  remoteRoot: ".saint-beta-remote",
  phase,
  message: null,
  localPort: null,
  ...extra,
});

describe("remoteHostRows", () => {
  it("keeps saved order, fills the default folder, and appends live unsaved hosts", () => {
    const rows = remoteHostRows({
      configHosts: [],
      defaultRemoteRoot: ".saint-beta-remote",
      savedHosts: [
        { host: "k6", remoteRoot: "squad/saint" },
        { host: "devbox", remoteRoot: null },
      ],
      hosts: [
        hostState("devbox", "connected", { localPort: 45000 }),
        hostState("old", "error", { message: "boom" }),
        hostState("idle-forgotten", "idle"),
      ],
    });
    expect(rows.map((row) => [row.host, row.remoteRoot, row.saved])).toEqual([
      ["k6", "squad/saint", true],
      ["devbox", ".saint-beta-remote", true],
      ["old", ".saint-beta-remote", false],
    ]);
    expect(rows[1]?.state?.phase).toBe("connected");
    expect(rows[2]?.savedRemoteRoot).toBeNull();
  });
});

describe("remoteHostStatus", () => {
  it("describes each phase", () => {
    expect(remoteHostStatus(null)).toBe("Not connected");
    expect(remoteHostStatus(hostState("a", "installing"))).toBe("Installing dependencies…");
    expect(remoteHostStatus(hostState("a", "connected", { localPort: 45000 }))).toBe(
      "Connected · forwarded to 127.0.0.1:45000",
    );
  });

  it("marks in-flight phases busy", () => {
    expect(isRemoteHostBusy(hostState("a", "uploading"))).toBe(true);
    expect(isRemoteHostBusy(hostState("a", "connected"))).toBe(false);
    expect(isRemoteHostBusy(hostState("a", "error"))).toBe(false);
    expect(isRemoteHostBusy(null)).toBe(false);
  });

  it("formats connection details, status badges, and connecting progress copy", () => {
    expect(
      formatRemoteHostConnectionDetails({
        host: "devbox.internal",
        user: "ubuntu",
        port: 2222,
        identityFile: "~/.ssh/prod_key",
      }),
    ).toBe("ubuntu@devbox.internal:2222 • ~/.ssh/prod_key");

    expect(
      formatRemoteHostConnectionDetails({
        host: "alice@gpu.example.com:2200",
      }),
    ).toBe("alice@gpu.example.com:2200 • ~/.ssh/id_ed25519");

    expect(remoteHostStatusTone(null)).toBe("disconnected");
    expect(remoteHostBadgeLabel(null)).toBe("Disconnected");
    expect(remoteHostBadgeLabel(hostState("a", "starting"))).toBe("Connecting…");
    expect(remoteHostBadgeLabel(hostState("a", "connected"))).toBe("Connected");
    expect(remoteHostBadgeLabel(hostState("a", "error"))).toBe("Error");

    expect(
      remoteHostConnectingProgress({
        host: "devbox",
        displayName: "Staging GPU",
        state: hostState("devbox", "installing"),
      }),
    ).toBe("Setting up a managed Saint server on Staging GPU — Installing dependencies…");
    expect(
      remoteHostConnectingProgress({
        host: "devbox",
        displayName: "Staging GPU",
        state: hostState("devbox", "connected"),
      }),
    ).toBeNull();
  });
});
