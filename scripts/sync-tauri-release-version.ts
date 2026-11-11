#!/usr/bin/env node
// FILE: sync-tauri-release-version.ts
// Purpose: Synchronizes the release version across `apps/desktop-rust` manifests
//          (`package.json`, `Cargo.toml`, `tauri.conf.json`) and generates the
//          Tauri v2 `latest.json` updater manifest from built platform bundles.
// Layer: Build / Release helper

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function normalizeReleaseVersion(rawVersion: string): string {
  const cleaned = rawVersion
    .trim()
    .replace(/^refs\/tags\//u, "")
    .replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(cleaned)) {
    throw new Error(
      `Invalid stable release version (prerelease/beta suffixes are not supported): ${rawVersion}`,
    );
  }
  return cleaned;
}

export function syncTauriManifestVersions(version: string, rootDir: string = repoRoot): void {
  const normalized = normalizeReleaseVersion(version);

  // 1. apps/desktop-rust/package.json
  const pkgPath = join(rootDir, "apps/desktop-rust/package.json");
  const pkgJson = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  pkgJson.version = normalized;
  writeFileSync(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, "utf8");

  // 2. apps/desktop-rust/tauri.conf.json
  const tauriConfPath = join(rootDir, "apps/desktop-rust/tauri.conf.json");
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf8")) as Record<string, unknown>;
  tauriConf.version = normalized;
  writeFileSync(tauriConfPath, `${JSON.stringify(tauriConf, null, 2)}\n`, "utf8");

  // 3. apps/desktop-rust/Cargo.toml
  const cargoTomlPath = join(rootDir, "apps/desktop-rust/Cargo.toml");
  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  const updatedCargoToml = cargoToml.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/u,
    `$1"${normalized}"`,
  );
  writeFileSync(cargoTomlPath, updatedCargoToml, "utf8");
}

function collectFilesRecursively(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFilesRecursively(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

export interface TauriUpdaterPlatformEntry {
  readonly signature: string;
  readonly url: string;
}

export interface TauriLatestManifest {
  readonly version: string;
  readonly notes: string;
  readonly pub_date: string;
  readonly platforms: Record<string, TauriUpdaterPlatformEntry>;
}

export function generateTauriLatestManifest(options: {
  readonly artifactsDir: string;
  readonly version: string;
  readonly tag: string;
  readonly repository: string;
  readonly notes?: string;
}): TauriLatestManifest {
  const normalizedVersion = normalizeReleaseVersion(options.version);
  const allFiles = collectFilesRecursively(options.artifactsDir);

  const downloadBaseUrl = `https://github.com/${options.repository}/releases/download/${options.tag}`;

  // Each platform needs a signed updater bundle; an unsigned installer (.dmg,
  // .deb) or an empty signature would publish a manifest the updater rejects.
  const signedBundle = (
    platform: string,
    predicate: (fileName: string) => boolean,
  ): TauriUpdaterPlatformEntry => {
    const bundlePath = allFiles.find(
      (file) => predicate(file.split(/[\\/]/u).pop()!) && existsSync(`${file}.sig`),
    );
    const signature = bundlePath ? readFileSync(`${bundlePath}.sig`, "utf8").trim() : "";
    if (!bundlePath || !signature) {
      throw new Error(`Missing signed updater bundle for ${platform} in ${options.artifactsDir}`);
    }
    const fileName = bundlePath.split(/[\\/]/u).pop()!;
    return { signature, url: `${downloadBaseUrl}/${encodeURIComponent(fileName)}` };
  };

  // Tauri names both macOS archives `Saint.app.tar.gz`; the release workflow
  // renames them with the matrix arch (`arm64` / `x64`) before upload.
  const platforms: Record<string, TauriUpdaterPlatformEntry> = {
    "windows-x86_64": signedBundle("windows-x86_64", (f) => f.endsWith("-setup.exe")),
    "darwin-aarch64": signedBundle(
      "darwin-aarch64",
      (f) => /(aarch64|arm64)/u.test(f) && f.endsWith(".app.tar.gz"),
    ),
    "darwin-x86_64": signedBundle(
      "darwin-x86_64",
      (f) => /(x86_64|x64)/u.test(f) && f.endsWith(".app.tar.gz"),
    ),
    "linux-x86_64": signedBundle("linux-x86_64", (f) => f.endsWith(".AppImage")),
  };

  return {
    version: normalizedVersion,
    notes: options.notes ?? `Saint v${normalizedVersion}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

// Electron Saint (<= 1.1.17) polls electron-updater feeds on the latest release.
// Publishing them with the Tauri installers moves those installs over: Linux
// swaps the AppImage in place, Windows runs the Tauri NSIS installer, and macOS
// (an unsigned Squirrel install that cannot update itself) reaches the updater
// error that already links to the release page.
// ponytail: remove once Electron installs are gone.
export function generateElectronBridgeFeeds(options: {
  readonly artifactsDir: string;
  readonly version: string;
  readonly releaseDate?: string;
}): Record<string, string> {
  const version = normalizeReleaseVersion(options.version);
  const releaseDate = options.releaseDate ?? new Date().toISOString();
  const allFiles = collectFilesRecursively(options.artifactsDir);
  const feed = (predicate: (fileName: string) => boolean): string => {
    const files = allFiles
      .filter((file) => predicate(file.split(/[\\/]/u).pop()!))
      .map((file) => {
        const bytes = readFileSync(file);
        return {
          url: file.split(/[\\/]/u).pop()!,
          sha512: createHash("sha512").update(bytes).digest("base64"),
          size: bytes.length,
        };
      });
    const [first] = files;
    if (!first) throw new Error(`Missing Electron bridge installer in ${options.artifactsDir}`);
    return [
      `version: ${version}`,
      "files:",
      ...files.flatMap((f) => [
        `  - url: ${f.url}`,
        `    sha512: ${f.sha512}`,
        `    size: ${f.size}`,
      ]),
      `path: ${first.url}`,
      `sha512: ${first.sha512}`,
      `releaseDate: '${releaseDate}'`,
      "",
    ].join("\n");
  };
  const windows = feed((f) => f.endsWith("-setup.exe"));
  const mac = feed((f) => f.endsWith(".dmg"));
  const linux = feed((f) => f.endsWith(".AppImage"));
  // `saint*` is the Stable channel; `latest*` covers builds on the default channel.
  return {
    "saint.yml": windows,
    "latest.yml": windows,
    "saint-mac.yml": mac,
    "latest-mac.yml": mac,
    "saint-linux.yml": linux,
    "latest-linux.yml": linux,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const modeIndex = args.indexOf("--generate-latest-json");
  if (modeIndex >= 0) {
    const artifactsDir = args[modeIndex + 1];
    const versionIdx = args.indexOf("--version");
    const tagIdx = args.indexOf("--tag");
    const repoIdx = args.indexOf("--repo");
    const outIdx = args.indexOf("--out");

    if (!artifactsDir || versionIdx < 0 || tagIdx < 0 || repoIdx < 0 || outIdx < 0) {
      throw new Error(
        "Usage: node scripts/sync-tauri-release-version.ts --generate-latest-json <dir> --version <ver> --tag <tag> --repo <owner/repo> --out <file>",
      );
    }
    const manifest = generateTauriLatestManifest({
      artifactsDir: resolve(artifactsDir),
      version: args[versionIdx + 1]!,
      tag: args[tagIdx + 1]!,
      repository: args[repoIdx + 1]!,
    });
    const outPath = resolve(args[outIdx + 1]!);
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[sync-tauri-release-version] Wrote ${outPath}`);
    const feeds = generateElectronBridgeFeeds({
      artifactsDir: resolve(artifactsDir),
      version: args[versionIdx + 1]!,
      releaseDate: manifest.pub_date,
    });
    for (const [name, body] of Object.entries(feeds)) {
      writeFileSync(join(dirname(outPath), name), body, "utf8");
    }
    console.log(`[sync-tauri-release-version] Wrote Electron bridge feeds next to ${outPath}`);
  } else {
    const version = args[0];
    if (!version) {
      throw new Error("Usage: node scripts/sync-tauri-release-version.ts <version>");
    }
    syncTauriManifestVersions(version);
    console.log(
      `[sync-tauri-release-version] Synchronized apps/desktop-rust version to ${normalizeReleaseVersion(version)}`,
    );
  }
}
