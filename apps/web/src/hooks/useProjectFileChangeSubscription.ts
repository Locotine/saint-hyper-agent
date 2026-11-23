// FILE: useProjectFileChangeSubscription.ts
// Purpose: Keep one visible workspace-file watcher subscribed for a panel across local and remote hosts.
// Layer: Web query invalidation hook

import { WS_PROJECT_FILE_WATCH_CAPABILITY, type ProjectFileChangeEvent } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { apiFor } from "../hosts/hostApi";
import { hostConnections } from "../hosts/hostConnectionRegistry";
import {
  onNativeApiServerCapabilitiesChange,
  readLocalNativeApi,
  readNativeApiServerCapability,
} from "../nativeApi";
import { addHostWsTransportStateListener } from "../wsTransportEvents";

const subscribeFileWatchCapability = (listener: () => void) =>
  onNativeApiServerCapabilitiesChange(listener);
const readFileWatchCapability = () =>
  readNativeApiServerCapability(WS_PROJECT_FILE_WATCH_CAPABILITY);
const readServerFileWatchCapability = () => false;

const subscribeHostConnections = (listener: () => void) => hostConnections.subscribe(listener);
const readServerHostTransport = () => undefined;

const FOCUS_FALLBACK_MIN_INTERVAL_MS = 1_500;

export function useProjectFileChangeSubscription(input: {
  // The host the workspace lives on; this computer by default.
  hostId?: HostId;
  cwd: string | null;
  relativePath: string | null;
  enabled: boolean;
  onChange: (event: ProjectFileChangeEvent) => void;
}): void {
  const hostId = input.hostId ?? LOCAL_HOST_ID;
  const localCapabilityAvailable = useSyncExternalStore(
    subscribeFileWatchCapability,
    readFileWatchCapability,
    readServerFileWatchCapability,
  );
  // Subscribe to remote host connection changes so the watcher attaches once the
  // remote host finishes connecting and re-attaches across SSH reconnect epochs.
  const remoteTransport = useSyncExternalStore(
    subscribeHostConnections,
    () => (hostId === LOCAL_HOST_ID ? undefined : hostConnections.peek(hostId)),
    readServerHostTransport,
  );
  const handleChange = useEffectEvent(input.onChange);

  useEffect(() => {
    if (!input.enabled || !input.cwd || !input.relativePath) {
      return;
    }
    const relativePath = input.relativePath;
    const emitSynthesizedChange = () => {
      handleChange({
        type: "changed",
        relativePath,
        mtimeMs: Date.now(),
      });
    };

    const api = hostId === LOCAL_HOST_ID ? readLocalNativeApi() : apiFor(hostId);
    const canWatchStream =
      hostId === LOCAL_HOST_ID
        ? localCapabilityAvailable && typeof api?.projects.onFileChange === "function"
        : typeof api?.projects.onFileChange === "function";

    const unsubscribeStream = canWatchStream
      ? api?.projects.onFileChange?.({ cwd: input.cwd, relativePath }, (event) =>
          handleChange(event),
        )
      : undefined;

    // On WS reconnect (local or remote), revalidate the open file once so edits that
    // happened during a disconnect are never missed.
    let sawOpen = false;
    const unsubscribeTransport = addHostWsTransportStateListener(
      hostId,
      (state) => {
        if (state !== "open") return;
        if (!sawOpen) {
          sawOpen = true;
          return;
        }
        emitSynthesizedChange();
      },
      { replayCurrent: true },
    );

    // Fallback for servers that do not advertise `projects.file-watch`: refresh on
    // window focus / visibility return so externally edited files still reload.
    let lastFallbackAt = 0;
    const triggerFallbackRefresh = () => {
      if (canWatchStream && hostId === LOCAL_HOST_ID) return;
      const now = Date.now();
      if (now - lastFallbackAt < FOCUS_FALLBACK_MIN_INTERVAL_MS) return;
      lastFallbackAt = now;
      emitSynthesizedChange();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) return;
      triggerFallbackRefresh();
    };

    window.addEventListener("focus", triggerFallbackRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribeStream?.();
      unsubscribeTransport();
      window.removeEventListener("focus", triggerFallbackRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    hostId,
    input.cwd,
    input.enabled,
    input.relativePath,
    localCapabilityAvailable,
    remoteTransport,
  ]);
}
