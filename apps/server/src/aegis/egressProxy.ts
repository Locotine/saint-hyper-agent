// FILE: egressProxy.ts
// Purpose: Loopback HTTP/CONNECT proxy that lets agent traffic reach only allowlisted hosts.
//          Unknown hosts are refused and reported, so a person can allow or deny them.
// Layer: Server Aegis domain

import * as Dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

import { invokePinnedDnsLookup } from "@saint/shared/outboundHttp";
import {
  assertExactLoopbackIpAddress,
  assertPublicIpAddress,
  OutboundPolicyError,
} from "@saint/shared/outboundHttpPolicy";

import type { EgressVerdict } from "./policy.ts";

export interface EgressProxyOptions {
  readonly decide: (host: string) => EgressVerdict;
  /** Called once per refused unknown host while it stays unknown. */
  readonly onUnknown: (host: string) => void;
  readonly onDenied?: (host: string) => void;
  /**
   * Opt-in for tests or explicitly configured loopback proxies. Disabled by default so a
   * sandboxed process cannot tunnel through the host proxy to loopback/private host services.
   */
  readonly allowLoopbackTargets?: boolean;
}

export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

type ResolvedTarget =
  | { readonly kind: "ok"; readonly addresses: ReadonlyArray<PinnedAddress> }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "dns-error" };

const normalizeHost = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    return trimmed.endsWith("]") ? trimmed.slice(1, -1) : "";
  }
  return trimmed;
};

const parseAuthority = (
  authority: string,
): { readonly host: string; readonly port: number } | null => {
  const trimmed = authority.trim();
  if (!trimmed) return null;
  let host: string;
  let portText = "";
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close <= 1) return null;
    host = trimmed.slice(1, close).toLowerCase();
    const rest = trimmed.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = trimmed.indexOf(":");
    if (colon >= 0) {
      if (trimmed.indexOf(":", colon + 1) >= 0) return null;
      host = trimmed.slice(0, colon).toLowerCase();
      portText = trimmed.slice(colon + 1);
    } else {
      host = trimmed.toLowerCase();
    }
  }
  if (!host || /\s/u.test(host)) return null;
  const port = portText === "" ? 443 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
};

const isExplicitLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

async function resolvePinnedTarget(
  host: string,
  allowLoopbackTargets: boolean,
): Promise<ResolvedTarget> {
  const allowLoopbackForHost = allowLoopbackTargets && isExplicitLoopbackHost(host);
  const validateAddress = (address: string) => {
    if (allowLoopbackForHost) {
      assertExactLoopbackIpAddress(address);
    } else {
      assertPublicIpAddress(address);
    }
  };
  const literalFamily = net.isIP(host);
  if (literalFamily === 4 || literalFamily === 6) {
    try {
      validateAddress(host);
    } catch (error) {
      return {
        kind: "blocked",
        reason:
          error instanceof OutboundPolicyError ? error.message : "Destination is not allowed.",
      };
    }
    return { kind: "ok", addresses: [{ address: host, family: literalFamily }] };
  }
  let addresses: ReadonlyArray<PinnedAddress>;
  try {
    addresses = (await Dns.lookup(host, {
      all: true,
      verbatim: true,
    })) as ReadonlyArray<PinnedAddress>;
  } catch {
    return { kind: "dns-error" };
  }
  if (addresses.length === 0) return { kind: "dns-error" };
  try {
    for (const entry of addresses) validateAddress(entry.address);
  } catch (error) {
    return {
      kind: "blocked",
      reason: error instanceof OutboundPolicyError ? error.message : "Destination is not allowed.",
    };
  }
  return { kind: "ok", addresses };
}

function sanitizeForwardedHttpHeaders(
  incoming: http.IncomingHttpHeaders,
  canonicalHost: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "proxy-connection" ||
      lower === "proxy-authorization" ||
      value === undefined
    ) {
      continue;
    }
    headers[lower] = value;
  }
  headers.host = canonicalHost;
  return headers;
}

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowLoopbackTargets = options.allowLoopbackTargets === true;
  const reported = new Set<string>();
  const verdictFor = (host: string) => {
    const verdict = options.decide(host);
    if (verdict === "unknown" && !reported.has(host)) {
      reported.add(host);
      options.onUnknown(host);
    }
    if (verdict === "deny") options.onDenied?.(host);
    if (verdict !== "unknown") reported.delete(host);
    return verdict;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400).end("Saint egress proxy: absolute URL required.\n");
        return;
      }
      if (target.protocol !== "http:") {
        response.writeHead(400).end("Saint egress proxy: only HTTP absolute URLs are supported.\n");
        return;
      }
      const host = normalizeHost(target.hostname);
      if (!host) {
        response.writeHead(400).end("Saint egress proxy: invalid target host.\n");
        return;
      }
      if (verdictFor(host) !== "allow") {
        response.writeHead(403).end(`Saint egress: ${host} is not allowed.\n`);
        return;
      }
      const resolved = await resolvePinnedTarget(host, allowLoopbackTargets);
      if (resolved.kind === "blocked") {
        options.onDenied?.(host);
        response.writeHead(403).end(`Saint egress: ${host} resolved to a blocked address.\n`);
        return;
      }
      if (resolved.kind === "dns-error") {
        response.writeHead(502).end(`Saint egress: could not resolve ${host}.\n`);
        return;
      }
      const upstream = http.request(
        target,
        {
          method: request.method,
          headers: sanitizeForwardedHttpHeaders(request.headers, target.host),
          lookup: (_hostname, lookupOptions, callback) => {
            invokePinnedDnsLookup(resolved.addresses, lookupOptions, callback);
          },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    })();
  });

  server.on("connect", (request, client, head) => {
    void (async () => {
      const parsed = parseAuthority(request.url ?? "");
      if (!parsed) {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\nSaint egress: invalid CONNECT authority.\r\n");
        return;
      }
      if (verdictFor(parsed.host) !== "allow") {
        client.end(
          `HTTP/1.1 403 Forbidden\r\n\r\nSaint egress: ${parsed.host} is not allowed.\r\n`,
        );
        return;
      }
      const resolved = await resolvePinnedTarget(parsed.host, allowLoopbackTargets);
      if (resolved.kind === "blocked") {
        options.onDenied?.(parsed.host);
        client.end(
          `HTTP/1.1 403 Forbidden\r\n\r\nSaint egress: ${parsed.host} resolved to a blocked address.\r\n`,
        );
        return;
      }
      if (resolved.kind === "dns-error") {
        client.destroy();
        return;
      }
      const primary = resolved.addresses[0]!;
      const upstream = net.connect(
        { host: primary.address, port: parsed.port, family: primary.family },
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        },
      );
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    })();
  });

  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            // CONNECT tunnels are raw sockets that closeAllConnections does not reach; without
            // destroying them server.close would wait forever (and hang shutdown).
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
