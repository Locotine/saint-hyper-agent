/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.nativeApi via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined);

/**
 * The SSH host this window's server runs on, or null for the local app and
 * browsers. Paths in a remote window belong to that host.
 */
export const remoteWindowHost: string | null =
  typeof window !== "undefined" ? (window.desktopBridge?.remoteWindow?.host ?? null) : null;
