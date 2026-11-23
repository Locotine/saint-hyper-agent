import { LOCAL_HOST_ID, sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

import {
  emitTerminalWorkspaceActivity,
  subscribeTerminalWorkspaceActivity,
} from "./workspaceRefreshBus";

describe("workspaceRefreshBus", () => {
  it("notifies matching and overlapping paths on the same host only", () => {
    const remoteHostId = sshHostId("1234abcd");
    const localRootListener = vi.fn();
    const localSubdirListener = vi.fn();
    const remoteRootListener = vi.fn();

    const unsubLocalRoot = subscribeTerminalWorkspaceActivity(
      LOCAL_HOST_ID,
      "/repo",
      localRootListener,
    );
    const unsubLocalSub = subscribeTerminalWorkspaceActivity(
      LOCAL_HOST_ID,
      "/repo/apps/web",
      localSubdirListener,
    );
    const unsubRemote = subscribeTerminalWorkspaceActivity(
      remoteHostId,
      "/repo",
      remoteRootListener,
    );

    emitTerminalWorkspaceActivity({ hostId: LOCAL_HOST_ID, cwd: "/repo/" });
    expect(localRootListener).toHaveBeenCalledTimes(1);
    expect(localSubdirListener).toHaveBeenCalledTimes(1);
    expect(remoteRootListener).toHaveBeenCalledTimes(0);

    emitTerminalWorkspaceActivity({ hostId: remoteHostId, cwd: "/repo" });
    expect(localRootListener).toHaveBeenCalledTimes(1);
    expect(remoteRootListener).toHaveBeenCalledTimes(1);

    unsubLocalRoot();
    unsubLocalSub();
    unsubRemote();
  });
});
