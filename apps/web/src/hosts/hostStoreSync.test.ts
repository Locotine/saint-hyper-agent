import type { DesktopRemoteSshHostState } from "@saint/contracts";
import { sshHostId } from "@saint/shared/hostId";
import { describe, expect, it, vi } from "vitest";

import { createHostStoreSync } from "./hostStoreSync";

const KEY = "a1b2c3d4";
const hostId = sshHostId(KEY);

function hostState(overrides: Partial<DesktopRemoteSshHostState> = {}): DesktopRemoteSshHostState {
  return {
    host: "devbox",
    hostKey: KEY,
    epoch: 1,
    remoteRoot: ".saint",
    phase: "connected",
    message: null,
    localPort: 45_000,
    ...overrides,
  };
}

function setup() {
  const leases: { epoch: number; release: ReturnType<typeof vi.fn> }[] = [];
  const pumps: { stop: ReturnType<typeof vi.fn>; epoch: number }[] = [];
  const removed: string[] = [];
  const statuses: string[] = [];
  let urlCalls = 0;
  const sync = createHostStoreSync({
    wsUrl: async (host) => {
      urlCalls += 1;
      return `ws://127.0.0.1:45000/?token=t${urlCalls}&h=${host}`;
    },
    acquire: (_hostId, epoch) => {
      const lease = { epoch, release: vi.fn() };
      leases.push(lease);
      return { hostId, epoch, transport: {} as never, release: lease.release };
    },
    startPump: ({ onStatus }) => {
      const pump = { stop: vi.fn(), epoch: leases.at(-1)!.epoch };
      pumps.push(pump);
      onStatus?.("live");
      return pump.stop;
    },
    store: (id) => ({ id }) as never,
    setStatus: (_id, status) => statuses.push(status),
    removeStore: (id) => removed.push(id),
  });
  return { sync, leases, pumps, removed, statuses };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("hostStoreSync", () => {
  it("starts one pump for a connected host and keeps it across repeated states", async () => {
    const { sync, pumps, leases } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    await flush();
    sync.reconcile([hostState()], new Set([KEY]));
    sync.reconcile([hostState({ message: "ignored" })], new Set([KEY]));
    await flush();
    expect(pumps).toHaveLength(1);
    expect(leases).toHaveLength(1);
  });

  it("ignores hosts that are not connected or carry no key", async () => {
    const { sync, pumps } = setup();
    sync.reconcile(
      [
        hostState({ phase: "tunneling" }),
        hostState({ hostKey: null, host: "old" }),
        hostState({ phase: "reconnecting" }),
      ],
      new Set([KEY]),
    );
    await flush();
    expect(pumps).toHaveLength(0);
  });

  it("keeps the pump while the tunnel reconnects, and replaces it on a new epoch", async () => {
    const { sync, pumps, leases } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    await flush();

    sync.reconcile([hostState({ phase: "reconnecting" })], new Set([KEY]));
    expect(pumps[0]?.stop).not.toHaveBeenCalled();

    sync.reconcile([hostState({ epoch: 2 })], new Set([KEY]));
    await flush();
    expect(pumps[0]?.stop).toHaveBeenCalledTimes(1);
    expect(leases[0]?.release).toHaveBeenCalledTimes(1);
    expect(pumps).toHaveLength(2);
    expect(pumps[1]?.epoch).toBe(2);
  });

  it("stops the pump but keeps the store when the host disconnects", async () => {
    const { sync, pumps, leases, removed } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    await flush();
    sync.reconcile([hostState({ phase: "idle", localPort: null })], new Set([KEY]));
    expect(pumps[0]?.stop).toHaveBeenCalledTimes(1);
    expect(leases[0]?.release).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([]);
  });

  it("drops the store of a host that was forgotten", async () => {
    const { sync, pumps, removed } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    await flush();
    sync.reconcile([hostState({ phase: "idle", localPort: null })], new Set());
    expect(pumps[0]?.stop).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([hostId]);
  });

  it("does not start a pump for a host that went away while its url was being fetched", async () => {
    const { sync, pumps, leases } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    sync.reconcile([hostState({ phase: "idle", localPort: null })], new Set([KEY]));
    await flush();
    expect(pumps).toHaveLength(0);
    expect(leases).toHaveLength(0);
  });

  it("dispose stops every pump", async () => {
    const { sync, pumps, leases } = setup();
    sync.reconcile([hostState()], new Set([KEY]));
    await flush();
    sync.dispose();
    expect(pumps[0]?.stop).toHaveBeenCalledTimes(1);
    expect(leases[0]?.release).toHaveBeenCalledTimes(1);
  });
});
