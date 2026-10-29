// FILE: useDeviceEventBridge.ts
// Purpose: Capture device events globally and deliver deferred pane requests to a chat surface.
// Layer: Web event bridge hook
// Exports: useDeviceEventBridge, useDevicePaneOpenRequests
// Depends on: nativeApi device.onEvent, deviceStateStore
//
// The browser pane gets its open requests over desktop IPC; the device engine
// lives in apps/server, so the equivalent signal is a WebSocket push and this
// works in a plain browser tab as well as the desktop app.

import type { DeviceEvent, DeviceOpenPaneRequestedEvent } from "@saint/contracts";
import { useEffect, useEffectEvent } from "react";

import { ensureLocalNativeApi } from "~/nativeApi";
import { useDeviceStateStore } from "../deviceStateStore";

/** Applies one device event to the store, from this computer's server or a connected host's. */
export function handleDeviceEvent(event: DeviceEvent): void {
  const store = useDeviceStateStore.getState();
  if (event.type === "device.thread-state") {
    store.upsertThreadState(event.state);
  } else {
    // The server sends this once per thread/device. Retain it until a
    // surface can honor it, even if automatic opening is currently off.
    store.queueOpenRequest(event);
  }
}

/** Mounted once by EventRouter, including while settings or split view is open. */
export function useDeviceEventBridge(): void {
  useEffect(() => ensureLocalNativeApi().device.onEvent(handleDeviceEvent), []);
}

export function useDevicePaneOpenRequests(input: {
  /** Null while automatic opening is disabled or the surface cannot host a device pane. */
  readonly onOpenPaneRequested: ((event: DeviceOpenPaneRequestedEvent) => void) | null;
}): void {
  const pendingOpenRequests = useDeviceStateStore((store) => store.pendingOpenRequests);
  const openEnabled = input.onOpenPaneRequested !== null;
  const deliverPendingRequests = useEffectEvent(() => {
    const onOpen = input.onOpenPaneRequested;
    if (!onOpen) return;
    // Consume before delivery so remounting or closing a pane never replays it.
    for (const event of useDeviceStateStore.getState().takeOpenRequests()) onOpen(event);
  });

  useEffect(() => {
    if (openEnabled) deliverPendingRequests();
  }, [openEnabled, pendingOpenRequests]);
}
