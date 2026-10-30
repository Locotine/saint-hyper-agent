import { describe, expect, it, vi } from "vitest";

import { registerRemoteSshIpc } from "./remoteSshIpc";
import type { SavedRemoteSshHost } from "./remoteSshConfig";

function setup(initial: SavedRemoteSshHost[], enabled = true) {
  let saved = initial;
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  const ipcMain = {
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler),
  };
  const manager = {
    connect: vi.fn(async (host: { host: string }) => ({ host: host.host })),
    disconnect: vi.fn(),
    states: () => [],
  };
  const registration = registerRemoteSshIpc(ipcMain as never, {
    enabled,
    manager: manager as never,
    defaultRemoteRoot: ".saint-remote",
    isControlRenderer: () => true,
    readSshConfig: () => null,
    readSavedHosts: () => saved,
    writeSavedHosts: (hosts) => {
      saved = [...hosts];
    },
    broadcast: vi.fn(),
    saveDownloads: vi.fn(),
  });
  const invoke = (channel: string, payload: unknown) => {
    const handler = [...handlers.entries()].find(([name]) => name.endsWith(channel));
    return handler![1]({}, payload);
  };
  return { registration, manager, invoke, saved: () => saved };
}

describe("remote SSH auto-connect", () => {
  it("reconnects every saved host except one the user disconnected", () => {
    const t = setup([
      { host: "devbox", remoteRoot: null, hostKey: "a1b2c3d4" },
      { host: "k6", remoteRoot: null, hostKey: "b2c3d4e5", autoConnect: false },
    ]);
    t.registration.autoConnectSavedHosts();
    expect(t.manager.connect).toHaveBeenCalledTimes(1);
    expect(t.manager.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "devbox", hostKey: "a1b2c3d4" }),
    );
  });

  it("gives a saved host without a key one before connecting it", () => {
    const t = setup([{ host: "devbox", remoteRoot: null }]);
    t.registration.autoConnectSavedHosts();
    const key = t.saved()[0]?.hostKey;
    expect(key).toMatch(/^[0-9a-f]{8}$/);
    expect(t.manager.connect).toHaveBeenCalledWith(expect.objectContaining({ hostKey: key }));
  });

  it("does nothing when remote hosts are not enabled", () => {
    const t = setup([{ host: "devbox", remoteRoot: null, hostKey: "a1b2c3d4" }], false);
    t.registration.autoConnectSavedHosts();
    expect(t.manager.connect).not.toHaveBeenCalled();
  });

  it("stops reconnecting a host once it is disconnected, until it is connected again", async () => {
    const t = setup([{ host: "devbox", remoteRoot: null, hostKey: "a1b2c3d4" }]);
    t.invoke("disconnect", "devbox");
    expect(t.saved()[0]).toMatchObject({ host: "devbox", autoConnect: false });
    t.registration.autoConnectSavedHosts();
    expect(t.manager.connect).not.toHaveBeenCalled();

    await t.invoke("connect", { host: "devbox" });
    expect(t.saved()[0]).not.toHaveProperty("autoConnect");
  });
});
