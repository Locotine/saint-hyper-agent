import type { WebContents } from "electron";
import {
  SAINT_BETA_DESKTOP_SCHEME,
  SAINT_CANARY_DESKTOP_SCHEME,
  SAINT_CUA_DESKTOP_SCHEME,
  SAINT_DESKTOP_SCHEME,
} from "@saint/shared/desktopIdentity";

/** Copy buttons share the OS clipboard; background reads remain denied. */
export function isClipboardWritePermission(
  requester: Pick<WebContents, "isDestroyed" | "getURL"> | null,
  permission: string,
  details: { isMainFrame?: boolean; requestingUrl?: string; embeddingOrigin?: string },
  requestingOrigin?: string,
): boolean {
  if (
    permission !== "clipboard-sanitized-write" ||
    !requester ||
    requester.isDestroyed() ||
    details.isMainFrame === false
  )
    return false;
  try {
    // Chromium enforces document focus. Native window focus may already have
    // returned to the composer when an asynchronous copy requests permission.
    const page = new URL(requester.getURL());
    const trustedScheme =
      page.protocol === `${SAINT_DESKTOP_SCHEME}:` ||
      page.protocol === `${SAINT_CANARY_DESKTOP_SCHEME}:` ||
      page.protocol === `${SAINT_CUA_DESKTOP_SCHEME}:` ||
      page.protocol === `${SAINT_BETA_DESKTOP_SCHEME}:`;
    if (
      page.protocol !== "https:" &&
      !trustedScheme &&
      !(page.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname))
    )
      return false;
    return [requestingOrigin, details.requestingUrl, details.embeddingOrigin].every(
      (origin) => !origin || new URL(origin).origin === page.origin,
    );
  } catch {
    return false;
  }
}
