// FILE: remoteSshBundle.ts
// Purpose: Packs the server bundle the desktop already ships, plus its manifest and the
//          committed dependency pack, into a gzipped tar stream for upload to a remote SSH host.
// Layer: Desktop remote SSH utility
// Exports: loadRemoteInstallPackageJson, collectRemoteInstallEntries, remoteInstallVersion,
//          remoteDepsPackPath, remoteInstallDepsHash, createTarGzStream

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable } from "node:stream";
import * as Zlib from "node:zlib";

import { createRemoteServerInstallManifest } from "@saint/shared/remoteServerInstall";

/**
 * Folder the desktop artifact build stages next to `apps/server/dist` with the
 * resolved `package.json` and a copy of the committed dependency pack. Source
 * checkouts have no such folder and read the same files from the repository.
 */
export const REMOTE_INSTALL_STAGE_DIR = "apps/server/remote-install";

/** The dependency pack committed in the repository (scripts/lib/remote-deps-pack.ts). */
export const REMOTE_DEPS_REPO_DIR = "apps/server/remote-deps";

/**
 * Gzipped `node_modules` of the remote dependencies, patched, with node-pty
 * binaries for macOS and Linux on arm64 and x64. Every host unpacks it with
 * `tar`; no host or client runs npm.
 */
export const REMOTE_DEPS_PACK_FILE = "deps.tar.gz";
/** What the pack was built from, with its sha256 (`RemoteDepsLock`). */
export const REMOTE_DEPS_DESCRIPTOR_FILE = "deps.json";

/** The staged pack in a packaged app, otherwise the one committed in the checkout. */
function remoteDepsDir(appRoot: string): string {
  const staged = Path.join(appRoot, REMOTE_INSTALL_STAGE_DIR);
  return FS.existsSync(Path.join(staged, REMOTE_DEPS_PACK_FILE))
    ? staged
    : Path.join(appRoot, REMOTE_DEPS_REPO_DIR);
}

export function remoteDepsPackPath(appRoot: string): string {
  return Path.join(remoteDepsDir(appRoot), REMOTE_DEPS_PACK_FILE);
}

export function remoteDepsDescriptorPath(appRoot: string): string {
  return Path.join(remoteDepsDir(appRoot), REMOTE_DEPS_DESCRIPTOR_FILE);
}

export interface RemoteInstallEntry {
  /** Path inside the archive, `/`-separated. */
  readonly path: string;
  readonly contents: Buffer;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(FS.readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The manifest the version folder keeps for this build, staged (packaged app) or derived (checkout). */
export function loadRemoteInstallPackageJson(appRoot: string): string {
  const staged = Path.join(appRoot, REMOTE_INSTALL_STAGE_DIR, "package.json");
  if (FS.existsSync(staged)) return FS.readFileSync(staged, "utf8");

  const rootPackageJson = readJson(Path.join(appRoot, "package.json")) as {
    workspaces?: { catalog?: Record<string, unknown> };
    overrides?: Record<string, unknown>;
    patchedDependencies?: Record<string, unknown>;
  };
  const serverPackageJson = readJson(Path.join(appRoot, "apps/server/package.json")) as {
    version: string;
    dependencies?: Record<string, unknown>;
  };
  const manifest = createRemoteServerInstallManifest({
    serverPackageJson,
    catalog: rootPackageJson.workspaces?.catalog ?? {},
    ...(rootPackageJson.overrides ? { overrides: rootPackageJson.overrides } : {}),
    ...(rootPackageJson.patchedDependencies
      ? { patchedDependencies: rootPackageJson.patchedDependencies }
      : {}),
  });
  return `${JSON.stringify(manifest.packageJson, null, 2)}\n`;
}

function collectDirectory(root: string, prefix: string, entries: RemoteInstallEntry[]): void {
  for (const dirent of FS.readdirSync(root, { withFileTypes: true })) {
    const absolute = Path.join(root, dirent.name);
    const archivePath = `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      collectDirectory(absolute, archivePath, entries);
    } else if (dirent.isFile()) {
      // Source maps are diagnostics for local builds; the remote never needs them.
      if (dirent.name.endsWith(".map")) continue;
      entries.push({ path: archivePath, contents: FS.readFileSync(absolute) });
    }
  }
}

/** Folders of `apps/server/dist` a remote server reads at runtime besides its own bundle. */
const REMOTE_DIST_ASSET_DIRS = ["client", "device-helper"];

/**
 * Everything the remote needs to run the server besides its dependency pack:
 * the remote bundle (`apps/server/dist/remote`, every pure-JavaScript
 * dependency inlined) as `dist/`, the bundled web client and other runtime
 * assets, and the manifest of the few dependencies it keeps external. Reads go
 * through Electron's asar-aware fs, so this works from a packaged app.
 */
export function collectRemoteInstallEntries(appRoot: string): RemoteInstallEntry[] {
  const distDir = Path.join(appRoot, "apps/server/dist");
  const remoteDir = Path.join(distDir, "remote");
  if (!FS.existsSync(Path.join(remoteDir, "index.mjs"))) {
    throw new Error(
      `The Saint remote server bundle is missing at ${remoteDir}. Build apps/server first.`,
    );
  }
  const entries: RemoteInstallEntry[] = [];
  collectDirectory(remoteDir, "dist", entries);
  for (const assetDir of REMOTE_DIST_ASSET_DIRS) {
    const absolute = Path.join(distDir, assetDir);
    if (FS.existsSync(absolute)) collectDirectory(absolute, `dist/${assetDir}`, entries);
  }
  entries.push({
    path: "package.json",
    contents: Buffer.from(loadRemoteInstallPackageJson(appRoot)),
  });
  return entries;
}

function hashEntries(entries: readonly RemoteInstallEntry[]): string {
  const hash = Crypto.createHash("sha256");
  for (const entry of entries.toSorted((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(entry.path).update("\0").update(entry.contents).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * The remote install folder name for this build: the app version plus a hash of
 * the bundle, so a rebuild that keeps the version still installs its own server
 * instead of reusing the one an older build left. Only `[0-9a-f-]` is added, so
 * the name stays a literal in the start script's `pgrep -f` pattern.
 */
export function remoteInstallVersion(
  appVersion: string,
  entries: readonly RemoteInstallEntry[],
): string {
  return `${appVersion}-${hashEntries(entries)}`;
}

/**
 * Names the host's `deps/` folder after the committed pack (the sha256 in its
 * `deps.json`). Builds that change only the bundle keep it, so their versions
 * reuse one unpacked copy.
 */
export function remoteInstallDepsHash(descriptorJson: string): string {
  const descriptor = JSON.parse(descriptorJson) as { sha256?: unknown };
  if (typeof descriptor.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) {
    throw new Error("The remote dependency pack descriptor has no sha256.");
  }
  return descriptor.sha256.slice(0, 12);
}

const TAR_BLOCK = 512;

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

/** Splits a long path into ustar `prefix` + `name`; throws when no split fits. */
function splitUstarPath(path: string): { readonly name: string; readonly prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path is too long for the remote install archive: ${path}`);
}

export function tarHeader(path: string, size: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  const { name, prefix } = splitUstarPath(path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function* tarChunks(entries: readonly RemoteInstallEntry[], mtimeSeconds: number) {
  for (const entry of entries) {
    yield tarHeader(entry.path, entry.contents.length, mtimeSeconds);
    yield entry.contents;
    const padding = (TAR_BLOCK - (entry.contents.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) yield Buffer.alloc(padding, 0);
  }
  yield Buffer.alloc(TAR_BLOCK * 2, 0);
}

/** A gzipped ustar stream of `entries`, readable by GNU tar and bsdtar (`tar -xzf -`). */
export function createTarGzStream(
  entries: readonly RemoteInstallEntry[],
  mtimeSeconds = Math.floor(Date.now() / 1000),
): Readable {
  return Readable.from(tarChunks(entries, mtimeSeconds)).pipe(Zlib.createGzip());
}
