// FILE: runScanner.ts
// Purpose: Runs one scanner against a project folder: finds its binary, starts it read-only inside
//          the OS sandbox when the platform has one, and turns its report into findings.
//          Where there is no OS sandbox (Windows, or a host without bwrap or sandbox-exec) it
//          still runs, with only the application's own limits, and its summary says so.
// Layer: Server cyber security scanners
// Exports: runScanner, ensureScannerBinary, sandboxReadOnlyMounts, ScannerOutcome, UNSANDBOXED_NOTE

import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CyberRepoInventory } from "@saint/contracts";

import { detectSandbox, sandboxLauncher } from "../../aegis/sandbox.ts";
import { runProcess } from "../../processRunner.ts";
import type { ParsedFinding } from "../findings.ts";
import type { LocalTarget } from "./dynamicTarget.ts";
import { scannerEnv } from "./env.ts";
import { openLoopbackBridge, openScannerEgress, type ScannerEgress } from "./egress.ts";
import { installAttention, installTool, type DownloadBytes } from "./install.ts";
import { finalizeFindings } from "./parsers.ts";
import { resolveScannerBinary, type ScannerContext, type ScannerDef } from "./registry.ts";

export interface ScannerOutcome {
  /** `unavailable`: it did not run (not installed, or needs online mode); `failed`: it ran and broke. */
  readonly status: "done" | "failed" | "unavailable";
  readonly summary: string;
  readonly findings: ParsedFinding[];
  /** What the person must do (install a package, allow the network) before it can run or be confined. */
  readonly attention?: string;
}

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const OFFLINE_TIMEOUT_MS = 3 * 60_000;
const ONLINE_TIMEOUT_MS = 10 * 60_000;
const DYNAMIC_TIMEOUT_MS = 5 * 60_000;

/**
 * Added to the summary of every run that had no OS sandbox. In that mode the project is not
 * mounted read-only and the network is not blocked: the limits that remain (the localhost-only
 * target guard, the per-scanner proxy allowlist, the minimal environment and a private scratch
 * folder) are the application's own and advisory, so the person must be told.
 */
export const UNSANDBOXED_NOTE =
  "ran without an OS sandbox: read-only project and network limits are advisory";

const unavailable = (summary: string, attention?: string): ScannerOutcome => ({
  status: "unavailable",
  summary,
  findings: [],
  ...(attention ? { attention } : {}),
});

/** On Linux the OS sandbox is bubblewrap, which a machine may lack; installing it needs admin rights. */
const NO_BWRAP_ATTENTION =
  "bubblewrap (bwrap) is not installed on this machine, so scanners run without an OS sandbox. To confine them, install it, for example `sudo apt install bubblewrap` (needs administrator rights).";
/** bwrap's own messages when the system will not let it build a sandbox (not when the scanner fails). */
const BWRAP_NAMESPACE_ERROR =
  /bwrap: (No permissions to create new namespace|Creating new namespace failed|setting up uid map|unshare|Operation not permitted)/iu;
const BWRAP_BLOCKED_ATTENTION =
  "bubblewrap could not create a sandbox on this machine (it needs unprivileged user namespaces, which an administrator may have to allow). The scanner was not run unconfined.";

/**
 * The folders a sandboxed scanner may read: the project, the nuclei templates, and the folder its
 * own executable lives in when that is under the cache or the shipped pack. Those sit inside
 * Saint's state folder (or a temp one), which the sandbox hides, so without this the scanner could
 * not even be started. Everything is mounted read-only.
 */
export function sandboxReadOnlyMounts(input: {
  readonly root: string;
  readonly binary: string;
  readonly templates?: string | undefined;
  readonly toolsDir?: string | undefined;
  readonly shippedDir?: string | undefined;
}): string[] {
  const within = (folder: string | undefined) =>
    folder
      ? !path.relative(path.resolve(folder), path.resolve(input.binary)).startsWith("..") &&
        !path.isAbsolute(path.relative(path.resolve(folder), path.resolve(input.binary)))
      : false;
  return [
    input.root,
    ...(input.templates ? [input.templates] : []),
    ...(within(input.toolsDir) || within(input.shippedDir) ? [path.dirname(input.binary)] : []),
  ];
}

/**
 * Finds a scanner's executable: shipped, fetched earlier, or on PATH; otherwise, when `download`
 * is allowed, fetches the pinned official release once into `toolsDir`. When it cannot, says why
 * and, where only the person can fix it, what to do.
 */
export async function ensureScannerBinary(
  scanner: ScannerDef,
  input: {
    readonly toolsDir?: string | undefined;
    readonly download?: boolean | undefined;
    readonly offlineReason?: string | undefined;
    /** Replaces the official download, for tests. */
    readonly downloadBytes?: DownloadBytes | undefined;
  },
): Promise<{ readonly binary: string } | { readonly outcome: ScannerOutcome }> {
  const found = resolveScannerBinary(scanner.bin, process.env, input.toolsDir);
  if (found) return { binary: found };
  if (!input.toolsDir) {
    return { outcome: unavailable(`${scanner.bin} is not installed: put it on PATH.`) };
  }
  if (!input.download) {
    return {
      outcome: unavailable(
        `${scanner.bin} is not installed. ${input.offlineReason ?? "Downloading it needs online mode."}`,
      ),
    };
  }
  const installed = await installTool(scanner.bin, {
    cacheDir: input.toolsDir,
    ...(input.downloadBytes ? { download: input.downloadBytes } : {}),
  });
  if (installed.ok) return { binary: installed.path };
  const attention =
    installed.kind === "download" || installed.kind === "write"
      ? installAttention(scanner.bin, installed, input.toolsDir)
      : undefined;
  return {
    outcome:
      installed.kind === "checksum"
        ? { status: "failed", summary: installed.message, findings: [] }
        : unavailable(`${scanner.bin} could not be installed: ${installed.message}`, attention),
  };
}

export async function runScanner(
  scanner: ScannerDef,
  input: {
    readonly root: string;
    readonly inventory: CyberRepoInventory;
    /** A folder this run may write into (its report); the project itself stays read-only. */
    readonly scratchRoot: string;
    /**
     * A folder that outlives the run, where each scanner keeps its own caches (the vulnerability
     * database) in a private subfolder used as its home. It is the one place besides the scratch
     * folder a sandboxed scanner may write, so the same cache works on every platform (Linux
     * `~/.cache`, macOS `~/Library/Caches` and Windows `%LocalAppData%` all live under it). Without
     * it a scanner's home is its scratch folder and nothing is cached.
     */
    readonly scannerHome?: string;
    /** Where scanners fetched on first use live (see `ensureScannerBinary`). */
    readonly toolsDir?: string;
    /** Whether a scanner that is not installed may be downloaded (the run allows egress). */
    readonly download?: boolean;
    /** Replaces the official download, for tests. */
    readonly downloadBytes?: DownloadBytes;
    /** Whether scanners that need the network may run (see `decideOnline`). */
    readonly online: boolean;
    /** Why they may not, shown as the scanner's summary. */
    readonly offlineReason?: string;
    /** Dynamic scanners: the localhost target (already guarded) and the templates folder. */
    readonly dynamic?: { readonly target: LocalTarget; readonly templates: string };
    readonly signal?: AbortSignal;
  },
): Promise<ScannerOutcome> {
  if (scanner.network && !input.online) {
    return unavailable(
      input.offlineReason ?? "Needs online mode to read its vulnerability database.",
    );
  }
  const ensured = await ensureScannerBinary(scanner, {
    toolsDir: input.toolsDir,
    download: input.download,
    offlineReason: input.offlineReason,
    downloadBytes: input.downloadBytes,
  });
  if ("outcome" in ensured) return ensured.outcome;
  const binary = ensured.binary;

  if (scanner.dynamic && !input.dynamic) return unavailable("No running app to scan.");
  const scratch = path.join(input.scratchRoot, scanner.id);
  await mkdir(path.join(scratch, "tmp"), { recursive: true });
  // A dynamic scanner keeps its own settings in the scratch folder, never in a shared home.
  const home =
    input.scannerHome && !scanner.dynamic ? path.join(input.scannerHome, scanner.id) : scratch;
  await mkdir(home, { recursive: true });
  const context: ScannerContext = {
    root: input.root,
    scratch,
    inventory: input.inventory,
    ...(input.dynamic ? { target: input.dynamic.target, templates: input.dynamic.templates } : {}),
  };
  const invocation = scanner.invocation(context);
  if (!invocation)
    return { status: "done", summary: "Nothing in this project for it to scan.", findings: [] };

  // With an OS sandbox the scanner reads the project and writes only into its scratch folder: the
  // project is never mounted writable and the network is cut. Without one (Windows, or no bwrap
  // or sandbox-exec) every scanner still runs, held only by the application's own limits, and
  // every summary carries UNSANDBOXED_NOTE.
  const kind = detectSandbox();
  const note = kind ? null : UNSANDBOXED_NOTE;
  // Where the OS sandbox is missing for a reason the person can fix, they are told.
  const missingSandbox = !kind && process.platform === "linux" ? NO_BWRAP_ATTENTION : undefined;
  const withAttention = (outcome: ScannerOutcome, attention = missingSandbox): ScannerOutcome =>
    attention ? { ...outcome, attention } : outcome;
  const describe = (...parts: ReadonlyArray<string | null | undefined>) =>
    [...parts, note].filter(Boolean).join("; ");
  // What links the scanner to the outside: a proxy limited to this scanner's hosts, or a bridge to
  // the one localhost port of the app under attack. Neither is told anything about the project.
  let egress: Pick<ScannerEgress, "env" | "ports" | "relay" | "refused" | "close"> | null = null;
  try {
    if (scanner.network) {
      egress = await openScannerEgress(scanner.egress, kind);
    } else if (scanner.dynamic && input.dynamic) {
      const bridge = await openLoopbackBridge(
        { host: input.dynamic.target.bridgeHost, port: input.dynamic.target.port },
        kind,
      );
      egress = { env: {}, refused: () => [], ...bridge };
    }
    const sandbox = kind
      ? sandboxLauncher({
          kind,
          home: os.homedir(),
          cwd: scratch,
          sessionDir: scratch,
          writable: home === scratch ? [] : [home],
          // Mounted read-only on top, so a project under /tmp stays visible and never writable.
          readOnly: sandboxReadOnlyMounts({
            root: input.root,
            binary,
            templates: input.dynamic?.templates,
            toolsDir: input.toolsDir,
            shippedDir: process.env.SAINT_SCANNER_DIR?.trim(),
          }),
          decoys: [],
          ports: egress?.ports ?? [],
          relay: egress?.relay ?? null,
        })
      : undefined;
    const result = await runProcess(binary, invocation.args, {
      cwd: scratch,
      // Not the server's own environment: it holds tokens a scanner has no need to see. Only the
      // proxy variables are added.
      env: scannerEnv({
        scratch,
        home,
        extra: egress?.env,
      }),
      timeoutMs: scanner.dynamic
        ? DYNAMIC_TIMEOUT_MS
        : scanner.network
          ? ONLINE_TIMEOUT_MS
          : OFFLINE_TIMEOUT_MS,
      allowNonZeroExit: true,
      outputMode: "truncate",
      maxBufferBytes: MAX_REPORT_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(sandbox ? { sandbox } : {}),
    });
    const refused = egress?.refused() ?? [];
    const refusedNote = refused.length > 0 ? `refused hosts: ${refused.join(", ")}` : null;
    const report = invocation.outputFile
      ? await readFile(invocation.outputFile, "utf8").catch(() => "")
      : result.stdout;
    if (result.timedOut) {
      return withAttention({
        status: "failed",
        summary: describe(["Timed out before it finished.", refusedNote].filter(Boolean).join(" ")),
        findings: [],
      });
    }
    if (!report.trim()) {
      // A scanner that finds nothing may write nothing, but it exits 0 (or a code the scanner
      // declares); any other exit with no report is a failure, not a clean result. trivy exits 1
      // when it cannot fetch its database, and reading that as "No findings" would hide it.
      const clean =
        result.code === 0 ||
        (result.code !== null && scanner.emptyExitCodes?.includes(result.code));
      return !clean
        ? withAttention(
            {
              status: "failed",
              summary: describe(
                result.stderr.trim().slice(-160) || `Exited with ${result.code}.`,
                refusedNote,
              ).slice(0, 300),
              findings: [],
            },
            kind === "bwrap" && BWRAP_NAMESPACE_ERROR.test(result.stderr)
              ? BWRAP_BLOCKED_ATTENTION
              : missingSandbox,
          )
        : withAttention({
            status: "done",
            summary: describe("No findings.", refusedNote),
            findings: [],
          });
    }
    const { kept, dropped } = finalizeFindings(scanner.parse(report, context));
    return withAttention({
      status: "done",
      summary: describe(
        `${kept.length} finding${kept.length === 1 ? "" : "s"}`,
        dropped > 0 ? `${dropped} lower-severity not shown` : null,
        refusedNote,
      ),
      findings: kept,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A file the system will not execute (EACCES, a noexec mount) is something only the person can fix.
    const blocked = /\b(EACCES|EPERM)\b/u.test(message)
      ? `${scanner.bin} cannot be executed here (${message.slice(0, 120)}). Its folder may be mounted noexec or restricted; ask an administrator, or put ${scanner.bin} on PATH.`
      : undefined;
    return withAttention(
      { status: "failed", summary: describe(message.slice(0, 200)), findings: [] },
      blocked ?? missingSandbox,
    );
  } finally {
    await egress?.close();
  }
}
