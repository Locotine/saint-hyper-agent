#!/usr/bin/env node
// FILE: sync-tauri-release-version.ts
// Purpose: Synchronizes the release version across `apps/desktop-rust` manifests
//          (`package.json`, `Cargo.toml`, `tauri.conf.json`) and generates the
//          Tauri v2 `latest.json` updater manifest from built platform bundles.
// Layer: Build / Release helper

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
  const platforms: Record<string, TauriUpdaterPlatformEntry> = {};

  const downloadBaseUrl = `https://github.com/${options.repository}/releases/download/${options.tag}`;

  const matchUpdaterBundle = (
    predicates: ReadonlyArray<(filePath: string) => boolean>,
  ): TauriUpdaterPlatformEntry | null => {
    const candidates = allFiles.filter((file) => !file.endsWith(".sig"));
    let bundlePath: string | undefined;
    for (const predicate of predicates) {
      bundlePath = candidates.find((file) => predicate(file) && existsSync(`${file}.sig`));
      if (bundlePath) break;
    }
    if (!bundlePath) {
      for (const predicate of predicates) {
        bundlePath = candidates.find((file) => predicate(file));
        if (bundlePath) break;
      }
    }
    if (!bundlePath) return null;
    const sigPath = `${bundlePath}.sig`;
    const signature = existsSync(sigPath) ? readFileSync(sigPath, "utf8").trim() : "";
    const fileName = bundlePath.split(/[\\/]/u).pop()!;
    return {
      signature,
      url: `${downloadBaseUrl}/${encodeURIComponent(fileName)}`,
    };
  };

  const winX64 = matchUpdaterBundle([
    (f) => f.endsWith("-setup.exe") || f.endsWith("_x64-setup.exe"),
    (f) => f.endsWith(".msi"),
  ]);
  if (winX64) {
    platforms["windows-x86_64"] = winX64;
  }

  const macArm64 = matchUpdaterBundle([
    (f) => (f.includes("aarch64") || f.includes("arm64")) && f.endsWith(".app.tar.gz"),
    (f) => (f.includes("aarch64") || f.includes("arm64")) && f.endsWith(".dmg"),
  ]);
  if (macArm64) {
    platforms["darwin-aarch64"] = macArm64;
  }

  const macX64 = matchUpdaterBundle([
    (f) => (f.includes("x86_64") || f.includes("x64")) && f.endsWith(".app.tar.gz"),
    (f) => (f.includes("x86_64") || f.includes("x64")) && f.endsWith(".dmg"),
  ]);
  if (macX64) {
    platforms["darwin-x86_64"] = macX64;
  }

  const linuxX64 = matchUpdaterBundle([(f) => f.endsWith(".AppImage"), (f) => f.endsWith(".deb")]);
  if (linuxX64) {
    platforms["linux-x86_64"] = linuxX64;
  }

  return {
    version: normalizedVersion,
    notes: options.notes ?? `Saint v${normalizedVersion}`,
    pub_date: new Date().toISOString(),
    platforms,
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
