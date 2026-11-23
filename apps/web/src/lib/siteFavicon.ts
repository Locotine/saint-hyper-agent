// FILE: siteFavicon.ts
// Purpose: Client helpers for the website-favicon feature — build authenticated
//          favicon proxy URLs (keyed by hostname so every link on a site shares
//          one cacheable request) and track per-src load outcomes so repeat
//          renders skip re-probing. Shared by <SiteFavicon> and every link chip
//          surface (composer, user bubble, markdown).
// Layer: UI utilities

import { resolveWsHttpUrl } from "./wsHttpUrl";

/** Per-favicon-src load outcome, shared module-wide to avoid re-probing within a session. */
export const siteFaviconStatusCache = new Map<string, "ok" | "fail">();

/** Resolved renderable src (may be a blob: URL fallback when custom-scheme <img> is blocked). */
const siteFaviconRenderSrcCache = new Map<string, string>();

/** In-flight probes keyed by favicon src, so concurrent callers share one load. */
const inFlightFaviconProbes = new Map<string, Promise<"ok" | "fail">>();

let desktopWsUrlVersion = 0;
const desktopWsUrlListeners = new Set<() => void>();
let desktopWsUrlSubscribed = false;

function ensureDesktopWsUrlListener(): void {
  if (desktopWsUrlSubscribed || typeof window === "undefined") return;
  desktopWsUrlSubscribed = true;
  window.addEventListener("desktop:ws-url-changed", () => {
    desktopWsUrlVersion += 1;
    for (const listener of [...desktopWsUrlListeners]) {
      listener();
    }
  });
}

/** Subscribes to desktop sidecar WS URL announcements so icons retry after boot. */
export function subscribeDesktopWsUrl(listener: () => void): () => void {
  ensureDesktopWsUrlListener();
  desktopWsUrlListeners.add(listener);
  return () => {
    desktopWsUrlListeners.delete(listener);
  };
}

/** Monotonic snapshot paired with {@link subscribeDesktopWsUrl}. */
export function getDesktopWsUrlSnapshot(): string {
  if (typeof window === "undefined") return "";
  const wsUrl = window.desktopBridge?.getWsUrl?.() ?? "";
  return `${desktopWsUrlVersion}:${wsUrl}`;
}

/**
 * True on desktop when the Tauri bridge exists but the sidecar has not published
 * its WS URL yet. Probing before then would hit `tauri://localhost/api/site-favicon`
 * and cache a false negative for the entire session.
 */
export function isWaitingForDesktopWsUrl(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge;
  if (!bridge || typeof bridge.getWsUrl !== "function") return false;
  const wsUrl = bridge.getWsUrl();
  return typeof wsUrl !== "string" || wsUrl.length === 0;
}

/** Returns the renderable image src (blob: fallback if needed, else the original URL). */
export function getSiteFaviconRenderSrc(faviconSrc: string): string {
  return siteFaviconRenderSrcCache.get(faviconSrc) ?? faviconSrc;
}

function loadImage(src: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
    });
    image.addEventListener("error", () => resolve(false));
    image.src = src;
  });
}

function shouldTryBlobFetchFallback(faviconSrc: string): boolean {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  const pageProtocol = window.location.protocol;
  if (pageProtocol === "http:" || pageProtocol === "https:") return false;
  return faviconSrc.startsWith("http://") || faviconSrc.startsWith("https://");
}

async function tryFetchBlobFavicon(faviconSrc: string): Promise<string | null> {
  if (
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return null;
  }
  try {
    const response = await fetch(faviconSrc, { credentials: "omit" });
    if (!response.ok || response.status === 204) return null;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) return null;
    const blob = await response.blob();
    if (blob.size === 0) return null;
    const objectUrl = URL.createObjectURL(blob);
    const decoded = await loadImage(objectUrl);
    if (!decoded) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return objectUrl;
  } catch {
    return null;
  }
}

/**
 * Probes a favicon src once and shares the outcome with every caller. Resolved
 * outcomes are memoized in {@link siteFaviconStatusCache} so later renders settle
 * synchronously; concurrent callers await a single shared Image() load yet EACH
 * receives the result. That last part matters for imperative consumers (the
 * composer link chip): every awaiting icon element runs its own `.then` and
 * patches itself, instead of one shared probe patching a single — possibly stale —
 * element.
 */
export function probeSiteFavicon(faviconSrc: string): Promise<"ok" | "fail"> {
  if (isWaitingForDesktopWsUrl()) {
    return Promise.resolve("fail");
  }
  const cached = siteFaviconStatusCache.get(faviconSrc);
  if (cached) return Promise.resolve(cached);

  const pending = inFlightFaviconProbes.get(faviconSrc);
  if (pending) return pending;

  const promise = (async (): Promise<"ok" | "fail"> => {
    if (await loadImage(faviconSrc)) {
      siteFaviconRenderSrcCache.set(faviconSrc, faviconSrc);
      return "ok";
    }
    // On Linux WebKitGTK (tauri://localhost), cross-scheme <img> loads to http://127.0.0.1
    // can fail mixed-content checks even when CORS fetch succeeds; fall back to a blob URL.
    if (shouldTryBlobFetchFallback(faviconSrc)) {
      const blobUrl = await tryFetchBlobFavicon(faviconSrc);
      if (blobUrl) {
        siteFaviconRenderSrcCache.set(faviconSrc, blobUrl);
        return "ok";
      }
    }
    return "fail";
  })().then((status) => {
    siteFaviconStatusCache.set(faviconSrc, status);
    inFlightFaviconProbes.delete(faviconSrc);
    return status;
  });

  inFlightFaviconProbes.set(faviconSrc, promise);
  return promise;
}

/** Extracts the hostname from a full URL, or null when it cannot be parsed. */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Builds the server favicon-proxy URL for a site. The `domain` parameter is the
 * hostname (not the full URL) so the browser HTTP cache and the server cache both
 * collapse every link on a site onto a single entry.
 */
export function resolveSiteFaviconUrl(
  urlOrHost: string,
  options?: { readonly fallback?: "none" },
): string {
  const host = extractHostname(urlOrHost) ?? urlOrHost;
  const params = new URLSearchParams({ domain: host });
  if (options?.fallback === "none") {
    params.set("fallback", "none");
  }
  // Route through the WS-derived HTTP helper so desktop/file-origin image tags
  // carry the same legacy token as attachments and local markdown images.
  return resolveWsHttpUrl(`/api/site-favicon?${params.toString()}`);
}
