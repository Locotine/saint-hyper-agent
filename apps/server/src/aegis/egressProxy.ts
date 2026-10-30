// FILE: egressProxy.ts
// Purpose: Loopback HTTP/CONNECT proxy that lets agent traffic reach only allowlisted hosts.
//          Unknown hosts are refused and reported, so a person can allow or deny them.
// Layer: Server Aegis domain

import http from "node:http";
import net from "node:net";

import type { EgressVerdict } from "./policy.ts";

export interface EgressProxyOptions {
  readonly decide: (host: string) => EgressVerdict;
  /** Called once per refused unknown host while it stays unknown. */
  readonly onUnknown: (host: string) => void;
  readonly onDenied?: (host: string) => void;
}

export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

const hostOf = (authority: string) => {
  const trimmed = authority.trim();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  return trimmed.split(":")[0]!.toLowerCase();
};

export function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
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
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("Saint egress proxy: absolute URL required.\n");
      return;
    }
    if (verdictFor(target.hostname) !== "allow") {
      response.writeHead(403).end(`Saint egress: ${target.hostname} is not allowed.\n`);
      return;
    }
    const upstream = http.request(
      target,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });

  server.on("connect", (request, client, head) => {
    const authority = request.url ?? "";
    const host = hostOf(authority);
    const port = Number(authority.split(":").at(-1)) || 443;
    if (verdictFor(host) !== "allow") {
      client.end(`HTTP/1.1 403 Forbidden\r\n\r\nSaint egress: ${host} is not allowed.\r\n`);
      return;
    }
    const upstream = net.connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
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
