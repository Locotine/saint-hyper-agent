// FILE: sandbox.ts
// Purpose: OS sandbox for commands Saint runs on an agent's behalf (flow gates): writes only to
//          the workspace, scratch and tool caches; credential dirs hidden (decoys with canary
//          values on Linux); network only through the egress proxy. bwrap on Linux, sandbox-exec on macOS, none on Windows.
// Layer: Server Aegis domain

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveExecutable } from "../executableLookup.ts";

export type SandboxKind = "bwrap" | "sandbox-exec" | null;

export function detectSandbox(platform = process.platform): SandboxKind {
  if (platform === "darwin") return resolveExecutable("sandbox-exec") ? "sandbox-exec" : null;
  if (platform === "linux") return resolveExecutable("bwrap") ? "bwrap" : null;
  return null;
}

/** Credential dirs a sandboxed command never sees; Linux shows decoys there instead. */
export const SANDBOX_MASKED_DIRS = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".config/gcloud",
  ".saint",
  ".saint-beta",
];
/** Tool caches a sandboxed build may write to. */
const WRITABLE_HOME_DIRS = [".cache", ".bun", ".npm", ".cargo/registry"];

/** Decoy credential files with fresh canary values; reading them trips the wire. */
export function prepareDecoys(dir: string): {
  readonly files: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly canaries: string[];
} {
  const aws = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
  const awsSecret = randomBytes(20).toString("base64url");
  const ssh = randomBytes(24).toString("base64url");
  const gh = `ghp_${randomBytes(18).toString("hex")}`;
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
    ],
    canaries: [aws, awsSecret, ssh, gh],
  };
}

export interface SandboxCommandInput {
  readonly kind: Exclude<SandboxKind, null>;
  readonly cwd: string;
  readonly home: string;
  readonly scratch: string;
  readonly decoys: ReadonlyArray<{ readonly source: string; readonly target: string }>;
  readonly command: string;
  /** Loopback port of the egress proxy; without it the command has no network. */
  readonly proxyPort: number | null;
}

const seatbeltString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** argv that runs `command` through `/bin/sh -c` inside the sandbox. */
export function sandboxArgv(input: SandboxCommandInput): {
  readonly file: string;
  readonly args: string[];
} {
  const home = input.home;
  if (input.kind === "bwrap") {
    const exists = (dir: string) => existsSync(path.join(home, dir));
    return {
      file: "bwrap",
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
        ...SANDBOX_MASKED_DIRS.filter(exists).flatMap((dir) => ["--tmpfs", path.join(home, dir)]),
        // A decoy needs its (masked) directory to exist to be mounted into.
        ...input.decoys
          .filter(
            (decoy) =>
              SANDBOX_MASKED_DIRS.includes(path.dirname(decoy.target)) &&
              exists(path.dirname(decoy.target)),
          )
          .flatMap((decoy) => ["--ro-bind", decoy.source, path.join(home, decoy.target)]),
        ...WRITABLE_HOME_DIRS.filter(exists).flatMap((dir) => [
          "--bind",
          path.join(home, dir),
          path.join(home, dir),
        ]),
        "--bind",
        input.cwd,
        input.cwd,
        "--bind",
        input.scratch,
        input.scratch,
        ...(input.proxyPort === null ? ["--unshare-net"] : []),
        "--die-with-parent",
        "--chdir",
        input.cwd,
        "/bin/sh",
        "-c",
        input.command,
      ],
    };
  }
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${seatbeltString(input.cwd)}) (subpath ${seatbeltString(input.scratch)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null"))`,
    `(deny file-read* ${[...SANDBOX_MASKED_DIRS, "Library/Keychains"].map((dir) => `(subpath ${seatbeltString(path.join(home, dir))})`).join(" ")})`,
    `(allow file-write* ${WRITABLE_HOME_DIRS.map((dir) => `(subpath ${seatbeltString(path.join(home, dir))})`).join(" ")})`,
    "(deny network*)",
    `(allow network* (remote unix-socket))`,
    ...(input.proxyPort === null
      ? []
      : [`(allow network-outbound (remote ip "localhost:${input.proxyPort}"))`]),
  ].join("\n");
  return { file: "sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", input.command] };
}

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
