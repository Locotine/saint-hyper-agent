// FILE: useRemoteSshState.ts
// Purpose: Live remote SSH host state from the desktop bridge (Beta), shared by Settings and the sidebar.
// Layer: Hook
// Exports: useRemoteSshState

import type { DesktopRemoteSshState } from "@saint/contracts";
import { useEffect, useState } from "react";
import { remoteSshBridge } from "../lib/devLoopbackHosts";

/** Null until the first state arrives, and always null without the bridge (Stable, browsers). */
export function useRemoteSshState(
  active = true,
  onError?: (error: unknown) => void,
): DesktopRemoteSshState | null {
  const [state, setState] = useState<DesktopRemoteSshState | null>(null);

  useEffect(() => {
    const bridge = remoteSshBridge();
    if (!active || !bridge) return;
    let cancelled = false;
    void bridge.getState().then((next) => {
      if (!cancelled) setState(next);
    }, onError);
    const unsubscribe = bridge.onState(setState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the error handler must not resubscribe
  }, [active]);

  return state;
}
