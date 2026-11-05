// FILE: useRemoteHostStoreSync.ts
// Purpose: Mounts the per-host store sync: one shell pump per connected remote host, driven by
//          the desktop's host states.
// Layer: Hook
// Exports: useRemoteHostStoreSync

import type { DesktopRemoteSshState } from "@saint/contracts";
import { useEffect, useRef } from "react";

import { hostConnections } from "../hosts/hostConnectionRegistry";
import { createHostShellPump } from "../hosts/hostShellPump";
import { forgetHostClientState } from "../hosts/forgetHostClientState";
import { createHostStoreSync } from "../hosts/hostStoreSync";
import {
  INITIAL_AUTO_RECONNECT_ENTRY,
  reconnectRemoteHost,
  stepAutoReconnect,
  type AutoReconnectEntry,
} from "../hosts/hostReconnect";
import { hostStores } from "../hosts/hostStores";
import { remoteSshBridge } from "../lib/devLoopbackHosts";
import { sshHostId } from "@saint/shared/hostId";

const AUTO_RECONNECT_TICK_MS = 5_000;

export function useRemoteHostStoreSync(state: DesktopRemoteSshState): void {
  const syncRef = useRef<ReturnType<typeof createHostStoreSync> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Brings back a host whose tunnel the desktop gave up on, or whose stream went quiet behind a
  // tunnel that still looks connected, so a dropped host heals without a click.
  useEffect(() => {
    const entries = new Map<string, AutoReconnectEntry>();
    const inFlight = new Set<string>();
    const timer = setInterval(() => {
      const current = stateRef.current;
      const now = Date.now();
      for (const hostState of current.hosts) {
        const hostKey = hostState.hostKey;
        if (!hostKey || inFlight.has(hostKey)) continue;
        const step = stepAutoReconnect(entries.get(hostKey) ?? INITIAL_AUTO_RECONNECT_ENTRY, {
          now,
          phase: hostState.phase,
          streamStale: hostStores.status(sshHostId(hostKey)).status === "stale",
        });
        entries.set(hostKey, step.entry);
        if (!step.reconnect) continue;
        inFlight.add(hostKey);
        void reconnectRemoteHost({
          host: hostState.host,
          hostKey,
          remoteRoot:
            current.savedHosts.find((saved) => saved.hostKey === hostKey)?.remoteRoot ?? null,
          hostState,
        })
          .catch(() => undefined)
          .finally(() => inFlight.delete(hostKey));
      }
    }, AUTO_RECONNECT_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const bridge = remoteSshBridge();
    if (!bridge) return;
    const sync = createHostStoreSync({
      wsUrl: bridge.wsUrl,
      acquire: hostConnections.acquire,
      startPump: createHostShellPump,
      store: hostStores.get,
      setStatus: hostStores.setStatus,
      removeStore: (hostId) => {
        hostStores.remove(hostId);
        forgetHostClientState(hostId);
      },
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
    };
  }, []);

  useEffect(() => {
    const savedKeys = new Set(
      state.savedHosts.flatMap((saved) => (saved.hostKey ? [saved.hostKey] : [])),
    );
    syncRef.current?.reconcile(state.hosts, savedKeys);
  }, [state]);
}
