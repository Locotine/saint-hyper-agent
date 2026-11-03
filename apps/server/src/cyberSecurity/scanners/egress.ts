// FILE: egress.ts
// Purpose: Lets a network scanner (vulnerability databases) run online without handing it the
//          internet: a loopback proxy that allows only that scanner's own hosts, bridged into the
//          sandbox's private network. The proxy never learns the project path.
// Layer: Server cyber security scanners
// Exports: decideOnline, hostAllowed, openScannerEgress, openLoopbackBridge, OnlineDecision,
//          ScannerEgress, LoopbackBridge

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { AutonomyLevel } from "@saint/contracts";

import { startEgressProxy } from "../../aegis/egressProxy.ts";
import { globMatch } from "../../aegis/policy.ts";
import { autonomyAtLeast } from "../../aegis/rules.ts";
import {
  proxyEnv,
  SANDBOX_RELAY_SCRIPT,
  type RelayedPort,
  type SandboxKind,
  type SandboxSpec,
} from "../../aegis/sandbox.ts";

export type OnlineDecision = { readonly online: true } | { readonly online: false; reason: string };

/**
 * Whether network scanners may run in this assessment. Reaching out is a decision the person
 * makes by starting the run at a level that allows egress. It does not depend on the platform:
 * where there is no OS sandbox the scanner still goes only through the per-scanner proxy
 * allowlist, which then is advisory (nothing blocks a direct connection), and its summary says so.
 */
export function decideOnline(input: {
  readonly autonomy: AutonomyLevel | null;
  readonly startedBy: string;
  /**
   * Whether this host has an OS sandbox. Aegis locks L2 on a host without one, so the person can
   * never reach it there; requiring it would switch these features off for good on Windows and on
   * a Linux host without bubblewrap. There the person starting the run is the decision.
   */
  readonly sandboxAvailable?: boolean;
}): OnlineDecision {
  if (input.startedBy !== "user") {
    return { online: false, reason: "Online scanning needs a person to start the run." };
  }
  if (input.sandboxAvailable === false) return { online: true };
  if (input.autonomy === null) {
    return { online: false, reason: "Online scanning is off: the autonomy level is unknown." };
  }
  if (!autonomyAtLeast(input.autonomy, "L2")) {
    return {
      online: false,
      reason: `Online scanning needs autonomy L2 or higher; it is ${input.autonomy}.`,
    };
  }
  return { online: true };
}

/** Exact host names and `*.` patterns only; the proxy refuses everything else, IPs included. */
export const hostAllowed = (allowed: ReadonlyArray<string>, host: string) =>
  allowed.some((pattern) => globMatch(pattern, host.toLowerCase()));

export interface ScannerEgress {
  /** Only the proxy variables: nothing else from the server's environment. */
  readonly env: Record<string, string>;
  readonly ports: ReadonlyArray<RelayedPort>;
  readonly relay: SandboxSpec["relay"];
  /** Hosts the scanner asked for and was refused. */
  readonly refused: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

export interface LoopbackBridge {
  readonly ports: ReadonlyArray<RelayedPort>;
  readonly relay: SandboxSpec["relay"];
  readonly close: () => Promise<void>;
}

/**
 * Makes one host loopback port reachable inside the sandbox, and nothing else. Under bwrap the
 * sandbox has no network at all, so the port is bridged through a Unix socket (a short folder
 * under the temp dir keeps the path within the socket-length limit); sandbox-exec reaches the
 * loopback port directly.
 */
export async function openLoopbackBridge(
  target: { readonly host: string; readonly port: number },
  kind: SandboxKind,
): Promise<LoopbackBridge> {
  if (kind !== "bwrap") {
    return {
      ports: [{ port: target.port, socketPath: "", direction: "out" }],
      relay: null,
      close: async () => {},
    };
  }
  const sockets = new Set<net.Socket>();
  let server: net.Server | null = null;
  const dir = await mkdtemp(path.join(os.tmpdir(), "saint-cs-"));
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const socketPath = path.join(dir, `o${target.port}.sock`);
    const relayScript = path.join(dir, "relay.mjs");
    await writeFile(relayScript, SANDBOX_RELAY_SCRIPT);
    server = net.createServer((client) => {
      const upstream = net.connect(target.port, target.host);
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    const listening = server;
    await new Promise<void>((resolve, reject) =>
      listening.once("error", reject).listen(socketPath, resolve),
    );
    return {
      ports: [{ port: target.port, socketPath, direction: "out" }],
      relay: { command: process.execPath, args: [relayScript] },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** A proxy for one scanner run, reached through a loopback bridge into the sandbox. */
export async function openScannerEgress(
  allowed: ReadonlyArray<string>,
  kind: SandboxKind,
): Promise<ScannerEgress> {
  const refused = new Set<string>();
  const proxy = await startEgressProxy({
    decide: (host) => (hostAllowed(allowed, host) ? "allow" : "deny"),
    onUnknown: () => {},
    onDenied: (host) => refused.add(host),
  });
  try {
    const bridge = await openLoopbackBridge({ host: "127.0.0.1", port: proxy.port }, kind);
    return {
      env: proxyEnv(proxy.url),
      ports: bridge.ports,
      relay: bridge.relay,
      refused: () => [...refused],
      close: async () => {
        await bridge.close();
        await proxy.close();
      },
    };
  } catch (error) {
    await proxy.close();
    throw error;
  }
}
