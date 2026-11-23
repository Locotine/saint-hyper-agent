// FILE: remoteServerForward.ts
// Purpose: Opens a remote host's dev server on this computer through the desktop's SSH port
//          forward (Tauri only).
// Layer: Web platform bridge
// Exports: remoteServerForwarder

import type { DesktopBridge } from "@saint/contracts";

import { remoteSshBridge } from "./devLoopbackHosts";

type ForwardPort = NonNullable<NonNullable<DesktopBridge["remoteSsh"]>["forwardPort"]>;

/**
 * A function that forwards a server URL listed by the SSH host `host` and resolves to the local
 * URL, or null where the shell cannot forward (Electron, browsers): remote servers are then not
 * openable. A null `host` (its live state not loaded yet) rejects instead of guessing.
 */
export function remoteServerForwarder(
  host: string | null,
  forwardPort: ForwardPort | undefined = remoteSshBridge()?.forwardPort,
): ((url: string) => Promise<string>) | null {
  if (!forwardPort) return null;
  return async (url) => {
    if (!host) throw new Error("This chat's SSH host is not connected.");
    const target = new URL(url);
    const remotePort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
    const local = new URL(await forwardPort({ host, remotePort }));
    const basePrefix = local.pathname.replace(/\/+$/, "");
    target.hostname = local.hostname;
    target.port = local.port;
    if (basePrefix && basePrefix !== "/") {
      // LAN relay proxies terminate HTTP at the relay; direct desktop SSH forwards preserve the target's scheme.
      target.protocol = local.protocol;
      const suffix = target.pathname.startsWith("/") ? target.pathname : `/${target.pathname}`;
      target.pathname = `${basePrefix}${suffix}`;
    }
    return target.toString();
  };
}
