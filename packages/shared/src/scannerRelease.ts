// FILE: scannerRelease.ts
// Purpose: What Saint knows about the security scanners' official releases: the supported hosts,
//          each tool's release asset and checksum names, the pinned versions and sha256s, and
//          readers for the archives they ship in. Used by the scanner-pack build script and by the
//          server, which fetches a tool the first time it is needed.
// Layer: Shared (pure, node only)
// Exports: SCANNER_HOSTS, SCANNERS, SCANNER_PINS, currentScannerHost, scannerDownloadUrls,
//          extractExecutable, templatesFromArchive, templatesDigest, parseChecksum, ...

import { createHash } from "node:crypto";
import * as Zlib from "node:zlib";

import scannerPins from "./scannerPins.json" with { type: "json" };

export const sha256Hex = (contents: Buffer | string): string =>
  createHash("sha256").update(contents).digest("hex");

// Node's `<process.platform>-<process.arch>`, which is also the folder name the app and the
// server look for, so Windows is `win32-*`.
export const SCANNER_HOSTS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type ScannerHost = (typeof SCANNER_HOSTS)[number];

/**
 * The pack host of the machine running the build (`<process.platform>-<process.arch>`), so a
 * build fetches only the binaries this machine uses. Throws when no pack exists for it.
 */
export function currentScannerHost(
  platform: string = process.platform,
  arch: string = process.arch,
): ScannerHost {
  const host = `${platform}-${arch}`;
  const known = SCANNER_HOSTS.find((candidate) => candidate === host);
  if (!known) {
    throw new Error(
      `No scanner pack for ${host}. Supported hosts: ${SCANNER_HOSTS.join(", ")}; pass --host=<host> to pick one.`,
    );
  }
  return known;
}

export interface ScannerSpec {
  /** Scanner name; the executable is `<name>`, or `<name>.exe` on Windows. */
  readonly name: string;
  readonly repo: string;
  /** How the release ships the executable on `os`. */
  readonly kind: (os: string) => "tar.gz" | "zip" | "raw";
  /** The release asset for a host, or null when the project publishes none for it. */
  readonly asset: (version: string, os: string, arch: string) => string | null;
  /** The release file holding this asset's sha256. */
  readonly checksums: (version: string, asset: string) => string;
}

const goArch = (arch: string) => (arch === "x64" ? "amd64" : "arm64");
const isWindows = (os: string) => os === "win32";

// Asset names were checked against the GitHub release listings of the pinned versions
// (names only), Windows ones included; a renamed asset in a later version fails with a 404,
// fix the entry here. Where a project ships no Windows arm64 build the asset is null, the
// host's pack simply lacks that scanner, and the runner reports it as unavailable.
export const SCANNERS: readonly ScannerSpec[] = [
  {
    name: "gitleaks",
    repo: "gitleaks/gitleaks",
    kind: (os) => (isWindows(os) ? "zip" : "tar.gz"),
    asset: (v, os, arch) =>
      `gitleaks_${v}_${isWindows(os) ? "windows" : os}_${arch}.${isWindows(os) ? "zip" : "tar.gz"}`,
    checksums: (v) => `gitleaks_${v}_checksums.txt`,
  },
  {
    name: "osv-scanner",
    repo: "google/osv-scanner",
    kind: () => "raw",
    asset: (_v, os, arch) =>
      `osv-scanner_${isWindows(os) ? "windows" : os}_${goArch(arch)}${isWindows(os) ? ".exe" : ""}`,
    checksums: () => "osv-scanner_SHA256SUMS",
  },
  {
    name: "trivy",
    repo: "aquasecurity/trivy",
    kind: (os) => (isWindows(os) ? "zip" : "tar.gz"),
    asset: (v, os, arch) => {
      if (isWindows(os)) return arch === "x64" ? `trivy_${v}_windows-64bit.zip` : null;
      return `trivy_${v}_${os === "darwin" ? "macOS" : "Linux"}-${arch === "x64" ? "64bit" : "ARM64"}.tar.gz`;
    },
    checksums: (v) => `trivy_${v}_checksums.txt`,
  },
  {
    name: "hadolint",
    repo: "hadolint/hadolint",
    kind: () => "raw",
    asset: (_v, os, arch) => {
      if (isWindows(os)) return arch === "x64" ? "hadolint-windows-x86_64.exe" : null;
      return `hadolint-${os === "darwin" ? "macos" : "linux"}-${arch === "x64" ? "x86_64" : "arm64"}`;
    },
    // One file for all hosts since 2.15 (`<hash> *<asset>` lines); 2.14 had `<asset>.sha256`.
    checksums: () => "checksums.sha256",
  },
  {
    name: "nuclei",
    repo: "projectdiscovery/nuclei",
    kind: () => "zip",
    asset: (v, os, arch) => {
      if (isWindows(os)) return arch === "x64" ? `nuclei_${v}_windows_amd64.zip` : null;
      return `nuclei_${v}_${os === "darwin" ? "macOS" : "linux"}_${goArch(arch)}.zip`;
    },
    checksums: (v) => `nuclei_${v}_checksums.txt`,
  },
];

/** The file name of scanner `name` on `host`: `trivy`, or `trivy.exe` on Windows. */
export function scannerFileName(name: string, host: string): string {
  return host.startsWith("win32-") ? `${name}.exe` : name;
}

/** The scanners a host's pack holds: every one the projects publish a build of for it. */
export function scannersForHost(host: string): readonly ScannerSpec[] {
  const { os, arch } = hostParts(host);
  return SCANNERS.filter((spec) => spec.asset("0", os, arch) !== null);
}

export const SCANNER_NAMES: readonly string[] = SCANNERS.map((scanner) => scanner.name);

/**
 * nuclei finds no templates on its own (the runner never lets it download any), so the
 * pack carries a pinned release of projectdiscovery/nuclei-templates next to the
 * executable, as `nuclei-templates/` in every host's folder. The project publishes no
 * checksum for it and GitHub's tag archives are not byte-stable, so the pin is a digest
 * of the extracted template files (`sha256.content`), not of the archive.
 */
export const NUCLEI_TEMPLATES_DIR = "nuclei-templates";
export const NUCLEI_TEMPLATES_PIN = "nuclei-templates";
export const NUCLEI_TEMPLATES_REPO = "projectdiscovery/nuclei-templates";
export const nucleiTemplatesUrl = (version: string) =>
  `https://github.com/${NUCLEI_TEMPLATES_REPO}/archive/refs/tags/v${version}.tar.gz`;
export const TEMPLATE_EXTENSIONS = /\.(?:ya?ml|json|txt)$/u;

/** `scanner name -> { version, sha256 per host of the downloaded release asset }`. */
export type ScannerPins = Record<string, { version: string; sha256: Record<string, string> }>;

export function hostParts(host: string): { os: string; arch: string } {
  const [os, arch] = host.split("-");
  if (!os || !arch) throw new Error(`Unsupported scanner host: ${host}`);
  return { os, arch };
}

export function releaseUrl(spec: ScannerSpec, version: string, file: string): string {
  return `https://github.com/${spec.repo}/releases/download/v${version}/${file}`;
}

export function assetFor(spec: ScannerSpec, version: string, host: string): string | null {
  const { os, arch } = hostParts(host);
  return spec.asset(version, os, arch);
}

/** The release asset and checksum file URLs of scanner `name` for `host`. */
export function scannerDownloadUrls(name: string, version: string, host: string) {
  const spec = SCANNERS.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`Unknown scanner: ${name}`);
  const asset = assetFor(spec, version, host);
  if (!asset) throw new Error(`${name} publishes no build for ${host}.`);
  return {
    asset: releaseUrl(spec, version, asset),
    checksums: releaseUrl(spec, version, spec.checksums(version, asset)),
  };
}

/** The sha256 a project's checksum file records for `asset` (`<hex>  <name>` lines, or a bare hash). */
export function parseChecksum(text: string, asset: string): string {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const [hash, name] = line.trim().split(/\s+/u);
    if (
      hash &&
      /^[0-9a-f]{64}$/iu.test(hash) &&
      name?.replace(/^\*/u, "").split("/").pop() === asset
    ) {
      return hash.toLowerCase();
    }
  }
  const only = lines.length === 1 ? lines[0]?.trim().split(/\s+/u) : undefined;
  if (only?.length === 1 && /^[0-9a-f]{64}$/iu.test(only[0] ?? "")) return only[0]!.toLowerCase();
  throw new Error(`No sha256 for ${asset} in its checksum file.`);
}

// --- archive handling (node only, so neither build nor tests need tar or unzip) ---

export interface TarEntry {
  readonly path: string;
  readonly type: string;
  readonly data: Buffer;
}

export function* tarEntries(tarball: Buffer): Generator<TarEntry> {
  const tar = Zlib.gunzipSync(tarball);
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header.toString("utf8", start, start + length).split("\0")[0] ?? "";
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const start = offset + 512;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // PAX extended header for the next entry; only a long `path` matters here.
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(data.toString("utf8"))?.[1];
      continue;
    }
    if (type === "g") continue;
    const path = paxPath ?? (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
    paxPath = undefined;
    yield { path: path.replace(/^\.\//u, ""), type, data };
  }
}

export function readTarEntry(tarball: Buffer, wanted: string): Buffer | null {
  for (const entry of tarEntries(tarball)) {
    if ((entry.type === "0" || entry.type === "") && entry.path === wanted) {
      return Buffer.from(entry.data);
    }
  }
  return null;
}

/** Every regular file of a gzipped tar, by archive path. */
export function readTarFiles(tarball: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of tarEntries(tarball)) {
    if (entry.type === "0" || entry.type === "") files[entry.path] = Buffer.from(entry.data);
  }
  return files;
}

/**
 * The nuclei templates of a nuclei-templates release archive, keyed
 * `nuclei-templates/<path>`: template, payload and workflow files only, nothing from
 * hidden folders (`.github`) or the documentation.
 */
export function templatesFromArchive(archive: Buffer): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const [path, contents] of Object.entries(readTarFiles(archive))) {
    const relative = path.split("/").slice(1);
    if (relative.length < 2 || relative.some((part) => part.startsWith("."))) continue;
    if (!TEMPLATE_EXTENSIONS.test(relative.at(-1)!)) continue;
    files[`${NUCLEI_TEMPLATES_DIR}/${relative.join("/")}`] = contents;
  }
  if (Object.keys(files).length === 0) throw new Error("The nuclei-templates archive is empty.");
  return files;
}

/** Digest of template paths and contents; independent of how the archive was packed. */
export function templatesDigest(files: Record<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).toSorted()) {
    hash.update(`${path}\0${sha256Hex(files[path]!)}\n`);
  }
  return hash.digest("hex");
}

export function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("Not a zip archive.");
  let offset = zip.readUInt32LE(end + 16);
  for (let count = zip.readUInt16LE(end + 10); count > 0; count -= 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataStart, dataStart + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return Zlib.inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}.`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** The executable `name` out of a release asset (archive root only, nothing else is read). */
export function extractExecutable(
  kind: ReturnType<ScannerSpec["kind"]>,
  bytes: Buffer,
  name: string,
): Buffer {
  const found =
    kind === "raw" ? bytes : kind === "zip" ? readZipEntry(bytes, name) : readTarEntry(bytes, name);
  if (!found || found.length === 0) throw new Error(`${name} is not in its release archive.`);
  return found;
}

/** The versions and sha256s this build pins (`scannerPins.json`). */
export const SCANNER_PINS: ScannerPins = scannerPins;
