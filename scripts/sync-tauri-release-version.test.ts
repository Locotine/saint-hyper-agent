import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
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

  it("generates a valid Tauri latest.json updater manifest from bundle files", () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "saint-tauri-artifacts-"));
    try {
      writeFileSync(join(artifactsDir, "Saint_2.4.6_x64-setup.exe"), "binary");
      writeFileSync(join(artifactsDir, "Saint_2.4.6_x64-setup.exe.sig"), "win-sig-123\n");
      writeFileSync(join(artifactsDir, "Saint_aarch64.app.tar.gz"), "binary");
      writeFileSync(join(artifactsDir, "Saint_aarch64.app.tar.gz.sig"), "mac-arm-sig\n");

      const manifest = generateTauriLatestManifest({
        artifactsDir,
        version: "v2.4.6",
        tag: "v2.4.6",
        repository: "Locotine/saint-hyper-agent",
      });

      expect(manifest.version).toBe("2.4.6");
      expect(manifest.platforms["windows-x86_64"]).toEqual({
        signature: "win-sig-123",
        url: "https://github.com/Locotine/saint-hyper-agent/releases/download/v2.4.6/Saint_2.4.6_x64-setup.exe",
      });
      expect(manifest.platforms["darwin-aarch64"]).toEqual({
        signature: "mac-arm-sig",
        url: "https://github.com/Locotine/saint-hyper-agent/releases/download/v2.4.6/Saint_aarch64.app.tar.gz",
      });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});
