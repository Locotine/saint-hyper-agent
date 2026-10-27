// FILE: subframeNavigationGuard.ts
// Purpose: Keeps every subframe in the app window on the document the app wrote into it.
// Layer: Desktop main-process window hardening
// Exports: isAllowedAppSubframeNavigation, attachAppSubframeNavigationGuard

import { HTML_PREVIEW_ROUTE_PATH } from "@saint/shared/localPreviewFiles";
import type { WebContents } from "electron";

function serverHttpOrigin(serverWsUrl: string | null | undefined): string | null {
  if (!serverWsUrl) return null;
  try {
    const wsUrl = new URL(serverWsUrl);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : null;
    return protocol ? `${protocol}//${wsUrl.host}` : null;
  } catch {
    return null;
  }
}

/**
 * The app window embeds untrusted documents as `srcdoc` frames (inline
 * visuals) and as HTML file previews from its own server's grant-scoped
 * preview route. A page can still navigate its own frame - by script, a meta
 * refresh, or a link - and carry data out in the URL; content security policy
 * cannot stop that. Here it can: a subframe may load only its inline document
 * or a file of the window's server preview route, which serves granted folders
 * and nothing else. The in-app browser uses `<webview>` guests, which are
 * separate WebContents.
 */
export function isAllowedAppSubframeNavigation(url: string, serverWsUrl?: string | null): boolean {
  if (url === "about:srcdoc" || url === "about:blank") return true;
  const serverOrigin = serverHttpOrigin(serverWsUrl);
  if (!serverOrigin) return false;
  try {
    // Parsing resolves dot segments, so the prefix check cannot be walked out of.
    const target = new URL(url);
    return (
      target.origin === serverOrigin && target.pathname.startsWith(`${HTML_PREVIEW_ROUTE_PATH}/`)
    );
  } catch {
    return false;
  }
}

/** `serverWsUrl` names the window's live backend, read on each navigation. */
export function attachAppSubframeNavigationGuard(
  webContents: Pick<WebContents, "on">,
  serverWsUrl: () => string | null = () => null,
): void {
  webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedAppSubframeNavigation(event.url, serverWsUrl())) {
      event.preventDefault();
    }
  });
}
