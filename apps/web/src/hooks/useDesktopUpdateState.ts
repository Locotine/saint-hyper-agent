// FILE: useDesktopUpdateState.ts
// Purpose: Subscribe to the desktop auto-updater state pushed by the Electron main process.
// Layer: Web hook
// Exports: useDesktopUpdateState

import type { DesktopUpdateState } from "@saint/contracts";
import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import { isElectron } from "~/env";

/**
 * Current updater state, or null in a browser or before the first answer. A push
 * that lands before the initial `getUpdateState` reply wins, so a stale snapshot
 * never overwrites a newer state.
 */
export function useDesktopUpdateState(): readonly [
  DesktopUpdateState | null,
  Dispatch<SetStateAction<DesktopUpdateState | null>>,
] {
  const [state, setState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  return [state, setState] as const;
}
