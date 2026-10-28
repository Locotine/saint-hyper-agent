import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import type { DesktopRemoteSshHostState } from "@saint/contracts";
import { describe, expect, it, vi } from "vitest";

import { RemoteSshManager, type RemoteSshManagerDependencies } from "./remoteSshManager";

interface FakeChild {
  readonly args: readonly string[];
  readonly stdin: string[];
  readonly child: ChildProcess;
  exit: (code: number) => void;
}

/** Each ssh invocation answers from `respond`, keyed by what it runs. */
function fakeSpawn(
  respond: (
    args: readonly string[],
    stdin: string,
  ) => { stdout?: string; stderr?: string; code?: number } | "tunnel",
) {
  const calls: FakeChild[] = [];
  const spawn: RemoteSshManagerDependencies["spawn"] = (_command, args) => {
    const emitter = new EventEmitter() as ChildProcess & EventEmitter;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const written: string[] = [];
    Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => {
        (emitter as { exitCode: number | null }).exitCode = 143;
        emitter.emit("exit", null);
        return true;
      }),
    });
    const record: FakeChild = {
      args,
      stdin: written,
      child: emitter,
      exit: (code) => {
        (emitter as { exitCode: number | null }).exitCode = code;
        emitter.emit("exit", code);
      },
    };
    calls.push(record);
    stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    stdin.on("finish", () => {
      const answer = respond(args, written.join(""));
      if (answer === "tunnel") return;
      stdout.end(answer.stdout ?? "");
      stderr.end(answer.stderr ?? "");
      setImmediate(() => emitter.emit("close", answer.code ?? 0));
    });
    // Connection-sharing runs (`-O check`, the forked `-f` master) take no stdin.
    if (args.includes("-O") || args.includes("-f")) {
      const answer = respond(args, "");
      setImmediate(() => record.exit(answer === "tunnel" ? 0 : (answer.code ?? 0)));
      return emitter;
    }
    if (args.includes("-N")) respond(args, "");
    return emitter;
  };
  return { spawn, calls };
}

const PROBE_FRESH =
  'SAINT_REMOTE {"kind":"probe","node":"v24.13.1","npm":true,"installed":false,"server":null}';

function makeManager(
  spawn: RemoteSshManagerDependencies["spawn"],
  overrides: Partial<RemoteSshManagerDependencies> = {},
) {
  const states: DesktopRemoteSshHostState[] = [];
  const manager = new RemoteSshManager({
    spawn,
    installIdentity: () => ({ version: "1.2.3", depsHash: "0123456789ab" }),
    defaultRemoteRoot: ".saint-remote",
    storeRoot: ".saint-remote",
    createInstallBundle: () => Readable.from([Buffer.from("bundle")]),
    reserveLocalPort: async () => 45_000,
    waitForHttpReady: async () => undefined,
    createToken: () => "tok",
    log: () => undefined,
    onStateChange: (state) => states.push(state),
    ...overrides,
  });
  return { manager, states };
}

function scriptKind(stdin: string): string {
  if (stdin.includes('report "{\\"kind\\":\\"probe')) return "probe";
  if (stdin.includes("npm install")) return "install";
  if (stdin.includes("tmux new-session")) return "start";
  if (stdin.includes(`report '{"kind":"stopped"}'`)) return "stop";
  return stdin === "bundle" ? "upload" : "unknown";
}

describe("RemoteSshManager", () => {
  it("installs, starts and tunnels a fresh host", async () => {
    const seen: string[] = [];
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      const kind = scriptKind(stdin);
      seen.push(kind);
      if (kind === "probe") return { stdout: PROBE_FRESH };
      if (kind === "install") return { stdout: 'SAINT_REMOTE {"kind":"installed"}' };
      if (kind === "start") return { stdout: 'SAINT_REMOTE {"kind":"started","port":4100}' };
      return {};
    });
    const { manager, states } = makeManager(spawn);

    const state = await manager.connect({ host: "devbox" });

    expect(seen).toEqual(["probe", "upload", "install", "start"]);
    expect(state).toMatchObject({ host: "devbox", phase: "connected", localPort: 45_000 });
    expect(states.map((entry) => entry.phase)).toEqual([
      "checking",
      "uploading",
      "installing",
      "starting",
      "tunneling",
      "connected",
    ]);
    const tunnel = calls.find((call) => call.args.includes("-N"));
    expect(tunnel?.args).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "-L",
        "127.0.0.1:45000:127.0.0.1:4100",
        "--",
        "devbox",
      ]),
    );
    // A forward from the user's ssh config failing must not kill the tunnel, and
    // script runs set up none of those forwards at all.
    expect(tunnel?.args).not.toContain("ExitOnForwardFailure=yes");
    expect(tunnel?.args).not.toContain("ClearAllForwardings=yes");
    const scripts = calls.filter((call) => !call.args.includes("-N"));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((call) => call.args.includes("ClearAllForwardings=yes"))).toBe(true);
    // The token goes over stdin, never into an ssh argument.
    expect(calls.every((call) => !call.args.some((arg) => arg.includes("tok")))).toBe(true);
    expect(manager.wsUrl("devbox")).toBe("ws://127.0.0.1:45000/?token=tok");
  });

  it("reuses a live server of the same version without reinstalling", async () => {
    const seen: string[] = [];
    const { spawn } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      seen.push(scriptKind(stdin));
      return {
        stdout:
          'SAINT_REMOTE {"kind":"probe","node":"v24.1.0","npm":true,"installed":true,"server":{"info":{"port":4200,"version":"1.2.3"},"token":"live"}}',
      };
    });
    const { manager } = makeManager(spawn);
    await manager.connect({ host: "devbox", remoteRoot: "squad/saint" });
    expect(seen).toEqual(["probe"]);
    expect(manager.wsUrl("devbox")).toBe("ws://127.0.0.1:45000/?token=live");
    expect(manager.states()[0]?.remoteRoot).toBe("squad/saint");
  });

  it("keeps each client's data apart while sharing installed versions", async () => {
    const scripts: string[] = [];
    const { spawn } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      scripts.push(stdin);
      if (scriptKind(stdin) === "start")
        return { stdout: 'SAINT_REMOTE {"kind":"started","port":4100}' };
      return { stdout: PROBE_FRESH.replace('"installed":false', '"installed":true') };
    });
    const { manager } = makeManager(spawn, {
      defaultRemoteRoot: ".saint-remote/clients/anh-0a1b2c3d",
    });
    await manager.connect({ host: "devbox" });
    expect(manager.states()[0]?.remoteRoot).toBe(".saint-remote/clients/anh-0a1b2c3d");
    expect(scripts[0]).toContain(`root="$HOME/"'.saint-remote/clients/anh-0a1b2c3d'`);
    expect(scripts[0]).toContain(`store_root="$HOME/"'.saint-remote'`);
  });

  it("refuses hosts whose Node.js lacks the node:sqlite APIs", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout:
        'SAINT_REMOTE {"kind":"probe","node":"v22.15.0","npm":true,"installed":false,"server":null}',
    }));
    const { manager, states } = makeManager(spawn);
    await expect(manager.connect({ host: "devbox" })).rejects.toThrow(
      /Node.js 22.16\+, 23.11\+ or 24\+ is required on devbox \(found v22.15.0\)/,
    );
    expect(states.at(-1)).toMatchObject({ phase: "error" });
  });

  it("surfaces ssh failures with stderr", async () => {
    const { spawn } = fakeSpawn(() => ({
      code: 255,
      stderr: "Permission denied (publickey).",
    }));
    const { manager } = makeManager(spawn);
    await expect(manager.connect({ host: "devbox" })).rejects.toThrow(
      /reach the host \(ssh exit 255\): Permission denied/,
    );
  });

  it("rejects option-like hosts and unsafe folders before running ssh", async () => {
    const spawn = vi.fn();
    const { manager } = makeManager(spawn);
    await expect(manager.connect({ host: "-oProxyCommand=x" })).rejects.toThrow(/valid SSH host/);
    await expect(manager.connect({ host: "devbox", remoteRoot: "../x" })).rejects.toThrow(
      /relative path/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("moves the tunnel to a fresh local port when its own port is taken", async () => {
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      return scriptKind(stdin) === "probe"
        ? {
            stdout:
              'SAINT_REMOTE {"kind":"probe","node":"v22.23.2","npm":true,"installed":true,"server":{"info":{"port":4200,"version":"1.2.3"},"token":"live"}}',
          }
        : {};
    });
    const ports = [45_000, 45_001];
    let readyCalls = 0;
    const { manager } = makeManager(spawn, {
      reserveLocalPort: async () => ports.shift() ?? 0,
      waitForHttpReady: (_url, signal) => {
        readyCalls += 1;
        if (readyCalls > 1) return Promise.resolve();
        // ssh reports the bind failure for our port next to a config RemoteForward warning.
        const tunnel = calls.find((call) => call.args.includes("-N"));
        setImmediate(() =>
          (tunnel?.child.stderr as PassThrough | null)?.write(
            "Warning: remote port forwarding failed for listen port 8931\n" +
              "bind [127.0.0.1]:45000: Address already in use\n" +
              "channel_setup_fwd_listener_tcpip: cannot listen to port: 45000\n",
          ),
        );
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    });
    const state = await manager.connect({ host: "devbox" });
    const tunnels = calls.filter((call) => call.args.includes("-N"));
    expect(tunnels.map((call) => call.args.find((arg) => arg.includes(":127.0.0.1:4200")))).toEqual(
      ["127.0.0.1:45000:127.0.0.1:4200", "127.0.0.1:45001:127.0.0.1:4200"],
    );
    expect(tunnels[0]?.child.kill).toHaveBeenCalled();
    expect(state).toMatchObject({ phase: "connected", localPort: 45_001 });
    expect(manager.wsUrl("devbox")).toBe("ws://127.0.0.1:45001/?token=live");
  });

  it("keeps the tunnel when only a forward from the ssh config fails", async () => {
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      return scriptKind(stdin) === "probe"
        ? {
            stdout:
              'SAINT_REMOTE {"kind":"probe","node":"v24.1.0","npm":true,"installed":true,"server":{"info":{"port":4200,"version":"1.2.3"},"token":"live"}}',
          }
        : {};
    });
    const { manager } = makeManager(spawn, {
      waitForHttpReady: async () => {
        const tunnel = calls.find((call) => call.args.includes("-N"));
        (tunnel?.child.stderr as PassThrough | null)?.write(
          "Warning: remote port forwarding failed for listen port 8931\n",
        );
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    await expect(manager.connect({ host: "devbox" })).resolves.toMatchObject({
      phase: "connected",
      localPort: 45_000,
    });
  });

  it("reports a tunnel that drops after connecting and keeps the URL for reconnects", async () => {
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      return scriptKind(stdin) === "probe"
        ? {
            stdout:
              'SAINT_REMOTE {"kind":"probe","node":"v24.1.0","npm":true,"installed":true,"server":{"info":{"port":4200,"version":"1.2.3"},"token":"live"}}',
          }
        : {};
    });
    const { manager, states } = makeManager(spawn);
    await manager.connect({ host: "devbox" });
    calls.find((call) => call.args.includes("-N"))?.exit(255);
    expect(states.at(-1)).toMatchObject({
      phase: "error",
      message: expect.stringMatching(/tunnel/),
    });
    expect(manager.wsUrl("devbox")).toBe("ws://127.0.0.1:45000/?token=live");
  });

  it("disconnect closes the tunnel and stop runs the stop script", async () => {
    const seen: string[] = [];
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      const kind = scriptKind(stdin);
      seen.push(kind);
      if (kind === "stop") return { stdout: 'SAINT_REMOTE {"kind":"stopped"}' };
      return {
        stdout:
          'SAINT_REMOTE {"kind":"probe","node":"v24.1.0","npm":true,"installed":true,"server":{"info":{"port":4200,"version":"1.2.3"},"token":"live"}}',
      };
    });
    const { manager, states } = makeManager(spawn);
    await manager.connect({ host: "devbox" });
    const tunnel = calls.find((call) => call.args.includes("-N"));
    manager.disconnect("devbox");
    expect(tunnel?.child.kill).toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "idle" });
    await manager.stopServer({ host: "devbox" });
    expect(seen).toEqual(["probe", "stop"]);
    expect(states.at(-1)).toMatchObject({ phase: "idle" });
  });

  it("disconnect during an install kills its ssh instead of waiting for the timeout", async () => {
    const { spawn, calls } = fakeSpawn((_args, stdin) => {
      const kind = scriptKind(stdin);
      if (kind === "probe") return { stdout: PROBE_FRESH };
      return kind === "install" ? "tunnel" : {};
    });
    const { manager } = makeManager(spawn);
    const connecting = manager.connect({ host: "devbox" });
    await vi.waitFor(() =>
      expect(calls.some((call) => scriptKind(call.stdin.join("")) === "install")).toBe(true),
    );
    manager.disconnect("devbox");
    await expect(connecting).rejects.toThrow("Connection cancelled.");
    const install = calls.find((call) => scriptKind(call.stdin.join("")) === "install");
    expect(install?.child.kill).toHaveBeenCalled();
  });

  it("installs without npm when this build's dependencies are already on the host", async () => {
    const seen: string[] = [];
    const { spawn } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      const kind = scriptKind(stdin);
      seen.push(kind);
      if (kind === "probe") {
        return { stdout: PROBE_FRESH.replace('"npm":true', '"npm":false,"deps":true') };
      }
      if (kind === "install") return { stdout: 'SAINT_REMOTE {"kind":"installed"}' };
      if (kind === "start") return { stdout: 'SAINT_REMOTE {"kind":"started","port":4100}' };
      return {};
    });
    const { manager } = makeManager(spawn);
    await expect(manager.connect({ host: "devbox" })).resolves.toMatchObject({
      phase: "connected",
    });
    expect(seen).toEqual(["probe", "upload", "install", "start"]);
  });

  it("still requires npm when the dependencies are missing", async () => {
    const { spawn } = fakeSpawn(() => ({
      stdout: PROBE_FRESH.replace('"npm":true', '"npm":false,"deps":false'),
    }));
    const { manager } = makeManager(spawn);
    await expect(manager.connect({ host: "devbox" })).rejects.toThrow(/npm is required/);
  });

  it("reconnects a connected host whose server no longer answers", async () => {
    const seen: string[] = [];
    const { spawn } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      const kind = scriptKind(stdin);
      seen.push(kind);
      if (kind === "start") return { stdout: 'SAINT_REMOTE {"kind":"started","port":4300}' };
      return { stdout: PROBE_FRESH.replace('"installed":false', '"installed":true') };
    });
    let healthy = true;
    const { manager } = makeManager(spawn, {
      waitForHttpReady: async () => {
        if (!healthy) throw new Error("down");
      },
    });
    await manager.connect({ host: "devbox" });
    expect(seen).toEqual(["probe", "start"]);

    // A live server answers, so connecting again runs nothing on the host.
    await manager.connect({ host: "devbox" });
    expect(seen).toEqual(["probe", "start"]);

    // After an idle exit the tunnel stays up but nothing answers behind it.
    healthy = false;
    const reconnect = manager.connect({ host: "devbox" });
    await new Promise((resolve) => setImmediate(resolve));
    healthy = true;
    await expect(reconnect).resolves.toMatchObject({ phase: "connected" });
    expect(seen).toEqual(["probe", "start", "probe", "start"]);
  });

  it("shares one ssh connection across the scripts of a connect", async () => {
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-O")) return { code: 255 };
      if (args.includes("-f")) return { code: 0 };
      if (args.includes("-N")) return "tunnel";
      const kind = scriptKind(stdin);
      if (kind === "start") return { stdout: 'SAINT_REMOTE {"kind":"started","port":4100}' };
      if (kind === "install") return { stdout: 'SAINT_REMOTE {"kind":"installed"}' };
      return { stdout: PROBE_FRESH };
    });
    const { manager } = makeManager(spawn, { sshControlDir: "/home/anh/.saint/userdata/ssh" });
    await manager.connect({ host: "devbox" });
    const controlPath = "ControlPath=/home/anh/.saint/userdata/ssh/%C";
    const master = calls.find((call) => call.args.includes("-f"));
    expect(master?.args).toEqual(
      expect.arrayContaining([controlPath, "ControlMaster=yes", "ControlPersist=120", "-N"]),
    );
    const scripts = calls.filter((call) => !call.args.includes("-N") && !call.args.includes("-O"));
    expect(scripts).toHaveLength(4);
    expect(
      scripts.every(
        (call) => call.args.includes("ControlMaster=no") && call.args.includes(controlPath),
      ),
    ).toBe(true);
    // The tunnel keeps its own connection, as before.
    const tunnel = calls.find((call) => call.args.includes("-L"));
    expect(tunnel?.args).not.toContain(controlPath);
  });

  it("skips connection sharing when the socket path would be too long", async () => {
    const { spawn, calls } = fakeSpawn((args, stdin) => {
      if (args.includes("-N")) return "tunnel";
      return scriptKind(stdin) === "start"
        ? { stdout: 'SAINT_REMOTE {"kind":"started","port":4100}' }
        : { stdout: PROBE_FRESH.replace('"installed":false', '"installed":true') };
    });
    const { manager } = makeManager(spawn, { sshControlDir: `/home/${"x".repeat(80)}` });
    await manager.connect({ host: "devbox" });
    expect(calls.some((call) => call.args.some((arg) => arg.startsWith("ControlPath=")))).toBe(
      false,
    );
  });
});
