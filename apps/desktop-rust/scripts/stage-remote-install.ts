#!/usr/bin/env bun
// FILE: stage-remote-install.ts
// Purpose: Stages what the desktop uploads to a Remote SSH host into
//          `apps/desktop-rust/resources/remote-install/`: the server bundle as a gzipped tar,
//          the committed dependency pack, and `identity.json` (install version and hashes).
//          The Rust side only streams these files; it builds no archive or hash itself.
// Layer: Build / Packaging script (ported from the Electron `remoteSshBundle.ts`)

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Zlib from "node:zlib";

import { createRemoteServerInstallManifest } from "@saint/shared/remoteServerInstall";
import { hashRemoteTreeEntries, REMOTE_TREE_HASH_SCRIPT } from "@saint/shared/remoteTreeHash";

interface Entry {
  readonly path: string;
  readonly contents: Buffer;
}

const repoRoot = Path.resolve(import.meta.dirname, "../../..");
const distDir = Path.join(repoRoot, "apps/server/dist");
const depsDir = Path.join(repoRoot, "apps/server/remote-deps");
const outDir = Path.join(repoRoot, "apps/desktop-rust/resources/remote-install");

const readJson = (path: string) => JSON.parse(FS.readFileSync(path, "utf8"));

function manifestJson(): string {
  const root = readJson(Path.join(repoRoot, "package.json"));
  const manifest = createRemoteServerInstallManifest({
    serverPackageJson: readJson(Path.join(repoRoot, "apps/server/package.json")),
    catalog: root.workspaces?.catalog ?? {},
    ...(root.overrides ? { overrides: root.overrides } : {}),
    ...(root.patchedDependencies ? { patchedDependencies: root.patchedDependencies } : {}),
  });
  return `${JSON.stringify(manifest.packageJson, null, 2)}\n`;
}

function collect(dir: string, prefix: string, entries: Entry[]): void {
  for (const dirent of FS.readdirSync(dir, { withFileTypes: true })) {
    const abs = Path.join(dir, dirent.name);
    const path = `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) collect(abs, path, entries);
    else if (dirent.isFile() && !dirent.name.endsWith(".map")) {
      entries.push({ path, contents: FS.readFileSync(abs) });
    }
  }
}

function tarHeader(path: string, size: number, mtime: number): Buffer {
  const header = Buffer.alloc(512, 0);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const cut = [...path.matchAll(/\//gu)]
      .map((m) => m.index)
      .find(
        (i) =>
          Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100,
      );
    if (cut === undefined)
      throw new Error(`Path is too long for the remote install archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const octal = (offset: number, length: number, value: number) =>
    header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  header.write(name, 0, 100, "utf8");
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, mtime);
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

function tarGz(entries: readonly Entry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry.path, entry.contents.length, mtime), entry.contents);
    const pad = (512 - (entry.contents.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Zlib.gzipSync(Buffer.concat(chunks));
}

const remoteDir = Path.join(distDir, "remote");
if (!FS.existsSync(Path.join(remoteDir, "index.mjs"))) {
  // `dev` passes --optional so a checkout without a server build still starts; connecting a
  // remote host then reports the missing bundle.
  if (process.argv.includes("--optional")) {
    console.warn(`[remote-install] skipped: no remote server bundle at ${remoteDir}`);
    process.exit(0);
  }
  throw new Error(
    `The remote server bundle is missing at ${remoteDir}. Run \`bun run --cwd apps/server build\` first.`,
  );
}
const entries: Entry[] = [];
collect(remoteDir, "dist", entries);
for (const asset of ["client", "device-helper"]) {
  const abs = Path.join(distDir, asset);
  if (FS.existsSync(abs)) collect(abs, `dist/${asset}`, entries);
}
entries.push({ path: "package.json", contents: Buffer.from(manifestJson()) });

const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : 1));
const bundleHash = Crypto.createHash("sha256");
for (const entry of sorted)
  bundleHash.update(entry.path).update("\0").update(entry.contents).update("\0");

const descriptor = readJson(Path.join(depsDir, "deps.json"));
if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256 ?? "")) throw new Error("deps.json has no sha256.");
const depsTrees = Object.fromEntries(
  Object.entries(descriptor.trees ?? {}).filter(
    ([, t]) => typeof t === "string" && /^[0-9a-f]{64}$/u.test(t),
  ),
);
const appVersion = readJson(Path.join(repoRoot, "apps/desktop-rust/tauri.conf.json")).version;

FS.rmSync(outDir, { recursive: true, force: true });
FS.mkdirSync(outDir, { recursive: true });
FS.writeFileSync(Path.join(outDir, "bundle.tar.gz"), tarGz(entries));
FS.copyFileSync(Path.join(depsDir, "deps.tar.gz"), Path.join(outDir, "deps.tar.gz"));
const identity = {
  version: `${appVersion}-${bundleHash.digest("hex").slice(0, 12)}`,
  depsHash: descriptor.sha256.slice(0, 12),
  bundleTree: hashRemoteTreeEntries(entries),
  depsTrees,
  // The host runs this to verify a shared install; shipped here so Rust keeps no copy.
  treeHashScript: REMOTE_TREE_HASH_SCRIPT,
};
FS.writeFileSync(Path.join(outDir, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
console.log(`[remote-install] staged ${identity.version} (${entries.length} files) in ${outDir}`);
