// FILE: scanner-pack.ts
// Purpose: Builds and checks the security-scanner pack: the single-file Go scanners
//          (gitleaks, osv-scanner, trivy, hadolint, nuclei) for every supported host,
//          each verified against a pinned sha256 from the project's own checksum file.
//          Kept apart from the remote dependency pack so it stays off the connect hot path.
//          Read by apps/desktop/src/remoteSshBundle.ts and scripts/build-desktop-artifact.ts.
// Layer: Desktop artifact build helper

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Zlib from "node:zlib";

import {
  assetFor,
  extractExecutable,
  hostParts,
  NUCLEI_TEMPLATES_DIR,
  NUCLEI_TEMPLATES_PIN,
  NUCLEI_TEMPLATES_REPO,
  nucleiTemplatesUrl,
  parseChecksum,
  releaseUrl,
  readTarFiles,
  scannerFileName,
  scannersForHost,
  SCANNER_HOSTS,
  SCANNERS,
  sha256Hex as sha256,
  templatesDigest,
  templatesFromArchive,
  type ScannerHost,
  type ScannerPins,
  type ScannerSpec,
} from "@saint/shared/scannerRelease";

// The release knowledge (hosts, asset names, pins, archive readers) lives in the shared module so
// the server can fetch a tool on first use with the same pins; the pack tests and consumers keep
// importing it from here.
export {
  currentScannerHost,
  extractExecutable,
  NUCLEI_TEMPLATES_DIR,
  parseChecksum,
  readTarFiles,
  scannerDownloadUrls,
  scannerFileName,
  scannersForHost,
  SCANNER_HOSTS,
  SCANNER_NAMES,
  SCANNERS,
  templatesDigest,
  templatesFromArchive,
  type ScannerHost,
  type ScannerPins,
} from "@saint/shared/scannerRelease";

/** Folder of the committed pack and its lock, relative to the repository root. */
export const SCANNER_PACK_DIR = "apps/server/scanner-pack";
export const SCANNER_LOCK_FILE = "scanners.json";
export const SCANNER_PINS_PATH = "packages/shared/src/scannerPins.json";
export const SCANNER_PACK_REBUILD_HINT =
  "Run `bun run scanners:pack -- --update-pins` (review packages/shared/src/scannerPins.json), then `bun run scanners:pack`, and commit apps/server/scanner-pack.";

/**
 * Hosts a remote SSH install can target. The remote install and start scripts are POSIX shell,
 * so a Windows remote is not supported and its tarballs never travel with the remote pack.
 */
export const SCANNER_REMOTE_HOSTS: readonly ScannerHost[] = SCANNER_HOSTS.filter(
  (host) => !host.startsWith("win32-"),
);

/** `scanner-<platform>-<arch>.tar.gz`: the executables at the archive root, mode 0755. */
export function scannerPackFileName(host: string): string {
  return `scanner-${host}.tar.gz`;
}

export interface ScannerExecutableLock {
  /** The executable's file name in the pack: `trivy`, or `trivy.exe` on Windows. */
  readonly file: string;
  readonly asset: string;
  readonly assetSha256: string;
  /** sha256 of the extracted executable. */
  readonly sha256: string;
  readonly size: number;
}

export interface ScannerHostLock {
  /** sha256 and size of `scanner-<host>.tar.gz`. */
  readonly sha256: string;
  readonly size: number;
  readonly executables: Record<string, ScannerExecutableLock>;
}

/** `scanners.json`. */
export interface ScannerLock {
  /** First 12 hex digits identifying the pack content; names the host's cached copy. */
  readonly version: string;
  readonly versions: Record<string, string>;
  readonly hosts: Record<string, ScannerHostLock>;
  readonly templates: { readonly version: string; readonly sha256: string; readonly files: number };
}

export type ScannerFetch = (url: string) => Promise<Buffer>;

export const defaultScannerFetch: ScannerFetch = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readScannerPins(repoRoot: string): ScannerPins {
  return readJson<ScannerPins>(join(repoRoot, SCANNER_PINS_PATH));
}

/** sha256 digests GitHub records for a release's assets (`name -> hex`), when it records them. */
async function githubAssetDigests(
  fetchBytes: ScannerFetch,
  repo: string,
  version: string,
): Promise<Record<string, string>> {
  const release = JSON.parse(
    (await fetchBytes(`https://api.github.com/repos/${repo}/releases/tags/v${version}`)).toString(
      "utf8",
    ),
  ) as { assets?: Array<{ name?: string; digest?: string | null }> };
  const digests: Record<string, string> = {};
  for (const asset of release.assets ?? []) {
    const hex = /^sha256:([0-9a-f]{64})$/u.exec(asset.digest ?? "")?.[1];
    if (asset.name && hex) digests[asset.name] = hex;
  }
  return digests;
}

/**
 * Fills `scannerPins.json` from what the projects publish. Each release asset's sha256
 * comes from the project's own checksum file and must equal the digest GitHub records
 * for the asset (when it records one). The nuclei-templates pin is the digest of the
 * extracted files; its archive must hash to what the project's checksum file lists.
 * Only small files and the one templates archive are fetched; review the diff, then build.
 */
export async function updateScannerPins(
  repoRoot: string,
  fetchBytes: ScannerFetch = defaultScannerFetch,
): Promise<ScannerPins> {
  const pins = readScannerPins(repoRoot);
  for (const spec of SCANNERS) {
    const pin = pins[spec.name];
    if (!pin) throw new Error(`${SCANNER_PINS_PATH} has no entry for ${spec.name}.`);
    const recorded = await githubAssetDigests(fetchBytes, spec.repo, pin.version);
    for (const host of SCANNER_HOSTS) {
      const asset = assetFor(spec, pin.version, host);
      if (!asset) continue;
      const text = (
        await fetchBytes(releaseUrl(spec, pin.version, spec.checksums(pin.version, asset)))
      ).toString("utf8");
      const published = parseChecksum(text, asset);
      if (recorded[asset] && recorded[asset] !== published) {
        throw new Error(
          `${asset}: checksum file says ${published}, GitHub records ${recorded[asset]}.`,
        );
      }
      pin.sha256[host] = published;
    }
  }
  const templates = pins[NUCLEI_TEMPLATES_PIN];
  if (!templates) throw new Error(`${SCANNER_PINS_PATH} has no entry for ${NUCLEI_TEMPLATES_PIN}.`);
  const archive = await fetchBytes(nucleiTemplatesUrl(templates.version));
  const listed = parseChecksum(
    (
      await fetchBytes(
        `https://github.com/${NUCLEI_TEMPLATES_REPO}/releases/download/v${templates.version}/nuclei-templates-${templates.version}_checksums.txt`,
      )
    ).toString("utf8"),
    `nuclei-templates-${templates.version}.tar.gz`,
  );
  if (sha256(archive) !== listed) {
    throw new Error(
      `The nuclei-templates ${templates.version} archive hashes to ${sha256(archive)}, its checksum file lists ${listed}.`,
    );
  }
  templates.sha256.content = templatesDigest(templatesFromArchive(archive));
  writeFileSync(join(repoRoot, SCANNER_PINS_PATH), `${JSON.stringify(pins, null, 2)}\n`);
  return pins;
}

/**
 * Deterministic gzipped ustar of `files`, so rebuilding changes nothing. Files at the
 * archive root are the executables (mode 0755); files in folders are data (0644).
 */
export function createScannerTarGz(files: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, contents] of Object.entries(files).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const header = Buffer.alloc(512, 0);
    const octal = (offset: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    // ustar splits a path longer than 100 bytes into prefix and name at a "/".
    let split = { prefix: "", name };
    if (Buffer.byteLength(name) > 100) {
      const at = [...name.matchAll(/\//gu)]
        .map((match) => match.index!)
        .find(
          (index) =>
            Buffer.byteLength(name.slice(0, index)) <= 155 &&
            Buffer.byteLength(name.slice(index + 1)) <= 100,
        );
      if (at === undefined) throw new Error(`Path is too long for the scanner pack: ${name}`);
      split = { prefix: name.slice(0, at), name: name.slice(at + 1) };
    }
    header.write(split.name, 0, 100, "utf8");
    header.write(split.prefix, 345, 155, "utf8");
    octal(100, 8, name.includes("/") ? 0o644 : 0o755);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, contents.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

// --- build and check ---

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

/** Identity of the pack content: the executables' own hashes, not the tarballs'. */
function packVersion(hosts: Record<string, ScannerHostLock>, templates: string): string {
  const content: Record<string, Record<string, string> | string> = { templates };
  for (const [host, lock] of Object.entries(hosts)) {
    content[host] = Object.fromEntries(
      Object.entries(lock.executables).map(([name, executable]) => [name, executable.sha256]),
    );
  }
  return sha256(stableJson(content)).slice(0, 12);
}

function requirePin(pins: ScannerPins, spec: ScannerSpec, host: string) {
  const pin = pins[spec.name];
  const pinned = pin?.sha256[host];
  if (!pin || !pinned || !/^[0-9a-f]{64}$/u.test(pinned)) {
    throw new Error(
      `${SCANNER_PINS_PATH} has no sha256 for ${spec.name} on ${host}. ${SCANNER_PACK_REBUILD_HINT}`,
    );
  }
  return { version: pin.version, pinned };
}

/**
 * Downloads every scanner for the given `hosts` (default: all of them), checks each against
 * its pinned sha256, keeps only the one executable, and writes `scanner-<host>.tar.gz` and
 * `scanners.json` into `outDir`. Only the listed hosts' binaries are fetched. Any mismatch
 * aborts before anything is written.
 */
export async function buildScannerPack(
  repoRoot: string,
  outDir: string,
  options: {
    readonly fetch?: ScannerFetch;
    readonly log?: (message: string) => void;
    readonly hosts?: readonly ScannerHost[];
  } = {},
): Promise<ScannerLock> {
  const buildHosts = options.hosts ?? SCANNER_HOSTS;
  const fetchBytes = options.fetch ?? defaultScannerFetch;
  const pins = readScannerPins(repoRoot);
  const hosts: Record<string, ScannerHostLock> = {};
  const tarballs: Record<string, Buffer> = {};
  const templatesPin = pins[NUCLEI_TEMPLATES_PIN];
  const pinnedTemplates = templatesPin?.sha256.content;
  if (!templatesPin || !pinnedTemplates || !/^[0-9a-f]{64}$/u.test(pinnedTemplates)) {
    throw new Error(
      `${SCANNER_PINS_PATH} has no content digest for ${NUCLEI_TEMPLATES_PIN}. ${SCANNER_PACK_REBUILD_HINT}`,
    );
  }
  options.log?.(`${NUCLEI_TEMPLATES_PIN} ${templatesPin.version}`);
  const templates = templatesFromArchive(
    await fetchBytes(nucleiTemplatesUrl(templatesPin.version)),
  );
  const templatesSha = templatesDigest(templates);
  if (templatesSha !== pinnedTemplates) {
    throw new Error(
      `${NUCLEI_TEMPLATES_PIN} digest is ${templatesSha}, pinned ${pinnedTemplates}. Nothing was written.`,
    );
  }
  for (const host of buildHosts) {
    const files: Record<string, Buffer> = {};
    const executables: Record<string, ScannerExecutableLock> = {};
    const { os } = hostParts(host);
    for (const spec of scannersForHost(host)) {
      const { version, pinned } = requirePin(pins, spec, host);
      const asset = assetFor(spec, version, host)!;
      options.log?.(`${host} ${spec.name} ${version}`);
      const bytes = await fetchBytes(releaseUrl(spec, version, asset));
      const actual = sha256(bytes);
      if (actual !== pinned) {
        throw new Error(`${asset} sha256 is ${actual}, pinned ${pinned}. Nothing was written.`);
      }
      const file = scannerFileName(spec.name, host);
      const executable = extractExecutable(spec.kind(os), bytes, file);
      files[file] = executable;
      executables[spec.name] = {
        file,
        asset,
        assetSha256: actual,
        sha256: sha256(executable),
        size: executable.length,
      };
    }
    // The templates only serve nuclei, so a host without it carries none.
    const tarball = createScannerTarGz({ ...files, ...(executables.nuclei ? templates : {}) });
    tarballs[host] = tarball;
    hosts[host] = { sha256: sha256(tarball), size: tarball.length, executables };
  }
  const lock: ScannerLock = {
    version: packVersion(hosts, templatesSha),
    versions: Object.fromEntries(SCANNERS.map((spec) => [spec.name, pins[spec.name]!.version])),
    hosts,
    templates: {
      version: templatesPin.version,
      sha256: templatesSha,
      files: Object.keys(templates).length,
    },
  };
  mkdirSync(outDir, { recursive: true });
  for (const host of buildHosts) {
    writeFileSync(join(outDir, scannerPackFileName(host)), tarballs[host]!);
  }
  writeFileSync(join(outDir, SCANNER_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/**
 * Problems with the committed pack in `packDir` (default: the repository's): a
 * missing file, pins that changed since the build, or a tarball that no longer
 * matches the lock. Empty when the pack is current. Checks `hosts` (default: all of them).
 */
export function checkScannerPack(
  repoRoot: string,
  packDir = join(repoRoot, SCANNER_PACK_DIR),
  hosts: readonly ScannerHost[] = SCANNER_HOSTS,
) {
  const lockPath = join(packDir, SCANNER_LOCK_FILE);
  if (!existsSync(lockPath)) return [`${SCANNER_PACK_DIR}/${SCANNER_LOCK_FILE} is missing.`];
  const lock = readJson<ScannerLock>(lockPath);
  const pins = readScannerPins(repoRoot);
  const problems: string[] = [];
  for (const spec of SCANNERS) {
    const pin = pins[spec.name];
    if (lock.versions[spec.name] !== pin?.version) {
      problems.push(
        `${spec.name} is ${pin?.version} in ${SCANNER_PINS_PATH} but ${lock.versions[spec.name]} in the pack.`,
      );
    }
    for (const host of hosts) {
      if (!scannersForHost(host).includes(spec)) continue;
      const pinned = pin?.sha256[host];
      const locked = lock.hosts[host]?.executables[spec.name]?.assetSha256;
      if (!pinned) problems.push(`${spec.name} has no pinned sha256 for ${host}.`);
      else if (locked !== pinned) problems.push(`${spec.name} on ${host} differs from its pin.`);
    }
  }
  const templatesPin = pins[NUCLEI_TEMPLATES_PIN];
  if (!templatesPin?.sha256.content) {
    problems.push(`${NUCLEI_TEMPLATES_PIN} has no pinned content digest.`);
  } else if (
    lock.templates?.version !== templatesPin.version ||
    lock.templates.sha256 !== templatesPin.sha256.content
  ) {
    problems.push(`${NUCLEI_TEMPLATES_PIN} differs from its pin.`);
  }
  for (const host of hosts) {
    const tarballPath = join(packDir, scannerPackFileName(host));
    if (!existsSync(tarballPath)) {
      problems.push(`${scannerPackFileName(host)} is missing.`);
    } else if (sha256(readFileSync(tarballPath)) !== lock.hosts[host]?.sha256) {
      problems.push(`${scannerPackFileName(host)} sha256 differs from ${SCANNER_LOCK_FILE}.`);
    }
  }
  if (lock.hosts && packVersion(lock.hosts, lock.templates?.sha256 ?? "") !== lock.version) {
    problems.push(`${SCANNER_LOCK_FILE} version does not match its content.`);
  }
  return problems;
}

/** Hosts whose executables a desktop build for `platform`/`arch` runs itself. */
export function scannerHostsForBuild(
  platform: "linux" | "mac" | "win",
  arch: "arm64" | "x64" | "universal",
): ScannerHost[] {
  const os = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return (arch === "universal" ? (["arm64", "x64"] as const) : [arch]).map(
    (a) => `${os}-${a}` as const,
  );
}

/**
 * Every file of the pack for `host` (executables at the root, templates under
 * `nuclei-templates/`), ready to write into an app folder.
 */
export function readScannerPackFiles(packDir: string, host: string): Record<string, Buffer> {
  const files = readTarFiles(readFileSync(join(packDir, scannerPackFileName(host))));
  const expected = scannersForHost(host);
  for (const spec of expected) {
    const file = scannerFileName(spec.name, host);
    if (!files[file]?.length) throw new Error(`${file} is not in ${scannerPackFileName(host)}.`);
  }
  const wantsTemplates = expected.some((spec) => spec.name === "nuclei");
  if (
    wantsTemplates &&
    !Object.keys(files).some((path) => path.startsWith(`${NUCLEI_TEMPLATES_DIR}/`))
  ) {
    throw new Error(`${NUCLEI_TEMPLATES_DIR} is not in ${scannerPackFileName(host)}.`);
  }
  return files;
}
