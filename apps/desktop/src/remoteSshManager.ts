// FILE: remoteSshManager.ts
// Purpose: Connects the desktop to a Synara server on a remote host over SSH: installs the
//          matching server version there, starts it in tmux, and forwards a local loopback
//          port to it so a desktop window can use it as its backend.
// Layer: Desktop remote SSH orchestration (Electron main)
// Exports: RemoteSshManager, RemoteSshManagerDependencies

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import type {
  DesktopRemoteSshHostState,
  DesktopRemoteSshPhase,
  DesktopRemoteSshSavedHost,
} from "@synara/contracts";
import type { RuntimeSpawnOptions } from "@synara/shared/processRuntime";

import { isValidSshTarget, normalizeRemoteRoot } from "./remoteSshConfig";
import {
  buildRemoteInstallScript,
  buildRemoteProbeScript,
  buildRemoteStartScript,
  buildRemoteStopScript,
  buildRemoteUploadCommand,
  hasRemoteReport,
  nodeMajorVersion,
  parseRemoteProbeReport,
  parseRemoteStartReport,
  REMOTE_SSH_LOGIN_SHELL_COMMAND,
  REMOTE_SSH_MIN_NODE_MAJOR,
  type RemoteSshScriptTarget,
} from "./remoteSshScripts";

export interface RemoteSshManagerDependencies {
  /** `spawnProcess` from the shared process runtime. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: RuntimeSpawnOptions,
  ) => ChildProcess;
  readonly appVersion: string;
  readonly defaultRemoteRoot: string;
  /** Gzipped tar of the install bundle; called only when the remote lacks this version. */
  readonly createInstallBundle: () => Readable;
  readonly reserveLocalPort: () => Promise<number>;
  readonly waitForHttpReady: (baseUrl: string, signal: AbortSignal) => Promise<void>;
  readonly createToken: () => string;
  readonly devUrl?: string | undefined;
  readonly log: (message: string) => void;
  readonly onStateChange: (state: DesktopRemoteSshHostState) => void;
}

/** Non-interactive ssh: never prompt for a password or host key inside the app. */
const SSH_BASE_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

const PROBE_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const START_TIMEOUT_MS = 2 * 60_000;
const STOP_TIMEOUT_MS = 60_000;
const TUNNEL_READY_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 2_000;

interface SshRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface HostRecord {
  state: DesktopRemoteSshHostState;
  remoteRoot: string;
  tunnel: ChildProcess | null;
  token: string | null;
  /** Kept across reconnects so open windows reconnect to the same URL. */
  localPort: number | null;
  connecting: Promise<DesktopRemoteSshHostState> | null;
  abort: AbortController | null;
}

export class RemoteSshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteSshError";
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

export class RemoteSshManager {
  private readonly hosts = new Map<string, HostRecord>();

  constructor(private readonly deps: RemoteSshManagerDependencies) {}

  states(): DesktopRemoteSshHostState[] {
    return [...this.hosts.values()].map((record) => record.state);
  }

  /**
   * The backend WebSocket URL for a host, carrying the loopback legacy token.
   * It stays the same while the tunnel is down, so a remote window keeps
   * retrying its own host (never the local backend) and resumes on reconnect.
   */
  wsUrl(host: string): string | null {
    const record = this.hosts.get(host);
    if (!record?.token || !record.localPort) return null;
    return `ws://127.0.0.1:${record.localPort}/?token=${encodeURIComponent(record.token)}`;
  }

  connect(input: DesktopRemoteSshSavedHost): Promise<DesktopRemoteSshHostState> {
    const host = input.host.trim();
    if (!isValidSshTarget(host)) {
      return Promise.reject(new RemoteSshError(`'${input.host}' is not a valid SSH host.`));
    }
    const remoteRoot = normalizeRemoteRoot(input.remoteRoot ?? this.deps.defaultRemoteRoot);
    if (!remoteRoot) {
      return Promise.reject(
        new RemoteSshError("The remote folder must be a relative path inside the home folder."),
      );
    }
    const record = this.record(host, remoteRoot);
    if (record.connecting) return record.connecting;
    if (record.state.phase === "connected" && record.remoteRoot === remoteRoot) {
      return Promise.resolve(record.state);
    }
    record.remoteRoot = remoteRoot;
    const abort = new AbortController();
    record.abort = abort;
    record.connecting = this.runConnect(record, abort.signal).finally(() => {
      record.connecting = null;
      if (record.abort === abort) record.abort = null;
    });
    return record.connecting;
  }

  /** Closes the tunnel. The remote server keeps running so agents continue. */
  disconnect(host: string): void {
    const record = this.hosts.get(host);
    if (!record) return;
    record.abort?.abort();
    this.closeTunnel(record);
    this.update(record, "idle", null);
  }

  /** Closes the tunnel and stops the remote server; installed files and data stay. */
  async stopServer(input: DesktopRemoteSshSavedHost): Promise<void> {
    const host = input.host.trim();
    const remoteRoot = normalizeRemoteRoot(input.remoteRoot ?? this.deps.defaultRemoteRoot);
    if (!isValidSshTarget(host) || !remoteRoot) {
      throw new RemoteSshError(`'${input.host}' is not a valid SSH host and folder.`);
    }
    const record = this.record(host, remoteRoot);
    this.disconnect(host);
    record.remoteRoot = remoteRoot;
    this.update(record, "stopping", null);
    try {
      const result = await this.runScript(
        host,
        buildRemoteStopScript(this.target(record)),
        STOP_TIMEOUT_MS,
      );
      if (!hasRemoteReport(result.stdout, "stopped")) {
        throw new RemoteSshError(this.failureMessage("stop the remote server", result));
      }
      this.update(record, "idle", null);
    } catch (error) {
      this.update(record, "error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Closes every tunnel; remote servers keep running. */
  dispose(): void {
    for (const record of this.hosts.values()) {
      record.abort?.abort();
      this.closeTunnel(record);
    }
  }

  private record(host: string, remoteRoot: string): HostRecord {
    let record = this.hosts.get(host);
    if (!record) {
      record = {
        state: {
          host,
          remoteRoot,
          phase: "idle",
          message: null,
          localPort: null,
        },
        remoteRoot,
        tunnel: null,
        token: null,
        localPort: null,
        connecting: null,
        abort: null,
      };
      this.hosts.set(host, record);
    }
    return record;
  }

  private target(record: HostRecord): RemoteSshScriptTarget {
    return { remoteRoot: record.remoteRoot, version: this.deps.appVersion };
  }

  private update(record: HostRecord, phase: DesktopRemoteSshPhase, message: string | null): void {
    record.state = {
      host: record.state.host,
      remoteRoot: record.remoteRoot,
      phase,
      message,
      localPort: phase === "connected" ? record.localPort : null,
    };
    this.deps.onStateChange(record.state);
  }

  private async runConnect(
    record: HostRecord,
    signal: AbortSignal,
  ): Promise<DesktopRemoteSshHostState> {
    const host = record.state.host;
    const target = this.target(record);
    const step = (phase: DesktopRemoteSshPhase, message: string | null = null) => {
      if (signal.aborted) throw new RemoteSshError("Connection cancelled.");
      this.update(record, phase, message);
    };
    try {
      this.closeTunnel(record);
      step("checking");
      const probeResult = await this.runScript(
        host,
        buildRemoteProbeScript(target),
        PROBE_TIMEOUT_MS,
      );
      const probe = parseRemoteProbeReport(probeResult.stdout);
      if (!probe) throw new RemoteSshError(this.failureMessage("reach the host", probeResult));
      const nodeMajor = nodeMajorVersion(probe.nodeVersion);
      if (nodeMajor === null || nodeMajor < REMOTE_SSH_MIN_NODE_MAJOR) {
        throw new RemoteSshError(
          `Node.js ${REMOTE_SSH_MIN_NODE_MAJOR} or newer is required on ${host}` +
            (probe.nodeVersion ? ` (found ${probe.nodeVersion}).` : " (node was not found)."),
        );
      }

      let port: number;
      let token: string;
      if (probe.server && probe.server.version === this.deps.appVersion) {
        this.deps.log(`[remote-ssh] reusing server on ${host} port=${probe.server.port}`);
        port = probe.server.port;
        token = probe.server.token;
      } else {
        if (!probe.installed) {
          if (!probe.npm) throw new RemoteSshError(`npm is required on ${host} to install Synara.`);
          step("uploading");
          const upload = await this.runSsh(
            host,
            buildRemoteUploadCommand(target),
            this.deps.createInstallBundle(),
            UPLOAD_TIMEOUT_MS,
          );
          if (upload.code !== 0) {
            throw new RemoteSshError(this.failureMessage("upload the server", upload));
          }
          step("installing");
          const install = await this.runScript(
            host,
            buildRemoteInstallScript(target),
            INSTALL_TIMEOUT_MS,
          );
          if (!hasRemoteReport(install.stdout, "installed")) {
            throw new RemoteSshError(this.failureMessage("install the server", install));
          }
        }
        step("starting");
        token = this.deps.createToken();
        const start = await this.runScript(
          host,
          buildRemoteStartScript(target, { token, devUrl: this.deps.devUrl }),
          START_TIMEOUT_MS,
        );
        const started = parseRemoteStartReport(start.stdout);
        if (!started) throw new RemoteSshError(this.failureMessage("start the server", start));
        port = started.port;
      }

      step("tunneling");
      record.localPort ??= await this.deps.reserveLocalPort();
      record.token = token;
      await this.openTunnel(record, port, signal);
      step("connected");
      return record.state;
    } catch (error) {
      this.closeTunnel(record);
      const message = error instanceof Error ? error.message : String(error);
      if (!signal.aborted) this.update(record, "error", message);
      throw error instanceof RemoteSshError ? error : new RemoteSshError(message);
    }
  }

  private async openTunnel(record: HostRecord, remotePort: number, signal: AbortSignal) {
    const host = record.state.host;
    const localPort = record.localPort;
    if (!localPort) throw new RemoteSshError("No local port was reserved for the tunnel.");
    const tunnel = this.deps.spawn(
      "ssh",
      [
        ...SSH_BASE_OPTIONS,
        "-o",
        "ExitOnForwardFailure=yes",
        "-N",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        "--",
        host,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    record.tunnel = tunnel;
    let stderr = "";
    tunnel.stderr?.setEncoding("utf8");
    tunnel.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    const ready = new AbortController();
    const onAbort = () => ready.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const exited = new Promise<never>((_, reject) => {
      tunnel.once("exit", (code) => {
        ready.abort();
        if (record.tunnel === tunnel) {
          record.tunnel = null;
          if (record.state.phase === "connected") {
            this.update(
              record,
              "error",
              `SSH tunnel to ${host} closed${stderr ? `: ${tail(stderr)}` : "."}`,
            );
          }
        }
        reject(
          new RemoteSshError(
            `SSH tunnel to ${host} exited (code ${code ?? "signal"})${stderr ? `: ${tail(stderr)}` : "."}`,
          ),
        );
      });
      tunnel.once("error", (error) => reject(new RemoteSshError(error.message)));
    });
    // The tunnel can exit long after it became ready; that later rejection has no awaiter.
    exited.catch(() => undefined);
    const timeout = setTimeout(() => ready.abort(), TUNNEL_READY_TIMEOUT_MS);
    try {
      await Promise.race([
        this.deps.waitForHttpReady(`http://127.0.0.1:${localPort}`, ready.signal).catch(() => {
          throw new RemoteSshError(
            signal.aborted
              ? "Connection cancelled."
              : `The SSH tunnel to ${host} did not reach the remote server.`,
          );
        }),
        exited,
      ]);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private closeTunnel(record: HostRecord): void {
    const tunnel = record.tunnel;
    record.tunnel = null;
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) tunnel.kill();
  }

  private failureMessage(action: string, result: SshRunResult): string {
    const detail = tail(result.stderr) || tail(result.stdout);
    return `Could not ${action} (ssh exit ${result.code ?? "signal"})${detail ? `: ${detail}` : "."}`;
  }

  private runScript(host: string, script: string, timeoutMs: number): Promise<SshRunResult> {
    return this.runSsh(host, REMOTE_SSH_LOGIN_SHELL_COMMAND, script, timeoutMs);
  }

  private runSsh(
    host: string,
    remoteCommand: string,
    stdin: string | Readable,
    timeoutMs: number,
  ): Promise<SshRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.deps.spawn("ssh", [...SSH_BASE_OPTIONS, "--", host, remoteCommand], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS * 4);
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new RemoteSshError(`ssh to ${host} timed out.`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(
          new RemoteSshError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "The ssh command was not found on this computer."
              : error.message,
          ),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      // A remote that exits early closes stdin; the result above reports why.
      child.stdin?.on("error", () => undefined);
      if (typeof stdin === "string") {
        child.stdin?.end(stdin);
      } else if (child.stdin) {
        stdin.on("error", (error) => child.stdin?.destroy(error));
        stdin.pipe(child.stdin);
      }
    });
  }
}
