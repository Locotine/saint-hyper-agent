// FILE: install.ts
// Purpose: Fetches a scanner the first time it is needed: downloads the pinned official release
//          asset, checks it against the pinned sha256, and keeps the one executable in a cache
//          folder on this machine. Nothing ships in the app or the repository; a remote host
//          fetches only what it runs. Templates for nuclei are fetched the same way.
// Layer: Server cyber security scanners
// Exports: installTool, installNucleiTemplates, installAttention, installedToolDir,
//          installedTemplatesDir, isOfficialDownloadUrl, downloadOfficial, InstallResult, DownloadBytes

import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  currentScannerHost,
  extractExecutable,
  NUCLEI_TEMPLATES_PIN,
  nucleiTemplatesUrl,
  scannerDownloadUrls,
  scannerFileName,
  scannersForHost,
  SCANNER_PINS,
  SCANNERS as RELEASES,
  sha256Hex,
  templatesDigest,
  templatesFromArchive,
  type ScannerPins,
} from "@saint/shared/scannerRelease";

export type DownloadBytes = (url: string) => Promise<Buffer>;

export type InstallResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      /** `unsupported`: no build for this host; `download`: the fetch failed; `checksum`: it did
       *  not match the pin and was discarded; `write`: the cache folder is not writable. */
      readonly kind: "unsupported" | "download" | "checksum" | "write";
      readonly message: string;
    };

const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_REDIRECTS = 5;

/** Only GitHub's own hosts: the release page and the CDN it redirects to. */
export function isOfficialDownloadUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "github.com" ||
    host === "codeload.github.com" ||
    host.endsWith(".githubusercontent.com")
  );
}

/** Downloads one official URL, following redirects only between official hosts. */
export const downloadOfficial: DownloadBytes = async (start) => {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isOfficialDownloadUrl(url))
      throw new Error(`Refusing to download from ${new URL(url).host}.`);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new Error(`Redirect from ${new URL(url).host} without a location.`);
      url = new URL(next, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`GET ${new URL(url).host} failed: ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) throw new Error("The download is larger than expected.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("The download is larger than expected.");
    return bytes;
  }
  throw new Error("Too many redirects.");
};

/** `<cache>/<tool>-<pinned version>`: where an installed tool's executable lives. */
export const installedToolDir = (
  cacheDir: string,
  name: string,
  pins: ScannerPins = SCANNER_PINS,
) => path.join(cacheDir, `${name}-${pins[name]?.version ?? "unpinned"}`);

/** `<cache>/nuclei-templates-<pinned version>`: the templates folder `nuclei -t` reads. */
export const installedTemplatesDir = (cacheDir: string, pins: ScannerPins = SCANNER_PINS) =>
  path.join(
    cacheDir,
    `${NUCLEI_TEMPLATES_PIN}-${pins[NUCLEI_TEMPLATES_PIN]?.version ?? "unpinned"}`,
  );

/** What the person has to do when a fetch or write failed in a way only they can fix. */
export function installAttention(
  label: string,
  failure: Extract<InstallResult, { ok: false }>,
  toolsDir: string,
): string {
  return failure.kind === "write"
    ? `Could not save ${label} under ${toolsDir}: ${failure.message} Free space or fix the folder's permissions, or install ${label} and put it on PATH.`
    : `Could not download ${label} (${failure.message}). This machine must be able to reach github.com; allow it, or install ${label} and put it on PATH.`;
}

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;

const reason = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Runs one install per key at a time, so two scans never download the same tool twice. */
const inFlight = new Map<string, Promise<InstallResult>>();
function once(key: string, work: () => Promise<InstallResult>): Promise<InstallResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = work().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

/** Writes `build` into a private folder next to `finalDir`, then renames it into place. */
async function publish(
  finalDir: string,
  build: (workDir: string) => Promise<void>,
): Promise<InstallResult | null> {
  const parent = path.dirname(finalDir);
  const workDir = path.join(parent, `.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    await mkdir(workDir, { recursive: true });
    await build(workDir);
    await rm(finalDir, { recursive: true, force: true });
    await rename(workDir, finalDir);
    return null;
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      kind: "write",
      message: `Could not write to ${parent}${errorCode(error) ? ` (${errorCode(error)})` : ""}: ${reason(error)}`,
    };
  }
}

/**
 * Makes sure scanner `name` is installed under `cacheDir` and returns its executable. An existing
 * install is reused. The asset must hash to the sha256 pinned for this host, so a changed or
 * tampered release is discarded rather than run.
 */
export function installTool(
  name: string,
  input: {
    readonly cacheDir: string;
    readonly download?: DownloadBytes;
    readonly host?: string;
    readonly pins?: ScannerPins;
  },
): Promise<InstallResult> {
  const host = input.host ?? currentScannerHost();
  const pins = input.pins ?? SCANNER_PINS;
  const dir = installedToolDir(input.cacheDir, name, pins);
  const file = scannerFileName(name, host);
  const target = path.join(dir, file);
  return once(`${input.cacheDir}|${host}|${name}`, async () => {
    if ((await stat(target).catch(() => null))?.isFile()) return { ok: true, path: target };
    const pin = pins[name];
    const spec = RELEASES.find((candidate) => candidate.name === name);
    if (!pin || !spec || !scannersForHost(host).some((candidate) => candidate.name === name)) {
      return { ok: false, kind: "unsupported", message: `${name} publishes no build for ${host}.` };
    }
    const expected = pin.sha256[host];
    if (!expected) {
      return {
        ok: false,
        kind: "unsupported",
        message: `${name} has no pinned checksum for ${host}.`,
      };
    }
    let bytes: Buffer;
    try {
      bytes = await (input.download ?? downloadOfficial)(
        scannerDownloadUrls(name, pin.version, host).asset,
      );
    } catch (error) {
      return { ok: false, kind: "download", message: reason(error) };
    }
    if (sha256Hex(bytes) !== expected) {
      return {
        ok: false,
        kind: "checksum",
        message: `The downloaded ${name} does not match its pinned checksum and was discarded.`,
      };
    }
    let executable: Buffer;
    try {
      executable = extractExecutable(spec.kind(host.split("-")[0] ?? ""), bytes, file);
    } catch (error) {
      return { ok: false, kind: "checksum", message: reason(error) };
    }
    const failed = await publish(dir, async (workDir) => {
      await writeFile(path.join(workDir, file), executable, { mode: 0o755 });
      if (process.platform !== "win32") await chmod(path.join(workDir, file), 0o755);
    });
    return failed ?? { ok: true, path: target };
  });
}

/**
 * Makes sure the pinned nuclei templates are installed under `cacheDir` and returns their folder.
 * The archive is checked by the digest of the extracted files, as the pack build does.
 */
export function installNucleiTemplates(input: {
  readonly cacheDir: string;
  readonly download?: DownloadBytes;
  readonly pins?: ScannerPins;
}): Promise<InstallResult> {
  const pins = input.pins ?? SCANNER_PINS;
  const dir = installedTemplatesDir(input.cacheDir, pins);
  return once(`${input.cacheDir}|templates`, async () => {
    if ((await stat(dir).catch(() => null))?.isDirectory()) return { ok: true, path: dir };
    const pin = pins[NUCLEI_TEMPLATES_PIN];
    const expected = pin?.sha256.content;
    if (!pin || !expected) {
      return { ok: false, kind: "unsupported", message: "The nuclei templates are not pinned." };
    }
    let files: Record<string, Buffer>;
    try {
      const archive = await (input.download ?? downloadOfficial)(nucleiTemplatesUrl(pin.version));
      files = templatesFromArchive(archive);
    } catch (error) {
      return { ok: false, kind: "download", message: reason(error) };
    }
    if (templatesDigest(files) !== expected) {
      return {
        ok: false,
        kind: "checksum",
        message:
          "The downloaded nuclei templates do not match their pinned digest and were discarded.",
      };
    }
    const failed = await publish(dir, async (workDir) => {
      for (const [relative, contents] of Object.entries(files)) {
        // Keys are `nuclei-templates/<path>`; the folder itself is the templates root.
        const inside = relative.split("/").slice(1).join("/");
        const destination = path.join(workDir, inside);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, contents);
      }
    });
    return failed ?? { ok: true, path: dir };
  });
}
