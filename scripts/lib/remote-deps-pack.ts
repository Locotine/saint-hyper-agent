// FILE: remote-deps-pack.ts
// Purpose: Packs the remote server's npm dependencies into one gzipped node_modules for SSH
//          hosts that have no npm (no sudo, no registry access). Read by
//          apps/desktop/src/remoteSshBundle.ts (REMOTE_DEPS_PACK_FILE).
// Layer: Desktop artifact build helper

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * node-pty 1.1.0 ships no Linux binaries, so a host without npm (and its
 * node-gyp) could not build one. This repackaging of the same node-pty ships
 * N-API binaries for every host below, which load on any supported Node.js.
 */
export const REMOTE_PACK_NODE_PTY = "@lydell/node-pty";
export const REMOTE_PACK_NODE_PTY_VERSION = "1.2.0-beta.18";
export const REMOTE_PACK_HOSTS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

/** The remote manifest with node-pty aliased to the prebuilt package. */
export function remoteDepsPackManifest(packageJson: string): string {
  const manifest = JSON.parse(packageJson) as { dependencies: Record<string, string> };
  manifest.dependencies["node-pty"] = `npm:${REMOTE_PACK_NODE_PTY}@${REMOTE_PACK_NODE_PTY_VERSION}`;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Installs `packageJson` with npm and writes `node_modules` as a .tar.gz to `outFile`. */
export function buildRemoteDepsPack(packageJson: string, outFile: string, verbose = false): void {
  const work = mkdtempSync(join(tmpdir(), "saint-remote-deps-"));
  const run = (command: string, args: string[], cwd: string) =>
    execFileSync(command, args, {
      cwd,
      stdio: verbose ? "inherit" : ["ignore", "ignore", "inherit"],
      // npm is npm.cmd on Windows, which Node only starts through a shell.
      shell: process.platform === "win32",
    });
  try {
    writeFileSync(join(work, "package.json"), remoteDepsPackManifest(packageJson));
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
    // Optional platform packages are skipped above; add each host's binary explicitly.
    const packs = join(work, "packs");
    mkdirSync(packs);
    for (const host of REMOTE_PACK_HOSTS) {
      const name = `${REMOTE_PACK_NODE_PTY}-${host}`;
      run("npm", ["pack", `${name}@${REMOTE_PACK_NODE_PTY_VERSION}`, "--silent"], packs);
      const target = join(work, "node_modules", name);
      mkdirSync(target, { recursive: true });
      const tarball = join(packs, `lydell-node-pty-${host}-${REMOTE_PACK_NODE_PTY_VERSION}.tgz`);
      run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"], work);
    }
    const installed = JSON.parse(
      readFileSync(join(work, "node_modules/node-pty/package.json"), "utf8"),
    ) as { name?: string };
    if (installed.name !== REMOTE_PACK_NODE_PTY) {
      throw new Error(
        `node-pty in the remote pack is ${installed.name}, not the prebuilt package.`,
      );
    }
    run("tar", ["-czf", outFile, "node_modules"], work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
