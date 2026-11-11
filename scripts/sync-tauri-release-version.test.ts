import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  generateElectronBridgeFeeds,
  generateTauriLatestManifest,
  normalizeReleaseVersion,
  syncTauriManifestVersions,
} from "./sync-tauri-release-version.ts";

describe("sync-tauri-release-version", () => {
  it("normalizes stable release tags and rejects beta/prerelease or invalid strings", () => {
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeReleaseVersion("refs/tags/v1.2.3")).toBe("1.2.3");
    expect(() => normalizeReleaseVersion("v1.2.3-beta.1")).toThrow();
    expect(() => normalizeReleaseVersion("not-a-version")).toThrow();
  });

  it("synchronizes package.json, Cargo.toml, and tauri.conf.json versions", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "saint-tauri-sync-"));
    try {
      const rustDir = join(tempRoot, "apps/desktop-rust");
      mkdirSync(rustDir, { recursive: true });
      writeFileSync(
        join(rustDir, "package.json"),
        JSON.stringify({ name: "@saint/desktop-rust", version: "1.0.0" }, null, 2),
      );
      writeFileSync(
        join(rustDir, "tauri.conf.json"),
        JSON.stringify({ productName: "Saint", version: "1.0.0" }, null, 2),
      );
      writeFileSync(
        join(rustDir, "Cargo.toml"),
        '[package]\nname = "saint-desktop"\nversion = "1.0.0"\nedition = "2021"\n',
      );

      syncTauriManifestVersions("v2.4.6", tempRoot);

      expect(JSON.parse(readFileSync(join(rustDir, "package.json"), "utf8")).version).toBe("2.4.6");
      expect(JSON.parse(readFileSync(join(rustDir, "tauri.conf.json"), "utf8")).version).toBe(
        "2.4.6",
      );
      expect(readFileSync(join(rustDir, "Cargo.toml"), "utf8")).toContain('version = "2.4.6"');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // File names match the release workflow: Tauri's own names for Windows and
  // Linux, and the arch-suffixed macOS archives the staging step produces.
  const writeReleaseBundles = (dir: string) => {
    for (const [name, sig] of [
      ["Saint_2.4.6_x64-setup.exe", "win-sig"],
      ["Saint_2.4.6_arm64.app.tar.gz", "mac-arm-sig"],
      ["Saint_2.4.6_x64.app.tar.gz", "mac-x64-sig"],
      ["Saint_2.4.6_amd64.AppImage", "linux-sig"],
    ] as const) {
      writeFileSync(join(dir, name), "binary");
      writeFileSync(join(dir, `${name}.sig`), `${sig}\n`);
    }
    // Unsigned installers must never be picked as updater bundles.
    writeFileSync(join(dir, "Saint_2.4.6_aarch64.dmg"), "dmg");
    writeFileSync(join(dir, "Saint_2.4.6_x64.dmg"), "dmg");
  };

  it("maps every platform to its signed updater bundle", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "saint-tauri-artifacts-"));
    try {
      writeReleaseBundles(artifactsDir);
      const manifest = generateTauriLatestManifest({
        artifactsDir,
        version: "v2.4.6",
        tag: "v2.4.6",
        repository: "Locotine/saint-hyper-agent",
      });
      const base = "https://github.com/Locotine/saint-hyper-agent/releases/download/v2.4.6";
      expect(manifest.version).toBe("2.4.6");
      expect(manifest.platforms).toEqual({
        "windows-x86_64": { signature: "win-sig", url: `${base}/Saint_2.4.6_x64-setup.exe` },
        "darwin-aarch64": { signature: "mac-arm-sig", url: `${base}/Saint_2.4.6_arm64.app.tar.gz` },
        "darwin-x86_64": { signature: "mac-x64-sig", url: `${base}/Saint_2.4.6_x64.app.tar.gz` },
        "linux-x86_64": { signature: "linux-sig", url: `${base}/Saint_2.4.6_amd64.AppImage` },
      });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("refuses a manifest with a missing or empty platform signature", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "saint-tauri-artifacts-missing-"));
    const generate = () =>
      generateTauriLatestManifest({
        artifactsDir,
        version: "2.4.6",
        tag: "v2.4.6",
        repository: "Locotine/saint-hyper-agent",
      });
    try {
      writeReleaseBundles(artifactsDir);
      writeFileSync(join(artifactsDir, "Saint_2.4.6_x64.app.tar.gz.sig"), "\n");
      expect(generate).toThrow(/darwin-x86_64/u);
      rmSync(join(artifactsDir, "Saint_2.4.6_amd64.AppImage.sig"));
      writeFileSync(join(artifactsDir, "Saint_2.4.6_x64.app.tar.gz.sig"), "mac-x64-sig\n");
      expect(generate).toThrow(/linux-x86_64/u);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
  it("writes electron-updater feeds that point Electron installs at the Tauri installers", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "saint-tauri-artifacts-bridge-"));
    try {
      writeReleaseBundles(artifactsDir);
      const feeds = generateElectronBridgeFeeds({
        artifactsDir,
        version: "v2.4.6",
        releaseDate: "2026-11-11T00:00:00.000Z",
      });
      // sha512 of the 6-byte "binary" fixture, base64 as electron-updater expects.
      const sha = createHash("sha512").update("binary").digest("base64");
      expect(feeds["saint.yml"]).toBe(
        [
          "version: 2.4.6",
          "files:",
          "  - url: Saint_2.4.6_x64-setup.exe",
          `    sha512: ${sha}`,
          "    size: 6",
          "path: Saint_2.4.6_x64-setup.exe",
          `sha512: ${sha}`,
          "releaseDate: '2026-11-11T00:00:00.000Z'",
          "",
        ].join("\n"),
      );
      expect(feeds["latest.yml"]).toBe(feeds["saint.yml"]);
      expect(feeds["saint-linux.yml"]).toContain("url: Saint_2.4.6_amd64.AppImage");
      expect(feeds["saint-mac.yml"]).toContain("url: Saint_2.4.6_aarch64.dmg");
      expect(feeds["saint-mac.yml"]).toContain("url: Saint_2.4.6_x64.dmg");
      expect(Object.keys(feeds).sort()).toEqual([
        "latest-linux.yml",
        "latest-mac.yml",
        "latest.yml",
        "saint-linux.yml",
        "saint-mac.yml",
        "saint.yml",
      ]);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
