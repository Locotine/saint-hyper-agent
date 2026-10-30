// FILE: sandbox.ts
// Purpose: OS sandbox for provider processes and flow gates. Writes reach only the workspace
//          and the session's own dirs; HOME is a decoy whose credential files carry canaries;
//          protected files are read-only; network leaves only through Saint's loopback ports
//          (bwrap: a private network namespace plus a socket relay; sandbox-exec: a profile).
//          Windows has no OS sandbox.
// Layer: Server Aegis domain

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ProcessSandboxLauncher } from "@saint/shared/platformProcess";

import { resolveExecutable } from "../executableLookup.ts";

export type SandboxKind = "bwrap" | "sandbox-exec" | null;

export function detectSandbox(platform = process.platform): SandboxKind {
  if (platform === "darwin") return resolveExecutable("sandbox-exec") ? "sandbox-exec" : null;
  if (platform === "linux") return resolveExecutable("bwrap") ? "bwrap" : null;
  return null;
}

/** Credential dirs, relative to HOME, that a sandboxed process sees only as decoys. */
export const SANDBOX_MASKED_DIRS = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".saint",
  ".saint-beta",
  ".gnupg",
  ".docker",
  ".kube",
];
const MACOS_KEYCHAINS = "Library/Keychains";
/** Tool caches a sandboxed build may write to. */
export const WRITABLE_HOME_DIRS = [".cache", ".bun", ".npm", ".cargo/registry"];

export interface DecoyFile {
  readonly source: string;
  /** Relative to HOME. */
  readonly target: string;
}

/** Decoy credential files with fresh canary values; reading them trips the wire. */
export function prepareDecoys(dir: string): {
  readonly files: ReadonlyArray<DecoyFile>;
  readonly canaries: string[];
} {
  const aws = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
  const awsSecret = randomBytes(20).toString("base64url");
  const ssh = randomBytes(24).toString("base64url");
  const gh = `ghp_${randomBytes(18).toString("hex")}`;
  const saint = `saint_${randomBytes(16).toString("hex")}`;
  mkdirSync(dir, { recursive: true });
  const write = (name: string, target: string, content: string) => {
    const source = path.join(dir, name);
    writeFileSync(source, content, { mode: 0o600 });
    return { source, target };
  };
  return {
    files: [
      write(
        "aws-credentials",
        ".aws/credentials",
        `[default]\naws_access_key_id = ${aws}\naws_secret_access_key = ${awsSecret}\n`,
      ),
      write(
        "id_ed25519",
        ".ssh/id_ed25519",
        `-----BEGIN OPENSSH PRIVATE KEY-----\n${ssh}\n-----END OPENSSH PRIVATE KEY-----\n`,
      ),
      write("gh-hosts.yml", ".config/gh/hosts.yml", `github.com:\n  oauth_token: ${gh}\n`),
      write("saint-secret", ".saint/userdata/secrets.json", `{"token":"${saint}"}\n`),
    ],
    canaries: [aws, awsSecret, ssh, gh, saint],
  };
}

/** A loopback TCP port bridged across the sandbox boundary through a Unix socket. */
export interface RelayedPort {
  readonly port: number;
  readonly socketPath: string;
  /** out: sandbox → host service (proxy, gateway); in: host → service inside (a provider server). */
  readonly direction: "out" | "in";
}

export interface SandboxSpec {
  readonly kind: Exclude<SandboxKind, null>;
  readonly home: string;
  /** The real workspace (worktree or project folder). */
  readonly cwd: string;
  /** Session scratch dir: TMPDIR and the decoy HOME live here. */
  readonly sessionDir: string;
  /** Extra absolute paths the process may write (provider state dirs). */
  readonly writable: ReadonlyArray<string>;
  /** Absolute paths inside the workspace mounted read-only (protected zones). */
  readonly readOnly: ReadonlyArray<string>;
  readonly decoys: ReadonlyArray<DecoyFile>;
  /** Loopback ports the process may use; everything else is unreachable. */
  readonly ports: ReadonlyArray<RelayedPort>;
  /** bwrap only: how to run the in-sandbox relay (`node relay.mjs`). */
  readonly relay?: { readonly command: string; readonly args: ReadonlyArray<string> } | null;
}

/** A linked worktree commits into the main repository's git dir, so it must stay writable. */
export function gitCommonDir(cwd: string): string | null {
  try {
    const dotGit = path.join(cwd, ".git");
    if (!lstatSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const gitDir = path.resolve(cwd, match[1]!.trim());
    const worktrees = path.dirname(gitDir);
    return path.basename(worktrees) === "worktrees" ? path.dirname(worktrees) : gitDir;
  } catch {
    return null;
  }
}

/**
 * bwrap mounts for a decoy HOME: an empty tmpfs where every real entry is mounted back
 * read-only except the masked credential dirs, which hold only decoys.
 */
function bwrapHomeMounts(home: string, decoys: ReadonlyArray<DecoyFile>): string[] {
  const args: string[] = ["--tmpfs", home];
  const mountChildren = (relativeDir: string) => {
    const absolute = path.join(home, relativeDir);
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path.join(relativeDir, entry);
      const source = path.join(home, relative);
      if (SANDBOX_MASKED_DIRS.includes(relative)) continue;
      if (SANDBOX_MASKED_DIRS.some((masked) => masked.startsWith(`${relative}/`))) {
        args.push("--dir", source);
        mountChildren(relative);
        continue;
      }
      try {
        if (lstatSync(source).isSymbolicLink()) {
          args.push("--symlink", readlinkSync(source), source);
          continue;
        }
      } catch {
        continue;
      }
      args.push("--ro-bind-try", source, source);
    }
  };
  mountChildren("");
  for (const decoy of decoys) {
    args.push("--ro-bind", decoy.source, path.join(home, decoy.target));
  }
  return args;
}

const seatbeltString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const seatbeltPaths = (filter: "subpath" | "literal", paths: ReadonlyArray<string>) =>
  paths.map((value) => `(${filter} ${seatbeltString(value)})`).join(" ");

/** The launcher argv; the process to sandbox is appended to `args`. */
export function sandboxLauncher(spec: SandboxSpec): ProcessSandboxLauncher {
  const tmp = path.join(spec.sessionDir, "tmp");
  const writable = [
    spec.cwd,
    spec.sessionDir,
    ...spec.writable,
    ...WRITABLE_HOME_DIRS.map((dir) => path.join(spec.home, dir)),
  ].filter((dir, index, all) => existsSync(dir) && all.indexOf(dir) === index);
  if (spec.kind === "bwrap") {
    const outside = spec.ports.filter((port) => port.direction === "out");
    const inside = spec.ports.filter((port) => port.direction === "in");
    const relayDir = spec.ports[0] ? path.dirname(spec.ports[0].socketPath) : null;
    return {
      command: "bwrap",
      args: [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        ...bwrapHomeMounts(spec.home, spec.decoys),
        // Writable mounts go on top of the read-only HOME entries.
        ...writable.flatMap((dir) => ["--bind", dir, dir]),
        ...(relayDir ? ["--bind", relayDir, relayDir] : []),
        // The relay script lives in Saint's state dir, which the decoy HOME hides.
        ...(spec.relay?.args ?? [])
          .filter((arg) => path.isAbsolute(arg) && existsSync(arg))
          .flatMap((file) => ["--ro-bind", file, file]),
        ...spec.readOnly.filter(existsSync).flatMap((file) => ["--ro-bind", file, file]),
        "--unshare-net",
        "--die-with-parent",
        "--setenv",
        "TMPDIR",
        tmp,
        "--chdir",
        spec.cwd,
        ...(spec.relay && spec.ports.length > 0
          ? [
              "--setenv",
              "ELECTRON_RUN_AS_NODE",
              "1",
              spec.relay.command,
              ...spec.relay.args,
              JSON.stringify({
                out: outside.map(({ port, socketPath }) => ({ port, socketPath })),
                in: inside.map(({ port, socketPath }) => ({ port, socketPath })),
              }),
              "--",
            ]
          : []),
      ],
    };
  }
  const masked = [...SANDBOX_MASKED_DIRS, MACOS_KEYCHAINS].map((dir) => path.join(spec.home, dir));
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${seatbeltPaths("subpath", [...writable, "/private/tmp", "/private/var/folders"])} (literal "/dev/null") (regex #"^/dev/tty"))`,
    `(deny file-read* file-write* ${seatbeltPaths("subpath", masked)})`,
    // The session dir sits under ~/.saint; later rules win, so it is opened again here.
    `(allow file-read* file-write* ${seatbeltPaths("subpath", [spec.sessionDir])})`,
    ...(spec.readOnly.length > 0
      ? [`(deny file-write* ${seatbeltPaths("literal", spec.readOnly)})`]
      : []),
    "(deny network*)",
    "(allow network* (remote unix-socket))",
    ...spec.ports.map((port) =>
      port.direction === "out"
        ? `(allow network-outbound (remote ip "localhost:${port.port}"))`
        : `(allow network-bind network-inbound (local ip "localhost:${port.port}"))`,
    ),
  ].join("\n");
  return { command: "sandbox-exec", args: ["-p", profile] };
}

/**
 * macOS cannot remount HOME, so the decoy HOME is a folder of symlinks to the real entries
 * with the credential dirs replaced by decoys; the process gets it as `$HOME`.
 */
export function prepareDecoyHome(
  home: string,
  decoyHome: string,
  decoys: ReadonlyArray<DecoyFile>,
): void {
  mkdirSync(decoyHome, { recursive: true });
  const link = (relativeDir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(path.join(home, relativeDir));
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path.join(relativeDir, entry);
      if (SANDBOX_MASKED_DIRS.includes(relative)) continue;
      const target = path.join(decoyHome, relative);
      if (existsSync(target)) continue;
      if (SANDBOX_MASKED_DIRS.some((masked) => masked.startsWith(`${relative}/`))) {
        mkdirSync(target, { recursive: true });
        link(relative);
        continue;
      }
      try {
        symlinkSync(path.join(home, relative), target);
      } catch {
        // An entry that cannot be linked stays hidden.
      }
    }
  };
  link("");
  for (const decoy of decoys) {
    const target = path.join(decoyHome, decoy.target);
    mkdirSync(path.dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, readFileSync(decoy.source), { mode: 0o600 });
  }
}

/** Runs inside the bwrap network namespace: bridges loopback ports to Unix sockets, then runs the command. */
export const SANDBOX_RELAY_SCRIPT = `// Saint Aegis sandbox relay (generated file, do not edit).
import net from "node:net";
import { spawn } from "node:child_process";
const [spec, sep, command, ...args] = process.argv.slice(2);
if (sep !== "--" || !command) { console.error("saint relay: bad arguments"); process.exit(2); }
const { out = [], in: inbound = [] } = JSON.parse(spec);
const pipe = (a, b) => { a.pipe(b); b.pipe(a); a.on("error", () => b.destroy()); b.on("error", () => a.destroy()); };
const listening = [
  ...out.map(({ port, socketPath }) => new Promise((resolve, reject) =>
    net.createServer((client) => pipe(client, net.connect(socketPath)))
      .once("error", reject).listen(port, "127.0.0.1", resolve))),
  ...inbound.map(({ port, socketPath }) => new Promise((resolve, reject) =>
    net.createServer((client) => pipe(client, net.connect(port, "127.0.0.1")))
      .once("error", reject).listen(socketPath, resolve))),
];
await Promise.all(listening);
delete process.env.ELECTRON_RUN_AS_NODE;
const child = spawn(command, args, { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error("saint relay: " + error.message); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
`;

export function proxyEnv(url: string): Record<string, string> {
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}
