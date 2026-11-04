// FILE: wsHttpUrl.ts
// Purpose: Resolves server HTTP URLs from the active WebSocket bridge so desktop <img>/download
// requests carry the same legacy startup token already used for the WS connection.
// Layer: Web utility
// Exports: resolveWsHttpUrl, resolveHostHttpUrl, toAttachmentPreviewUrl, hostAttachmentPreviewUrl

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { REMOTE_CLIENT_ID_PARAM } from "@saint/shared/remoteClientId";

import { hostConnections } from "../hosts/hostConnectionRegistry";

// Build a fully-qualified HTTP URL for `rawPath` against the same server the WS connection uses.
// On desktop the page is served from a custom protocol scheme, so <img>/<a download> with a
// relative path never reaches the server. We mirror the WS host and forward the legacy token
// query param so authenticated GET routes (attachments, local-image, …) can authorize the
// request without touching cookies.
export function resolveWsHttpUrl(rawPath: string): string {
  if (typeof window === "undefined") return rawPath;
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  return resolveHttpUrlAgainst(wsCandidate, rawPath);
}

/**
 * Same as resolveWsHttpUrl, against the server `hostId` talks to. A remote host's URL is the
 * one its live transport uses (token included); with no live transport this throws instead of
 * falling back to this computer's server.
 */
export function resolveHostHttpUrl(hostId: HostId, rawPath: string): string {
  if (hostId === LOCAL_HOST_ID) return resolveWsHttpUrl(rawPath);
  const wsUrl = hostConnections.peek(hostId)?.explicitUrl;
  if (!wsUrl) throw new Error("This host is not connected.");
  return resolveHttpUrlAgainst(wsUrl, rawPath);
}

function resolveHttpUrlAgainst(wsCandidate: string | null, rawPath: string): string {
  if (!wsCandidate) return new URL(rawPath, window.location.origin).toString();
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    const serverUrl = new URL(`${protocol}//${wsUrl.host}`);
    const httpUrl = new URL(rawPath, serverUrl);
    const legacyToken = wsUrl.searchParams.get("token");
    const targetsServerOrigin =
      httpUrl.protocol === serverUrl.protocol && httpUrl.host === serverUrl.host;
    if (legacyToken && targetsServerOrigin && !httpUrl.searchParams.has("token")) {
      httpUrl.searchParams.set("token", legacyToken);
    }
    // A shared remote server tells desktops apart by this id (see the server's clientScope.ts).
    const clientId = wsUrl.searchParams.get(REMOTE_CLIENT_ID_PARAM);
    if (clientId && targetsServerOrigin && !httpUrl.searchParams.has(REMOTE_CLIENT_ID_PARAM)) {
      httpUrl.searchParams.set(REMOTE_CLIENT_ID_PARAM, clientId);
    }
    return httpUrl.toString();
  } catch {
    return new URL(rawPath, window.location.origin).toString();
  }
}

export function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return resolveWsHttpUrl(rawUrl);
  }
  return rawUrl;
}

/**
 * A message image's `previewUrl` is built when the message reaches its store, against this
 * computer's server. A chat on another host keeps its images on that host's server, so the image
 * is fetched from there (its token included); with no live transport the stored URL stays.
 */
export function hostAttachmentPreviewUrl(hostId: HostId, previewUrl: string): string {
  if (hostId === LOCAL_HOST_ID) return previewUrl;
  try {
    const { pathname } = new URL(previewUrl, window.location.origin);
    return pathname.startsWith("/attachments/") ? resolveHostHttpUrl(hostId, pathname) : previewUrl;
  } catch {
    return previewUrl;
  }
}
