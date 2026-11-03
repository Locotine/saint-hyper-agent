// FILE: dynamicRun.ts
// Purpose: The two I/O helpers a dynamic scan needs besides the scanner itself: where its
//          templates live (shipped, never downloaded) and when the app it attacks answers HTTP.
// Layer: Server cyber security scanners
// Exports: resolveNucleiTemplates, waitForHttp, findDevServerListener

import { stat } from "node:fs/promises";
import path from "node:path";

import type {
  ProjectDevServer,
  ServerLocalServerAddress,
  ServerLocalServerProcess,
} from "@saint/contracts";

import { findProjectDevServerForLocalServer } from "../../devServerManager.ts";
import { listLocalServers } from "../../localServerMonitor.ts";
import { installedTemplatesDir } from "./install.ts";
import { readDevServerListeners } from "./windowsListeners.ts";

/**
 * The folder of nuclei templates: the one fetched on first use (`toolsDir`), or shipped beside the
 * scanner (`<SAINT_SCANNER_DIR>/nuclei-templates`, or `SAINT_NUCLEI_TEMPLATES`). Null when absent;
 * nuclei itself never downloads templates.
 */
export async function resolveNucleiTemplates(
  env: NodeJS.ProcessEnv = process.env,
  toolsDir?: string,
): Promise<string | null> {
  const candidates = [
    toolsDir ? installedTemplatesDir(toolsDir) : "",
    env.SAINT_NUCLEI_TEMPLATES?.trim(),
    env.SAINT_SCANNER_DIR?.trim()
      ? path.join(env.SAINT_SCANNER_DIR.trim(), "nuclei-templates")
      : "",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  return null;
}

/** Polls until the URL answers with any HTTP response (a 404 still means the app is up). */
export async function waitForHttp(
  url: string,
  options: { readonly timeoutMs: number; readonly intervalMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
}

/**
 * The listening addresses of a project's dev server. Where `lsof` exists the local server monitor
 * attributes a listener to the dev server (by its process tree and folder); on Windows it reports
 * nothing, so the listeners come from `netstat` and the dev server's own process tree.
 */
export async function findDevServerListener(input: {
  readonly devServer: ProjectDevServer;
  readonly tracked: readonly ProjectDevServer[];
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests. */
  readonly readWindows?: (pid: number) => Promise<ServerLocalServerAddress[]>;
  readonly readLocalServers?: () => Promise<{ servers: readonly ServerLocalServerProcess[] }>;
}): Promise<Pick<ServerLocalServerProcess, "addresses"> | null> {
  if ((input.platform ?? process.platform) === "win32") {
    if (!input.devServer.pid) return null;
    const addresses = await (input.readWindows ?? readDevServerListeners)(input.devServer.pid);
    return addresses.length > 0 ? { addresses } : null;
  }
  const { servers } = await (input.readLocalServers ?? listLocalServers)();
  return (
    servers.find(
      (candidate) =>
        findProjectDevServerForLocalServer({
          localServer: candidate,
          devServers: input.tracked,
        }) !== null,
    ) ?? null
  );
}
