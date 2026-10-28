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
import { hostStores } from "../hosts/hostStores";
import { LIVE_CATALOG_ENABLED } from "./useRemoteHostCatalog";
import { remoteSshBridge } from "../lib/devLoopbackHosts";

export function useRemoteHostStoreSync(state: DesktopRemoteSshState): void {
  const syncRef = useRef<ReturnType<typeof createHostStoreSync> | null>(null);

  useEffect(() => {
    const bridge = remoteSshBridge();
    if (!bridge || !LIVE_CATALOG_ENABLED) return;
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
