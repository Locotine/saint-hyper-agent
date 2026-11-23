// FILE: useRemoteSshState.ts
// Purpose: Live remote SSH host state from the desktop or LAN-relay bridge, shared through one
//          deduplicated store so Settings, Sidebar, and Chat surfaces never re-render redundantly.
// Layer: Hook
// Exports: useRemoteSshState, useRemoteHostAlias, resetRemoteSshStateStoreForTests

import type { DesktopRemoteSshState } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { remoteHostAlias } from "../components/settings/remoteHostsSettingsModel";
import { remoteSshBridge } from "../lib/devLoopbackHosts";
import {
  isLanRelayRemoteSshAvailable,
  probeLanRelayRemoteSshAvailability,
  subscribeLanRelayRemoteSshAvailability,
} from "../lib/lanRelayRemoteSshBridge";

type RemoteSshBridge = NonNullable<ReturnType<typeof remoteSshBridge>>;

interface SharedRemoteSshStore {
  bridge: RemoteSshBridge | null;
  snapshot: DesktopRemoteSshState | null;
  snapshotKey: string | null;
  unsubscribeBridge: (() => void) | null;
  fetchInFlight: boolean;
  listeners: Set<() => void>;
  errorListeners: Set<(error: unknown) => void>;
}

const store: SharedRemoteSshStore = {
  bridge: null,
  snapshot: null,
  snapshotKey: null,
  unsubscribeBridge: null,
  fetchInFlight: false,
  listeners: new Set(),
  errorListeners: new Set(),
};

function notifyStoreListeners(): void {
  for (const listener of [...store.listeners]) {
    listener();
  }
}

function applySnapshot(next: DesktopRemoteSshState): void {
  const nextKey = JSON.stringify(next);
  if (store.snapshot !== null && store.snapshotKey === nextKey) {
    return;
  }
  store.snapshot = next;
  store.snapshotKey = nextKey;
  notifyStoreListeners();
}

function detachBridge(): void {
  store.unsubscribeBridge?.();
  store.unsubscribeBridge = null;
  store.bridge = null;
  store.fetchInFlight = false;
}

function ensureBridgeSubscription(): void {
  if (store.listeners.size === 0) return;
  const currentBridge = remoteSshBridge() ?? null;
  if (currentBridge === store.bridge) {
    if (currentBridge && store.snapshot === null && !store.fetchInFlight) {
      fetchInitialState(currentBridge);
    }
    return;
  }
  detachBridge();
  store.bridge = currentBridge;
  if (!currentBridge) {
    if (store.snapshot !== null) {
      store.snapshot = null;
      store.snapshotKey = null;
      notifyStoreListeners();
    }
    return;
  }
  store.unsubscribeBridge = currentBridge.onState((next) => {
    if (store.bridge !== currentBridge) return;
    applySnapshot(next);
  });
  fetchInitialState(currentBridge);
}

function fetchInitialState(bridge: RemoteSshBridge): void {
  store.fetchInFlight = true;
  void bridge.getState().then(
    (next) => {
      if (store.bridge !== bridge) return;
      store.fetchInFlight = false;
      applySnapshot(next);
    },
    (error: unknown) => {
      if (store.bridge !== bridge) return;
      store.fetchInFlight = false;
      for (const listener of [...store.errorListeners]) {
        listener(error);
      }
    },
  );
}

/** @internal Subscribe directly to the shared deduplicated store (used by hooks and tests). */
export function subscribeRemoteSshStore(listener: () => void): () => void {
  store.listeners.add(listener);
  ensureBridgeSubscription();
  const unsubscribeLanRelay = subscribeLanRelayRemoteSshAvailability(() => {
    ensureBridgeSubscription();
  });
  return () => {
    unsubscribeLanRelay();
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      detachBridge();
    }
  };
}

/** @internal Read the current shared snapshot (used by hooks and tests). */
export function readRemoteSshSnapshot(): DesktopRemoteSshState | null {
  return store.snapshot;
}

const NOOP_SUBSCRIBE = () => () => undefined;

/** Null until the first state arrives, and always null without a desktop or LAN-relay bridge. */
export function useRemoteSshState(
  active = true,
  onError?: (error: unknown) => void,
): DesktopRemoteSshState | null {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!active) return;
    if (!remoteSshBridge() && !isLanRelayRemoteSshAvailable()) {
      void probeLanRelayRemoteSshAvailability();
    }
    if (!onErrorRef.current) return;
    const errorListener = (error: unknown) => {
      onErrorRef.current?.(error);
    };
    store.errorListeners.add(errorListener);
    return () => {
      store.errorListeners.delete(errorListener);
    };
  }, [active]);

  return useSyncExternalStore(
    active ? subscribeRemoteSshStore : NOOP_SUBSCRIBE,
    active ? readRemoteSshSnapshot : () => null,
    () => null,
  );
}

/**
 * Resolves only the display alias of one remote host. Local chats never subscribe at all,
 * and remote chats only re-render when that specific host's alias string changes (never on
 * connect-phase ticks of this or other hosts).
 */
export function useRemoteHostAlias(hostId: HostId): string | null {
  const isRemote = hostId !== LOCAL_HOST_ID;

  useEffect(() => {
    if (!isRemote) return;
    if (!remoteSshBridge() && !isLanRelayRemoteSshAvailable()) {
      void probeLanRelayRemoteSshAvailability();
    }
  }, [isRemote]);

  return useSyncExternalStore(
    isRemote ? subscribeRemoteSshStore : NOOP_SUBSCRIBE,
    () => (isRemote ? remoteHostAlias(readRemoteSshSnapshot(), hostId) : null),
    () => null,
  );
}

/** @internal Test helper to reset shared state between Vitest cases. */
export function resetRemoteSshStateStoreForTests(): void {
  detachBridge();
  store.snapshot = null;
  store.snapshotKey = null;
  store.listeners.clear();
  store.errorListeners.clear();
}
