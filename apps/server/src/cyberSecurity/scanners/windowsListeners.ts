// FILE: windowsListeners.ts
// Purpose: Finds the localhost port a project's dev server listens on, on Windows, where the
//          local server monitor (lsof) reports nothing. `netstat` lists listening sockets with
//          their owner pid, and the dev server's own process tree says which of them are its.
// Layer: Server cyber security scanners
// Exports: parseNetstatListeners, listenersOfTree, readDevServerListeners, NetstatListener

import type { ServerLocalServerAddress } from "@saint/contracts";
import { resolveWindowsSystemExecutable } from "@saint/shared/platformEnvironment";

import { runProcess } from "../../processRunner.ts";
import {
  collectDescendantProcesses,
  type ProcessChildrenMap,
} from "../../platform/processTreeController.ts";
import { captureWindowsProcessChildrenMap } from "../../platform/windowsProcessSnapshot.ts";

export interface NetstatListener {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
}

/**
 * Listening sockets out of `netstat -ano` output. A listening socket is the row whose foreign
 * address is the unspecified address with port 0, so the English word LISTENING (translated on
 * other Windows languages) is never matched.
 */
export function parseNetstatListeners(output: string): NetstatListener[] {
  const listeners: NetstatListener[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match =
      /^\s*TCP\s+(\[[0-9a-f:.%]+\]|[0-9.]+):(\d+)\s+(?:\[::\]|0\.0\.0\.0):0\s+\S+\s+(\d+)\s*$/iu.exec(
        line,
      );
    if (!match) continue;
    const port = Number(match[2]);
    const pid = Number(match[3]);
    if (port < 1 || port > 65_535 || pid < 1) continue;
    listeners.push({ pid, host: match[1]!, port });
  }
  return listeners;
}

/** The addresses held by `rootPid` or any process below it, in the shape the target picker reads. */
export function listenersOfTree(
  rootPid: number,
  children: ProcessChildrenMap,
  listeners: ReadonlyArray<NetstatListener>,
): ServerLocalServerAddress[] {
  const pids = new Set([
    rootPid,
    ...collectDescendantProcesses(rootPid, children).map((p) => p.pid),
  ]);
  return listeners
    .filter((listener) => pids.has(listener.pid))
    .map((listener) => ({
      host: listener.host,
      port: listener.port,
      family: listener.host.startsWith("[") ? "tcp6" : "tcp4",
      url: null,
    }));
}

async function netstat(protocol: "tcp" | "tcpv6"): Promise<string> {
  const result = await runProcess(
    resolveWindowsSystemExecutable(["System32", "NETSTAT.EXE"]),
    ["-ano", "-p", protocol],
    { timeoutMs: 10_000, allowNonZeroExit: true, outputMode: "truncate" },
  ).catch(() => null);
  return result?.stdout ?? "";
}

/**
 * The listening addresses of the dev server started as `rootPid` (its terminal's shell) and of
 * everything it started. Empty when nothing listens yet, or when the process table is
 * unavailable; the caller keeps polling.
 */
export async function readDevServerListeners(rootPid: number): Promise<ServerLocalServerAddress[]> {
  const [children, v4, v6] = await Promise.all([
    captureWindowsProcessChildrenMap(),
    netstat("tcp"),
    netstat("tcpv6"),
  ]);
  if (!children) return [];
  return listenersOfTree(rootPid, children, parseNetstatListeners(`${v4}\n${v6}`));
}
