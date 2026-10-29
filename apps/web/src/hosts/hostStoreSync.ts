// FILE: hostStoreSync.ts
// Purpose: Keeps one shell pump per connected remote host, driven by the desktop's host
//          states. A host that disconnects keeps its store (last known data, marked stale); a
//          host that was forgotten loses it.
// Layer: Web host connections
// Exports: createHostStoreSync

import type { DesktopRemoteSshHostState } from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";

import type { HostStore } from "../store";
import type { HostConnectionLease } from "./hostConnectionRegistry";
import type { HostShellStatus, HostShellTransport } from "./hostShellPump";

export interface HostStoreSyncDeps {
  /** The host's `ws://` URL (token included) from the desktop, or null when it has none. */
  readonly wsUrl: (host: string) => Promise<string | null>;
  readonly acquire: (
    hostId: HostId,
    epoch: number,
    url: string,
  ) => HostConnectionLease<HostShellTransport>;
  readonly startPump: (input: {
    store: HostStore;
    transport: HostShellTransport;
    onStatus: (status: HostShellStatus, message?: string) => void;
  }) => () => void;
  readonly store: (hostId: HostId) => HostStore;
  readonly setStatus: (hostId: HostId, status: HostShellStatus, message?: string) => void;
  readonly removeStore: (hostId: HostId) => void;
}

interface Active {
  readonly epoch: number;
  stop: (() => void) | null;
  release: (() => void) | null;
  /** Set once the host was torn down while its url was still being fetched. */
  cancelled: boolean;
}

export function createHostStoreSync(deps: HostStoreSyncDeps) {
  const active = new Map<HostId, Active>();

  const teardown = (hostId: HostId) => {
    const entry = active.get(hostId);
    if (!entry) return;
    active.delete(hostId);
    entry.cancelled = true;
    entry.stop?.();
    entry.release?.();
  };

  const start = (hostId: HostId, state: DesktopRemoteSshHostState) => {
    const entry: Active = { epoch: state.epoch, stop: null, release: null, cancelled: false };
    active.set(hostId, entry);
    deps.setStatus(hostId, "connecting");
    void deps
      .wsUrl(state.host)
      .then((url) => {
        if (entry.cancelled) return;
        if (!url) throw new Error("The host's server is not reachable.");
        const lease = deps.acquire(hostId, state.epoch, url);
        entry.release = lease.release;
        entry.stop = deps.startPump({
          store: deps.store(hostId),
          transport: lease.transport,
          onStatus: (status, message) => deps.setStatus(hostId, status, message),
        });
      })
      .catch((error: unknown) => {
        if (entry.cancelled) return;
        deps.setStatus(hostId, "stale", error instanceof Error ? error.message : String(error));
      });
  };

  return {
    /**
     * `savedHostKeys` are the keys of hosts the user still has; a host outside it that is not
     * connected is forgotten.
     */
    reconcile(states: readonly DesktopRemoteSshHostState[], savedHostKeys: ReadonlySet<string>) {
      const seen = new Set<HostId>();
      for (const state of states) {
        if (!state.hostKey) continue;
        const hostId = sshHostId(state.hostKey);
        seen.add(hostId);
        const current = active.get(hostId);
        if (state.phase === "connected" && state.localPort !== null) {
          if (current && current.epoch === state.epoch) continue;
          teardown(hostId);
          start(hostId, state);
          continue;
        }
        // A dropped tunnel recovers on its own: the transport reconnects to the same URL.
        if (state.phase === "reconnecting" && current && current.epoch === state.epoch) continue;
        teardown(hostId);
        if (!savedHostKeys.has(state.hostKey)) deps.removeStore(hostId);
      }
      // A host the desktop no longer reports at all.
      for (const hostId of [...active.keys()]) {
        if (!seen.has(hostId)) teardown(hostId);
      }
    },
    dispose() {
      for (const hostId of [...active.keys()]) teardown(hostId);
    },
  };
}
