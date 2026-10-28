// FILE: remoteSshBundle.ts
// Purpose: Packs the server bundle the desktop already ships, plus an npm manifest and the
//          dependency patches, into a gzipped tar stream for upload to a remote SSH host.
// Layer: Desktop remote SSH utility
// Exports: loadRemoteInstallManifest, collectRemoteInstallEntries, remoteInstallVersion,
//          remoteInstallDepsHash, createTarGzStream

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable } from "node:stream";
import * as Zlib from "node:zlib";

import {
  createRemoteServerInstallManifest,
  remoteServerPatchIndex,
  type RemoteServerPatch,
} from "@saint/shared/remoteServerInstall";

/**
 * Folder the desktop artifact build stages next to `apps/server/dist` with the
 * resolved `package.json` and `patches/` of the dependencies the remote
 * bundle keeps external. Source checkouts have no such folder
 * and derive the same content from the workspace manifests instead.
 */
export const REMOTE_INSTALL_STAGE_DIR = "apps/server/remote-install";

/**
 * Gzipped `node_modules` of the remote dependencies, with node-pty binaries for
 * macOS and Linux on arm64 and x64, that the desktop build stages next to the
 * manifest (scripts/lib/remote-deps-pack.ts). Hosts without npm unpack it instead.
 */
export const REMOTE_DEPS_PACK_FILE = "deps.tar.gz";

export function remoteDepsPackPath(appRoot: string): string {
  return Path.join(appRoot, REMOTE_INSTALL_STAGE_DIR, REMOTE_DEPS_PACK_FILE);
}

export interface RemoteInstallEntry {
  /** Path inside the archive, `/`-separated. */
  readonly path: string;
  readonly contents: Buffer;
}

interface RemoteInstallManifestFiles {
  readonly packageJson: string;
  readonly patches: ReadonlyArray<{ readonly fileName: string; readonly contents: Buffer }>;
  readonly patchIndex: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(FS.readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** The npm manifest and patches for this build, staged (packaged app) or derived (checkout). */
export function loadRemoteInstallManifest(appRoot: string): RemoteInstallManifestFiles {
  const stagedDir = Path.join(appRoot, REMOTE_INSTALL_STAGE_DIR);
  if (FS.existsSync(Path.join(stagedDir, "package.json"))) {
    const patchesDir = Path.join(stagedDir, "patches");
    const patchIndex = FS.existsSync(Path.join(patchesDir, "index.tsv"))
      ? FS.readFileSync(Path.join(patchesDir, "index.tsv"), "utf8")
      : "";
    const patches = patchIndex
      .split("\n")
      .map((line) => line.split("\t")[1]?.trim())
      .filter((fileName): fileName is string => Boolean(fileName))
      .map((fileName) => ({
        fileName,
        contents: FS.readFileSync(Path.join(patchesDir, fileName)),
      }));
    return {
      packageJson: FS.readFileSync(Path.join(stagedDir, "package.json"), "utf8"),
      patches,
      patchIndex,
    };
  }

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
  return {
    packageJson: `${JSON.stringify(manifest.packageJson, null, 2)}\n`,
    patches: manifest.patches.map((patch: RemoteServerPatch) => ({
      fileName: patch.fileName,
      contents: FS.readFileSync(Path.join(appRoot, patch.patchPath)),
    })),
    patchIndex: remoteServerPatchIndex(manifest.patches),
  };
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
 * Everything the remote needs to install and run the server: the remote bundle
 * (`apps/server/dist/remote`, every pure-JavaScript dependency inlined) as
 * `dist/`, the bundled web client and other runtime assets, and the npm
 * manifest and `patches/` for the few dependencies it keeps external. Reads go
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
  const manifest = loadRemoteInstallManifest(appRoot);
  const entries: RemoteInstallEntry[] = [];
  collectDirectory(remoteDir, "dist", entries);
  for (const assetDir of REMOTE_DIST_ASSET_DIRS) {
    const absolute = Path.join(distDir, assetDir);
    if (FS.existsSync(absolute)) collectDirectory(absolute, `dist/${assetDir}`, entries);
  }
  entries.push({ path: "package.json", contents: Buffer.from(manifest.packageJson) });
  entries.push({ path: "patches/index.tsv", contents: Buffer.from(manifest.patchIndex) });
  for (const patch of manifest.patches) {
    entries.push({ path: `patches/${patch.fileName}`, contents: patch.contents });
  }
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
 * Hash of what the host installs with npm (the manifest and its patches). Builds
 * that change only the bundle keep it, so their versions reuse one `deps/`
 * install instead of running npm again.
 */
export function remoteInstallDepsHash(entries: readonly RemoteInstallEntry[]): string {
  return hashEntries(
    entries.filter((entry) => entry.path === "package.json" || entry.path.startsWith("patches/")),
  );
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
