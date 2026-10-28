// FILE: remote-deps-pack.ts
// Purpose: Builds and checks the remote server's dependency pack, a gzipped node_modules
//          committed in apps/server/remote-deps so no machine needs npm to install a
//          remote SSH host. Read by apps/desktop/src/remoteSshBundle.ts (REMOTE_DEPS_PACK_FILE).
// Layer: Desktop artifact build helper

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRemoteServerInstallManifest,
  type RemoteServerPatch,
} from "@saint/shared/remoteServerInstall";

/** Folder of the committed pack and its descriptor, relative to the repository root. */
export const REMOTE_DEPS_DIR = "apps/server/remote-deps";
export const REMOTE_DEPS_PACK_FILE = "deps.tar.gz";
export const REMOTE_DEPS_DESCRIPTOR_FILE = "deps.json";
export const REMOTE_DEPS_REBUILD_HINT =
  "Run `bun run remote:deps-pack` and commit apps/server/remote-deps.";

/**
 * node-pty 1.1.0 ships no Linux binaries, so a host without npm (and its
 * node-gyp) could not build one. This repackaging of the same node-pty ships
 * N-API binaries for every host below, which load on any supported Node.js.
 */
export const REMOTE_PACK_NODE_PTY = "@lydell/node-pty";
export const REMOTE_PACK_NODE_PTY_VERSION = "1.2.0-beta.18";
export const REMOTE_PACK_HOSTS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** What the pack was built from; any change means the committed pack is stale. */
export interface RemoteDepsDescriptor {
  /** Exact versions installed into the pack, node-pty aliased to the prebuilt package. */
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  /** Patch file name -> sha256 of the patch applied while packing. */
  readonly patches: Record<string, string>;
  readonly nodePtyHosts: readonly string[];
}

/** `deps.json`: the descriptor plus the sha256 of `deps.tar.gz`. */
export interface RemoteDepsLock extends RemoteDepsDescriptor {
  readonly sha256: string;
}

interface WorkspaceManifests {
  readonly rootPackageJson: {
    readonly workspaces?: { readonly catalog?: Record<string, unknown> };
    readonly overrides?: Record<string, unknown>;
    readonly patchedDependencies?: Record<string, unknown>;
  };
  readonly serverPackageJson: {
    readonly version: string;
    readonly dependencies?: Record<string, unknown>;
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function readWorkspaceManifests(repoRoot: string): WorkspaceManifests {
  return {
    rootPackageJson: readJson(join(repoRoot, "package.json")),
    serverPackageJson: readJson(join(repoRoot, "apps/server/package.json")),
  };
}

/** The version the workspace install resolved for a server dependency (from bun.lock). */
function installedVersion(repoRoot: string, name: string): string {
  const path = join(repoRoot, "apps/server/node_modules", name, "package.json");
  if (!existsSync(path)) {
    throw new Error(`${name} is not installed in apps/server; run bun install first.`);
  }
  return readJson<{ version: string }>(path).version;
}

function remoteManifest(repoRoot: string) {
  const { rootPackageJson, serverPackageJson } = readWorkspaceManifests(repoRoot);
  return createRemoteServerInstallManifest({
    serverPackageJson,
    catalog: rootPackageJson.workspaces?.catalog ?? {},
    ...(rootPackageJson.overrides ? { overrides: rootPackageJson.overrides } : {}),
    ...(rootPackageJson.patchedDependencies
      ? { patchedDependencies: rootPackageJson.patchedDependencies }
      : {}),
  });
}

/** The descriptor the committed pack must match for this checkout. */
export function expectedRemoteDepsDescriptor(repoRoot: string): RemoteDepsDescriptor {
  const manifest = remoteManifest(repoRoot);
  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(manifest.packageJson.dependencies)) {
    dependencies[name] =
      name === "node-pty"
        ? `npm:${REMOTE_PACK_NODE_PTY}@${REMOTE_PACK_NODE_PTY_VERSION}`
        : installedVersion(repoRoot, name);
  }
  const patches: Record<string, string> = {};
  for (const patch of manifest.patches) {
    patches[patch.fileName] = sha256(readFileSync(join(repoRoot, patch.patchPath)));
  }
  return {
    dependencies,
    overrides: { ...manifest.packageJson.overrides },
    patches,
    nodePtyHosts: [...REMOTE_PACK_HOSTS],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Differences between what the pack was built from and what this checkout expects. */
export function diffRemoteDepsDescriptor(
  expected: RemoteDepsDescriptor,
  actual: RemoteDepsDescriptor,
): string[] {
  const problems: string[] = [];
  for (const field of ["dependencies", "overrides", "patches", "nodePtyHosts"] as const) {
    if (stableJson(expected[field]) !== stableJson(actual[field])) {
      problems.push(
        `${field} differ: pack has ${stableJson(actual[field])}, checkout expects ${stableJson(expected[field])}.`,
      );
    }
  }
  return problems;
}

/**
 * Problems with the committed pack in `packDir` (default: the repository's): a
 * missing file, a descriptor that no longer matches the checkout, or a pack
 * whose sha256 differs from its descriptor. Empty when the pack is current.
 */
export function checkRemoteDepsPack(repoRoot: string, packDir = join(repoRoot, REMOTE_DEPS_DIR)) {
  const packPath = join(packDir, REMOTE_DEPS_PACK_FILE);
  const lockPath = join(packDir, REMOTE_DEPS_DESCRIPTOR_FILE);
  if (!existsSync(packPath) || !existsSync(lockPath)) {
    return [
      `${REMOTE_DEPS_DIR}/${REMOTE_DEPS_PACK_FILE} or ${REMOTE_DEPS_DESCRIPTOR_FILE} is missing.`,
    ];
  }
  const lock = readJson<RemoteDepsLock>(lockPath);
  const problems = diffRemoteDepsDescriptor(expectedRemoteDepsDescriptor(repoRoot), lock);
  const actualSha = sha256(readFileSync(packPath));
  if (actualSha !== lock.sha256) {
    problems.push(
      `${REMOTE_DEPS_PACK_FILE} sha256 is ${actualSha}, ${REMOTE_DEPS_DESCRIPTOR_FILE} records ${lock.sha256}.`,
    );
  }
  return problems;
}

export type RemoteDepsCommandRunner = (command: string, args: string[], cwd: string) => void;

function defaultRunner(verbose: boolean): RemoteDepsCommandRunner {
  return (command, args, cwd) => {
    execFileSync(command, args, {
      cwd,
      // macOS tar would otherwise add AppleDouble `._*` entries for extended attributes.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: verbose ? "inherit" : ["ignore", "ignore", "inherit"],
      // npm is npm.cmd on Windows, which Node only starts through a shell.
      shell: process.platform === "win32",
    });
  };
}

/** Applies each patch to its package inside `nodeModules`; a patch that does not apply fails. */
export function applyRemoteDepsPatches(
  repoRoot: string,
  nodeModules: string,
  patches: readonly RemoteServerPatch[],
  run: RemoteDepsCommandRunner,
): void {
  for (const patch of patches) {
    const packageDir = join(nodeModules, patch.packageName);
    if (!existsSync(packageDir)) {
      throw new Error(`Cannot patch ${patch.packageName}: it is not in the remote pack.`);
    }
    run(
      "patch",
      ["-p1", "--forward", "--batch", "-i", join(repoRoot, patch.patchPath)],
      packageDir,
    );
  }
}

/**
 * Installs the remote dependencies at their exact workspace versions with npm
 * (only the machine that refreshes the committed pack needs npm), applies the
 * repository's patches, adds every host's node-pty binary, drops the Agent
 * SDK's bundled Claude Code binaries, and writes `deps.tar.gz` and `deps.json`
 * into `outDir`.
 */
export function buildRemoteDepsPack(
  repoRoot: string,
  outDir: string,
  options: { readonly verbose?: boolean; readonly run?: RemoteDepsCommandRunner } = {},
): RemoteDepsLock {
  const run = options.run ?? defaultRunner(options.verbose ?? false);
  const descriptor = expectedRemoteDepsDescriptor(repoRoot);
  const manifest = remoteManifest(repoRoot);
  const work = mkdtempSync(join(tmpdir(), "saint-remote-deps-"));
  try {
    writeFileSync(
      join(work, "package.json"),
      `${JSON.stringify(
        {
          name: "saint-remote-deps",
          private: true,
          type: "module",
          dependencies: descriptor.dependencies,
          overrides: descriptor.overrides,
        },
        null,
        2,
      )}\n`,
    );
    run(
      "npm",
      [
        "install",
        "--omit=dev",
        "--omit=optional",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      work,
    );
    const nodeModules = join(work, "node_modules");
    applyRemoteDepsPatches(repoRoot, nodeModules, manifest.patches, run);
    rmSync(join(nodeModules, ".package-lock.json"), { force: true });
    // The server runs the host's own `claude`, never the SDK's bundled binaries.
    const anthropic = join(nodeModules, "@anthropic-ai");
    for (const name of existsSync(anthropic) ? readdirSync(anthropic) : []) {
      if (name.startsWith("claude-agent-sdk-")) {
        rmSync(join(anthropic, name), { recursive: true, force: true });
      }
    }
    // Optional platform packages are skipped above; add each host's binary explicitly.
    const packs = join(work, "packs");
    mkdirSync(packs);
    for (const host of REMOTE_PACK_HOSTS) {
      const name = `${REMOTE_PACK_NODE_PTY}-${host}`;
      run("npm", ["pack", `${name}@${REMOTE_PACK_NODE_PTY_VERSION}`, "--silent"], packs);
      const target = join(nodeModules, name);
      mkdirSync(target, { recursive: true });
      const tarball = join(packs, `lydell-node-pty-${host}-${REMOTE_PACK_NODE_PTY_VERSION}.tgz`);
      run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], work);
    }
    const installed = readJson<{ name?: string }>(join(nodeModules, "node-pty/package.json"));
    if (installed.name !== REMOTE_PACK_NODE_PTY) {
      throw new Error(
        `node-pty in the remote pack is ${installed.name}, not the prebuilt package.`,
      );
    }
    // A shared store serves every account of a host, so the pack must not carry
    // the packing user's umask (npm keeps it).
    run("chmod", ["-R", "u+rwX,go+rX,go-w", "node_modules"], work);
    mkdirSync(outDir, { recursive: true });
    const packPath = join(outDir, REMOTE_DEPS_PACK_FILE);
    run("tar", ["-czf", packPath, "node_modules"], work);
    const lock: RemoteDepsLock = { sha256: sha256(readFileSync(packPath)), ...descriptor };
    writeFileSync(join(outDir, REMOTE_DEPS_DESCRIPTOR_FILE), `${JSON.stringify(lock, null, 2)}\n`);
    return lock;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
