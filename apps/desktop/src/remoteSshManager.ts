// FILE: remoteSshManager.ts
// Purpose: Connects the desktop to a Saint server on a remote host over SSH: installs the
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
} from "@saint/contracts";
import type { RuntimeSpawnOptions } from "@saint/shared/processRuntime";

import { isValidSshTarget, normalizeRemoteRoot } from "./remoteSshConfig";
import {
  buildRemoteInstallScript,
  buildRemoteProbeScript,
  buildRemoteStartScript,
  buildRemoteStopScript,
  buildRemoteUploadCommand,
  hasRemoteReport,
  isRemoteNodeVersionSupported,
  parseRemoteProbeReport,
  parseRemoteStartReport,
  REMOTE_SSH_LOGIN_SHELL_COMMAND,
  REMOTE_SSH_NODE_REQUIREMENT,
  type RemoteSshScriptTarget,
} from "./remoteSshScripts";

export interface RemoteSshManagerDependencies {
  /** `spawnProcess` from the shared process runtime. */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: RuntimeSpawnOptions,
  ) => ChildProcess;
  /**
   * Install folder name of this build's server (see `remoteInstallVersion`) and
   * the hash of its dependency pack (see `remoteInstallDepsHash`); called once.
   */
  readonly installIdentity: () => RemoteInstallIdentity;
  /** Install folder of hosts with none of their own; this client's folder (see `clientRemoteRoot`). */
  readonly defaultRemoteRoot: string;
  /** Folder whose `versions/` every install folder on a host shares. */
  readonly storeRoot: string;
  /**
   * Gzipped tar of the install bundle; called only when the remote lacks this
   * version. With `withDepsPack` it also carries the dependency pack, which the
   * host unpacks instead of installing anything.
   */
  readonly createInstallBundle: (withDepsPack: boolean) => Readable;
  /** Whether this build ships the dependency pack (`apps/server/remote-deps`). */
  readonly hasDepsPack: () => boolean;
  readonly reserveLocalPort: () => Promise<number>;
  readonly waitForHttpReady: (baseUrl: string, signal: AbortSignal) => Promise<void>;
  readonly createToken: () => string;
  readonly devUrl?: string | undefined;
  readonly log: (message: string) => void;
  readonly onStateChange: (state: DesktopRemoteSshHostState) => void;
  /**
   * Folder for SSH connection-sharing sockets, or null to give every ssh run its
   * own connection (Windows OpenSSH has no ControlMaster).
   */
  readonly sshControlDir?: string | null;
  /** Waits `ms`, rejecting when `signal` aborts; replaceable so tests skip the backoff. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Waits between tries to bring a dropped tunnel back; the schedule ends in an error. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RemoteSshError("Connection cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemoteSshError("Connection cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RemoteInstallIdentity {
  readonly version: string;
  readonly depsHash: string;
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

/**
 * Script runs need no port forwards, so forwards from the user's ssh config
 * (`LocalForward`, `RemoteForward`, `DynamicForward`) are not set up for them.
 */
const SSH_SCRIPT_OPTIONS = [...SSH_BASE_OPTIONS, "-o", "ClearAllForwardings=yes"];

/**
 * How long a shared connection outlives its last script run. One connect runs
 * up to four scripts (probe, upload, install, start); sharing one connection
 * saves their key exchanges and authentications on the host.
 */
const CONTROL_PERSIST_SECONDS = 120;
/** sun_path is 104 bytes on macOS; `%C` expands to 40 hex digits. */
const MAX_CONTROL_PATH_LENGTH = 100;
const CONTROL_MASTER_TIMEOUT_MS = 20_000;
/** A connected host whose server stopped (idle exit) answers no /health within this. */
const CONNECTED_HEALTH_TIMEOUT_MS = 5_000;

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
  /** Port of the remote server the tunnel forwards to; lets a dropped tunnel re-open cheaply. */
  remotePort: number | null;
  hostKey: string | null;
  /** Counts token changes; a client builds a new transport per epoch. */
  epoch: number;
  connecting: Promise<DesktopRemoteSshHostState> | null;
  abort: AbortController | null;
}

export class RemoteSshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteSshError";
  }
}

/** The tunnel's own local port was taken between reserving and binding it. */
class LocalPortInUseError extends RemoteSshError {}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

export class RemoteSshManager {
  private readonly hosts = new Map<string, HostRecord>();
  private cachedInstallIdentity: RemoteInstallIdentity | null = null;

  constructor(private readonly deps: RemoteSshManagerDependencies) {}

  private installIdentity(): RemoteInstallIdentity {
    this.cachedInstallIdentity ??= this.deps.installIdentity();
    return this.cachedInstallIdentity;
  }

  private installVersion(): string {
    return this.installIdentity().version;
  }

  /** The ControlPath pattern for shared connections, or null when sharing is off. */
  private controlPath(): string | null {
    const dir = this.deps.sshControlDir;
    if (!dir) return null;
    const path = `${dir.replace(/[\\/]+$/u, "")}/%C`;
    return path.length - 2 + 40 <= MAX_CONTROL_PATH_LENGTH ? path : null;
  }

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
    if (input.hostKey) record.hostKey = input.hostKey;
    if (record.connecting) return record.connecting;
    const abort = new AbortController();
    record.abort = abort;
    const connected = record.state.phase === "connected" && record.remoteRoot === remoteRoot;
    record.remoteRoot = remoteRoot;
    record.connecting = (async () => {
      // The tunnel outlives a server that exited after idling with no window
      // open; reconnect when it no longer answers.
      if (connected && record.localPort && (await this.answersHealth(record.localPort))) {
        return record.state;
      }
      return this.runConnect(record, abort.signal);
    })().finally(() => {
      record.connecting = null;
      if (record.abort === abort) record.abort = null;
    });
    return record.connecting;
  }

  private async answersHealth(localPort: number): Promise<boolean> {
    const timeout = AbortSignal.timeout(CONNECTED_HEALTH_TIMEOUT_MS);
    try {
      await this.deps.waitForHttpReady(`http://127.0.0.1:${localPort}`, timeout);
      return true;
    } catch {
      return false;
    }
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
          hostKey: null,
          epoch: 0,
          remoteRoot,
          phase: "idle",
          message: null,
          localPort: null,
        },
        remoteRoot,
        tunnel: null,
        token: null,
        localPort: null,
        remotePort: null,
        hostKey: null,
        epoch: 0,
        connecting: null,
        abort: null,
      };
      this.hosts.set(host, record);
    }
    return record;
  }

  private target(record: HostRecord): RemoteSshScriptTarget {
    const identity = this.installIdentity();
    return {
      remoteRoot: record.remoteRoot,
      storeRoot: this.deps.storeRoot,
      version: identity.version,
      depsHash: identity.depsHash,
    };
  }

  private update(record: HostRecord, phase: DesktopRemoteSshPhase, message: string | null): void {
    record.state = {
      host: record.state.host,
      hostKey: record.hostKey,
      epoch: record.epoch,
      remoteRoot: record.remoteRoot,
      phase,
      message,
      localPort: phase === "connected" ? record.localPort : null,
    };
    this.deps.onStateChange(record.state);
  }

  /**
   * `reconnecting` keeps that phase through the retry instead of flashing the connect
   * phases, and leaves a failure to the caller's backoff loop.
   */
  private async runConnect(
    record: HostRecord,
    signal: AbortSignal,
    reconnecting = false,
  ): Promise<DesktopRemoteSshHostState> {
    const host = record.state.host;
    const target = this.target(record);
    const startedAt = Date.now();
    const step = (phase: DesktopRemoteSshPhase, message: string | null = null) => {
      if (signal.aborted) throw new RemoteSshError("Connection cancelled.");
      this.deps.log(`[remote-ssh] ${host} ${phase} +${Date.now() - startedAt}ms`);
      if (!reconnecting || phase === "connected") this.update(record, phase, message);
    };
    try {
      this.closeTunnel(record);
      step("checking");
      await this.ensureControlMaster(host);
      const probeResult = await this.runScript(
        host,
        buildRemoteProbeScript(target),
        PROBE_TIMEOUT_MS,
        signal,
      );
      const probe = parseRemoteProbeReport(probeResult.stdout);
      if (!probe) throw new RemoteSshError(this.failureMessage("reach the host", probeResult));
      if (!isRemoteNodeVersionSupported(probe.nodeVersion)) {
        throw new RemoteSshError(
          `${REMOTE_SSH_NODE_REQUIREMENT} is required on ${host}` +
            (probe.nodeVersion ? ` (found ${probe.nodeVersion}).` : " (node was not found)."),
        );
      }

      let port: number;
      let token: string;
      if (probe.server && probe.server.version === this.installVersion()) {
        this.deps.log(`[remote-ssh] reusing server on ${host} port=${probe.server.port}`);
        port = probe.server.port;
        token = probe.server.token;
      } else {
        if (!probe.installed) {
          // Hosts never run npm: they unpack the dependency pack this build ships.
          if (!probe.tar) {
            throw new RemoteSshError(`tar is required on ${host} to install Saint.`);
          }
          const withDepsPack = !probe.depsInstalled;
          if (withDepsPack && !this.deps.hasDepsPack()) {
            throw new RemoteSshError(
              "This Saint build ships no remote dependency pack (apps/server/remote-deps/deps.tar.gz).",
            );
          }
          if (withDepsPack) this.deps.log(`[remote-ssh] ${host} uploading the dependency pack`);
          step("uploading");
          const upload = await this.runSsh(
            host,
            buildRemoteUploadCommand(target),
            this.deps.createInstallBundle(withDepsPack),
            UPLOAD_TIMEOUT_MS,
            signal,
          );
          if (upload.code !== 0) {
            throw new RemoteSshError(this.failureMessage("upload the server", upload));
          }
          step("installing");
          const install = await this.runScript(
            host,
            buildRemoteInstallScript(target),
            INSTALL_TIMEOUT_MS,
            signal,
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
          signal,
        );
        const started = parseRemoteStartReport(start.stdout);
        if (!started) throw new RemoteSshError(this.failureMessage("start the server", start));
        port = started.port;
      }

      step("tunneling");
      record.localPort ??= await this.deps.reserveLocalPort();
      if (record.token !== token) record.epoch += 1;
      record.token = token;
      record.remotePort = port;
      try {
        await this.openTunnel(record, port, signal);
      } catch (error) {
        if (!(error instanceof LocalPortInUseError)) throw error;
        // Open windows re-read the URL on reconnect, so moving to a new port is safe.
        this.closeTunnel(record);
        record.localPort = await this.deps.reserveLocalPort();
        await this.openTunnel(record, port, signal);
      }
      step("connected");
      return record.state;
    } catch (error) {
      this.closeTunnel(record);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log(`[remote-ssh] ${host} failed +${Date.now() - startedAt}ms: ${message}`);
      if (!signal.aborted && !reconnecting) this.update(record, "error", message);
      throw error instanceof RemoteSshError ? error : new RemoteSshError(message);
    }
  }

  /** A connected host's tunnel dropped: retry in the background; connect() joins this run. */
  private startReconnect(record: HostRecord): void {
    if (record.connecting) return;
    const abort = new AbortController();
    record.abort = abort;
    this.update(record, "reconnecting", null);
    const run = this.runReconnect(record, abort.signal).finally(() => {
      if (record.connecting === run) record.connecting = null;
      if (record.abort === abort) record.abort = null;
    });
    record.connecting = run;
    // Nobody may be awaiting the background run; the error phase carries the failure.
    run.catch(() => undefined);
  }

  /**
   * First try re-opens the tunnel to the same remote port with the same token, which
   * keeps the client URL and epoch. Later tries run a full connect: it reuses a live
   * server (same token) or restarts one (new token, new epoch).
   */
  private async runReconnect(
    record: HostRecord,
    signal: AbortSignal,
  ): Promise<DesktopRemoteSshHostState> {
    const host = record.state.host;
    const sleep = this.deps.sleep ?? abortableSleep;
    let lastMessage = "";
    for (const [attempt, delayMs] of RECONNECT_BACKOFF_MS.entries()) {
      try {
        await sleep(delayMs, signal);
      } catch {
        return record.state;
      }
      if (signal.aborted) return record.state;
      try {
        if (attempt === 0 && record.remotePort && record.token) {
          this.closeTunnel(record);
          await this.openTunnel(record, record.remotePort, signal);
          this.update(record, "connected", null);
          return record.state;
        }
        return await this.runConnect(record, signal, true);
      } catch (error) {
        this.closeTunnel(record);
        if (signal.aborted) return record.state;
        lastMessage = error instanceof Error ? error.message : String(error);
        this.deps.log(`[remote-ssh] ${host} reconnect ${attempt + 1} failed: ${lastMessage}`);
      }
    }
    const message = `Lost the SSH tunnel to ${host}: ${lastMessage}`;
    this.update(record, "error", message);
    throw new RemoteSshError(message);
  }

  private async openTunnel(record: HostRecord, remotePort: number, signal: AbortSignal) {
    const host = record.state.host;
    const localPort = record.localPort;
    if (!localPort) throw new RemoteSshError("No local port was reserved for the tunnel.");
    const tunnel = this.deps.spawn(
      "ssh",
      [
        // No ExitOnForwardFailure: a forward from the user's ssh config whose port
        // is taken (a RemoteForward held by another session) would kill the tunnel.
        // ClearAllForwardings cannot help, since it also drops this `-L`. Our own
        // forward is checked from stderr below and by the /health wait.
        ...SSH_BASE_OPTIONS,
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
    let rejectLocalForward: (error: RemoteSshError) => void = () => undefined;
    const localForwardFailed = new Promise<never>((_, reject) => {
      rejectLocalForward = reject;
    });
    localForwardFailed.catch(() => undefined);
    const ownForwardFailure = new RegExp(`cannot listen to port: ${localPort}\\b`, "u");
    tunnel.stderr?.setEncoding("utf8");
    tunnel.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      if (ownForwardFailure.test(stderr)) {
        rejectLocalForward(
          new LocalPortInUseError(
            `Local port ${localPort} for the SSH tunnel to ${host} is in use.`,
          ),
        );
      }
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
            this.deps.log(
              `[remote-ssh] ${host} tunnel closed${stderr ? `: ${tail(stderr)}` : "."} reconnecting`,
            );
            this.startReconnect(record);
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
        localForwardFailed,
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

  /**
   * Starts a background master connection the scripts of this connect share
   * (`-f` returns once it is authenticated). It exits CONTROL_PERSIST_SECONDS
   * after its last script. Any failure only means each script connects alone.
   */
  private async ensureControlMaster(host: string): Promise<void> {
    const controlPath = this.controlPath();
    if (!controlPath) return;
    const pathOption = ["-o", `ControlPath=${controlPath}`];
    if ((await this.runDetached([...pathOption, "-O", "check", "--", host])) === 0) return;
    const code = await this.runDetached([
      ...SSH_SCRIPT_OPTIONS,
      ...pathOption,
      "-o",
      "ControlMaster=yes",
      "-o",
      `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
      "-N",
      "-f",
      "--",
      host,
    ]);
    if (code !== 0) this.deps.log(`[remote-ssh] no shared connection to ${host} (exit ${code})`);
  }

  /** Runs ssh with no stdio (a forked master must not hold our pipes); resolves its exit code. */
  private runDetached(args: readonly string[]): Promise<number | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.deps.spawn("ssh", args, { stdio: ["ignore", "ignore", "ignore"] });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, CONTROL_MASTER_TIMEOUT_MS);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  private runScript(
    host: string,
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SshRunResult> {
    return this.runSsh(host, REMOTE_SSH_LOGIN_SHELL_COMMAND, script, timeoutMs, signal);
  }

  private runSsh(
    host: string,
    remoteCommand: string,
    stdin: string | Readable,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SshRunResult> {
    const controlPath = this.controlPath();
    // ControlMaster=no uses a live shared connection and connects on its own
    // otherwise, so a missing or expired master never fails a script.
    const sharing = controlPath
      ? ["-o", "ControlMaster=no", "-o", `ControlPath=${controlPath}`]
      : [];
    return new Promise((resolve, reject) => {
      const child = this.deps.spawn(
        "ssh",
        [...SSH_SCRIPT_OPTIONS, ...sharing, "--", host, remoteCommand],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
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
      // Killing ssh ends the remote shell's stdin; the next install clears what it left running.
      const stop = (error: RemoteSshError) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill();
        reject(error);
      };
      const onAbort = () => stop(new RemoteSshError("Connection cancelled."));
      const timer = setTimeout(() => {
        const stage = tail(stderr);
        stop(new RemoteSshError(`ssh to ${host} timed out.${stage ? `\n${stage}` : ""}`));
      }, timeoutMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
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
        signal?.removeEventListener("abort", onAbort);
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
