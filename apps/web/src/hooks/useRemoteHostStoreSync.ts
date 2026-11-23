// FILE: useRemoteHostStoreSync.ts
// Purpose: Mounts the per-host store sync: one shell pump per connected remote host, driven by
//          the desktop's host states.
// Layer: Hook
// Exports: useRemoteHostStoreSync

import { WS_CHANNELS, type DesktopRemoteSshState } from "@saint/contracts";
import { sshHostId, type HostId } from "@saint/shared/hostId";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";

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
import {
  isLanRelayRemoteSshAvailable,
  subscribeLanRelayRemoteSshAvailability,
} from "../lib/lanRelayRemoteSshBridge";
import {
  clearRemoteHostProviderStatusState,
  markRemoteHostProviderStatusesStale,
  reconcileRemoteHostProviderStatuses,
  refreshRemoteHostProviderStatuses,
} from "../lib/serverReactQuery";

const AUTO_RECONNECT_TICK_MS = 5_000;

export function useRemoteHostStoreSync(state: DesktopRemoteSshState): void {
  const queryClient = useQueryClient();
  const syncRef = useRef<ReturnType<typeof createHostStoreSync> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lanRelayAvailable = useSyncExternalStore(
    subscribeLanRelayRemoteSshAvailability,
    isLanRelayRemoteSshAvailable,
    () => false,
  );

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
    const providerStatusUnsubs = new Map<HostId, () => void>();
    const refreshGenerations = new Map<HostId, number>();
    const bumpRefreshGeneration = (hostId: HostId): number => {
      const next = (refreshGenerations.get(hostId) ?? 0) + 1;
      refreshGenerations.set(hostId, next);
      return next;
    };
    const detachProviderStatusSub = (hostId: HostId) => {
      const unsub = providerStatusUnsubs.get(hostId);
      if (unsub) {
        providerStatusUnsubs.delete(hostId);
        unsub();
      }
    };
    const sync = createHostStoreSync({
      wsUrl: bridge.wsUrl,
      acquire: hostConnections.acquire,
      startPump: createHostShellPump,
      store: hostStores.get,
      setStatus: (hostId, status, message) => {
        hostStores.setStatus(hostId, status, message);
        if (status === "live") {
          // Subscribe to remote provider health updates and kick off a live
          // provider refresh immediately once the socket is live: remote SSH
          // servers start with an empty status cache, so without an explicit
          // refresh their enabled providers (codex/claudeAgent) stay unprobed.
          const generation = bumpRefreshGeneration(hostId);
          detachProviderStatusSub(hostId);
          const transport = hostConnections.peek(hostId);
          if (transport) {
            const latest = transport.getLatestPush(WS_CHANNELS.serverProviderStatusesUpdated)?.data;
            if (latest) {
              void reconcileRemoteHostProviderStatuses(queryClient, hostId, latest.providers).catch(
                () => undefined,
              );
            }
            providerStatusUnsubs.set(
              hostId,
              transport.subscribe(WS_CHANNELS.serverProviderStatusesUpdated, (message) => {
                if (refreshGenerations.get(hostId) !== generation) return;
                void reconcileRemoteHostProviderStatuses(
                  queryClient,
                  hostId,
                  message.data.providers,
                ).catch(() => undefined);
              }),
            );
          }
          void refreshRemoteHostProviderStatuses(queryClient, hostId, {
            isCurrent: () => refreshGenerations.get(hostId) === generation,
          }).catch(() => undefined);
        } else {
          bumpRefreshGeneration(hostId);
          detachProviderStatusSub(hostId);
          markRemoteHostProviderStatusesStale(queryClient, hostId);
        }
      },
      removeStore: (hostId) => {
        bumpRefreshGeneration(hostId);
        detachProviderStatusSub(hostId);
        clearRemoteHostProviderStatusState(queryClient, hostId);
        hostStores.remove(hostId);
        forgetHostClientState(hostId);
      },
    });
    syncRef.current = sync;
    const savedKeys = new Set(
      stateRef.current.savedHosts.flatMap((saved) => (saved.hostKey ? [saved.hostKey] : [])),
    );
    sync.reconcile(stateRef.current.hosts, savedKeys);
    return () => {
      for (const hostId of refreshGenerations.keys()) {
        bumpRefreshGeneration(hostId);
      }
      for (const unsub of providerStatusUnsubs.values()) unsub();
      providerStatusUnsubs.clear();
      sync.dispose();
      syncRef.current = null;
    };
  }, [lanRelayAvailable, queryClient]);

  useEffect(() => {
    const savedKeys = new Set(
      state.savedHosts.flatMap((saved) => (saved.hostKey ? [saved.hostKey] : [])),
    );
    syncRef.current?.reconcile(state.hosts, savedKeys);
  }, [state]);
}
