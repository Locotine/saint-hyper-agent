import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  create: vi.fn((config) => ({
    ...config,
    terminal: { focus: vi.fn() },
    searchAddon: {},
    runtimeStatus: "ready",
  })),
  dispose: vi.fn(),
}));

vi.mock("./terminalRuntime", () => ({
  createRuntimeEntry: runtime.create,
  disposeRuntimeEntry: runtime.dispose,
  attachRuntimeToContainer: vi.fn(),
  detachRuntimeFromContainer: vi.fn(),
  syncRuntimeConfig: vi.fn(),
  updateRuntimeViewState: vi.fn(),
}));

import { LOCAL_HOST_ID, sshHostId, type HostId } from "@saint/shared/hostId";
import { removeOrphanedTerminalRuntimes } from "../../lib/terminalStateCleanup";
import { buildTerminalRuntimeKey, terminalRuntimeRegistry } from "./terminalRuntimeRegistry";

function attach(threadId: string, providerAuthInstanceId?: string, hostId: HostId = LOCAL_HOST_ID) {
  const runtimeKey = buildTerminalRuntimeKey(threadId, "terminal-1", hostId);
  terminalRuntimeRegistry.attach(
    {
      runtimeKey,
      hostId,
      threadId,
      terminalId: "terminal-1",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      ...(providerAuthInstanceId ? { providerAuthInstanceId } : {}),
      callbacks: {
        onSessionExited: vi.fn(),
        onTerminalMetadataChange: vi.fn(),
        onTerminalActivityChange: vi.fn(),
      },
    },
    { autoFocus: false, isVisible: false },
    {} as HTMLDivElement,
  );
  terminalRuntimeRegistry.detach(runtimeKey);
}

afterEach(() => {
  terminalRuntimeRegistry.disposeOrphanedThreads(new Set());
  vi.clearAllMocks();
});

describe("terminal runtime memory ownership", () => {
  it("returns detached runtimes to baseline across repeated host and dock deletion", () => {
    const active = new Set(["keep", "dock-terminal:keep"]);
    for (const id of active) attach(id);
    for (let index = 0; index < 20; index += 1) {
      attach(`removed-${index}`);
      attach(`dock-terminal:removed-${index}`);
      removeOrphanedTerminalRuntimes(active);
      expect(runtime.create.mock.calls.length - runtime.dispose.mock.calls.length).toBe(2);
    }
    // Hidden, still-owned terminals reuse their original xterm instances.
    const created = runtime.create.mock.calls.length;
    for (const id of active) attach(id);
    expect(runtime.create).toHaveBeenCalledTimes(created);
    removeOrphanedTerminalRuntimes(new Set());
    expect(runtime.dispose).toHaveBeenCalledTimes(created);
  });

  it("keeps settings-owned authentication terminals alive when unrelated chats are removed", () => {
    attach("provider-auth:work", "codex_work");
    attach("removed-chat");
    removeOrphanedTerminalRuntimes(new Set());
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual(["removed-chat"]);
    terminalRuntimeRegistry.disposeTerminal("provider-auth:work", "terminal-1");
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual([
      "removed-chat",
      "provider-auth:work",
    ]);
  });

  it("disposes only the exact scope when ids contain the runtime key separator", () => {
    attach("host");
    attach("host::nested");
    terminalRuntimeRegistry.disposeThread("host");
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose.mock.calls[0]?.[0].threadId).toBe("host");
  });

  it("disposes a remote host terminal without affecting the local host entry of the same threadId", () => {
    const remoteHostId = sshHostId("deadbeef");
    attach("shared-thread", undefined, LOCAL_HOST_ID);
    attach("shared-thread", undefined, remoteHostId);

    terminalRuntimeRegistry.disposeTerminal("shared-thread", "terminal-1", remoteHostId);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose.mock.calls[0]?.[0].runtimeKey).toBe(
      buildTerminalRuntimeKey("shared-thread", "terminal-1", remoteHostId),
    );
  });
});
