// FILE: dynamicTarget.ts
// Purpose: The rules that keep a dynamic scan on the person's own machine: which URLs count as
//          local, which listening address of the started dev server becomes the target, and
//          whether this run may attack at all. Pure, so every refusal is unit-tested.
// Layer: Server cyber security scanners
// Exports: parseLocalTarget, pickLocalTarget, decideDynamic, pickDevScript, LocalTarget,
//          DynamicDecision

import type {
  AutonomyLevel,
  ProjectDiscoveredScriptTarget,
  ServerLocalServerProcess,
} from "@saint/contracts";

import { autonomyAtLeast } from "../../aegis/rules.ts";

export interface LocalTarget {
  /** What the sandboxed scanner is given: always the numeric loopback address, never a name. */
  readonly url: string;
  readonly port: number;
  /** Where the host side connects: the loopback family the server is listening on. */
  readonly bridgeHost: "127.0.0.1" | "::1";
}

export type LocalTargetResult =
  | { readonly ok: true; readonly target: LocalTarget }
  | { readonly ok: false; readonly reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Accepts only `http://localhost`, `http://127.0.0.1` and `http://[::1]` (any port) once the URL
 * is parsed. Credentials, other schemes, trailing-dot names, other loopback addresses and every
 * DNS name are refused, so a lookalike host can never be scanned.
 */
export function parseLocalTarget(raw: string): LocalTargetResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }
  if (url.protocol !== "http:") {
    return { ok: false, reason: "Only http:// targets can be scanned." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "The target must not carry credentials." };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: `Only localhost can be scanned, not ${url.hostname}.` };
  }
  const port = Number(url.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: "The target port is not valid." };
  }
  const v6 = url.hostname === "[::1]";
  return {
    ok: true,
    target: { url: `http://127.0.0.1:${port}`, port, bridgeHost: v6 ? "::1" : "127.0.0.1" },
  };
}

/**
 * The listening address of the dev server to attack: the first one that is loopback or a
 * wildcard (reachable on loopback). A server bound only to a LAN address is never a target.
 */
export function pickLocalTarget(
  server: Pick<ServerLocalServerProcess, "addresses">,
): LocalTargetResult {
  for (const address of server.addresses) {
    const host = address.host.toLowerCase();
    const loopback =
      host === "::1" || host === "[::1]"
        ? "[::1]"
        : host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0" || host === "*"
          ? "127.0.0.1"
          : host === "::" || host === "[::]"
            ? "127.0.0.1"
            : null;
    if (!loopback) continue;
    return parseLocalTarget(`http://${loopback}:${address.port}`);
  }
  return { ok: false, reason: "The dev server is not listening on a localhost address." };
}

export type DynamicDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Whether this run may attack the running app. It is an active attack, so it needs the person's
 * confirmation for this very run and an autonomy level that allows outbound activity; nothing
 * else can switch it on. The platform does not matter: without an OS sandbox the scanner is held
 * to the single guarded localhost target by its arguments alone (advisory, nothing blocks it from
 * connecting elsewhere), and its summary says so.
 */
export function decideDynamic(input: {
  readonly confirmed: boolean;
  readonly autonomy: AutonomyLevel | null;
  readonly startedBy: string;
  /** See `decideOnline`: L2 cannot be reached on a host without an OS sandbox. */
  readonly sandboxAvailable?: boolean;
}): DynamicDecision {
  if (!input.confirmed) {
    return {
      allowed: false,
      reason: "Not requested for this run: confirm it in the Cyber Security view to scan the app.",
    };
  }
  if (input.startedBy !== "user") {
    return { allowed: false, reason: "A dynamic scan needs a person to start the run." };
  }
  if (input.sandboxAvailable === false) return { allowed: true };
  if (input.autonomy === null) {
    return { allowed: false, reason: "Dynamic scanning is off: the autonomy level is unknown." };
  }
  if (!autonomyAtLeast(input.autonomy, "L2")) {
    return {
      allowed: false,
      reason: `Dynamic scanning needs autonomy L2 or higher; it is ${input.autonomy}.`,
    };
  }
  return { allowed: true };
}

export type DevScriptResult =
  | { readonly ok: true; readonly command: string; readonly cwd: string; readonly label: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The command that starts the app: looked up in the project's own package scripts by the folder
 * and script name the person confirmed, never taken from the request as text.
 */
export function pickDevScript(
  targets: ReadonlyArray<ProjectDiscoveredScriptTarget>,
  request: { readonly packagePath: string; readonly script: string },
): DevScriptResult {
  const packagePath = request.packagePath.replace(/^\/+|\/+$/g, "");
  const target = targets.find(
    (entry) => entry.relativePath.replace(/^\/+|\/+$/g, "") === packagePath,
  );
  const script = target?.scripts.find((entry) => entry.name === request.script);
  if (!target || !script) {
    return {
      ok: false,
      reason: `The script "${request.script}" is not in this project's package scripts.`,
    };
  }
  return {
    ok: true,
    command: script.command,
    cwd: target.cwd,
    label: `${packagePath ? `${packagePath}: ` : ""}${script.name}`,
  };
}
