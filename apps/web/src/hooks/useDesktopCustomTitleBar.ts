// FILE: useDesktopCustomTitleBar.ts
// Purpose: Track whether the live Electron window is using the frameless custom title bar.
// Layer: Shared web shell chrome
// Depends on: desktop bridge customTitleBar IPC.

import { useEffect, useState } from "react";

import type { DesktopCustomTitleBarState } from "@saint/contracts";

import { isElectron } from "~/env";
import { getNavigatorPlatform, isLinuxPlatform, isWindowsPlatform } from "~/lib/utils";

const DEFAULT_STATE: DesktopCustomTitleBarState = {
  supported: false,
  preference: true,
  active: false,
  restartRequired: false,
};

const CUSTOM_TITLE_BAR_STATE_EVENT = "saint:custom-title-bar-state";

/**
 * Optimistic default before the bridge replies. Matches the shared platform
 * default (Windows: custom title bar on; Linux: native OS title bar off) so
 * gutters and caption buttons never flash on launch.
 */
export function initialDesktopCustomTitleBarActive(): boolean {
  if (!isElectron) return false;
  const platform = getNavigatorPlatform();
  return isWindowsPlatform(platform);
}

export function notifyDesktopCustomTitleBarState(next: DesktopCustomTitleBarState): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DesktopCustomTitleBarState>(CUSTOM_TITLE_BAR_STATE_EVENT, { detail: next }),
  );
}

export function useDesktopCustomTitleBarState(): DesktopCustomTitleBarState & {
  readonly loaded: boolean;
} {
  const [state, setState] = useState<DesktopCustomTitleBarState & { readonly loaded: boolean }>(
    () => {
      const platform = getNavigatorPlatform();
      const supported = isElectron && (isWindowsPlatform(platform) || isLinuxPlatform(platform));
      const active = initialDesktopCustomTitleBarActive();
      return {
        ...DEFAULT_STATE,
        supported,
        preference: active,
        active,
        restartRequired: false,
        loaded: false,
      };
    },
  );

  useEffect(() => {
    const bridge = window.desktopBridge?.customTitleBar;
    if (!bridge) return;
    let cancelled = false;

    void bridge.getState().then((next) => {
      if (!cancelled) setState({ ...next, loaded: true });
    });

    const handleStateEvent = (event: Event) => {
      const detail = (event as CustomEvent<DesktopCustomTitleBarState>).detail;
      if (detail) setState({ ...detail, loaded: true });
    };
    window.addEventListener(CUSTOM_TITLE_BAR_STATE_EVENT, handleStateEvent);

    return () => {
      cancelled = true;
      window.removeEventListener(CUSTOM_TITLE_BAR_STATE_EVENT, handleStateEvent);
    };
  }, []);

  return state;
}

export function useDesktopCustomTitleBarActive(): boolean {
  return useDesktopCustomTitleBarState().active;
}
