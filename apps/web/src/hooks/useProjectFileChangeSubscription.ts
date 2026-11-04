// FILE: useProjectFileChangeSubscription.ts
// Purpose: Keep one visible workspace-file watcher subscribed for a panel.
// Layer: Web query invalidation hook

import { WS_PROJECT_FILE_WATCH_CAPABILITY, type ProjectFileChangeEvent } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useEffect, useSyncExternalStore } from "react";

import { apiFor } from "../hosts/hostApi";

import {
  onNativeApiServerCapabilitiesChange,
  readLocalNativeApi,
  readNativeApiServerCapability,
} from "../nativeApi";

const subscribeFileWatchCapability = (listener: () => void) =>
  onNativeApiServerCapabilitiesChange(listener);
const readFileWatchCapability = () =>
  readNativeApiServerCapability(WS_PROJECT_FILE_WATCH_CAPABILITY);
const readServerFileWatchCapability = () => false;

export function useProjectFileChangeSubscription(input: {
  // The host the workspace lives on; this computer by default.
  hostId?: HostId;
  cwd: string | null;
  relativePath: string | null;
  enabled: boolean;
  onChange: (event: ProjectFileChangeEvent) => void;
}): void {
  const capabilityAvailable = useSyncExternalStore(
    subscribeFileWatchCapability,
    readFileWatchCapability,
    readServerFileWatchCapability,
  );

  useEffect(() => {
    const hostId = input.hostId ?? LOCAL_HOST_ID;
    // The capability flag describes this computer's server; a host's API just omits the watch.
    if (
      !input.enabled ||
      (hostId === LOCAL_HOST_ID && !capabilityAvailable) ||
      !input.cwd ||
      !input.relativePath
    ) {
      return;
    }
    const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
    return api?.projects.onFileChange?.(
      { cwd: input.cwd, relativePath: input.relativePath },
      input.onChange,
    );
  }, [capabilityAvailable, input.cwd, input.enabled, input.hostId, input.onChange, input.relativePath]);
}
