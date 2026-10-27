import { describe, expect, it } from "vitest";

import {
  readReleaseVersion,
  rewriteManifestFileUrls,
  selectReleaseAssets,
  staticFeedChannel,
  staticFeedManifestName,
} from "./publish-gitlab-release.ts";

describe("selectReleaseAssets", () => {
  it("keeps installers, blockmaps and manifests and drops builder debug files", () => {
    expect(
      selectReleaseAssets([
        "Saint-Beta-1.2.3-beta.1-x64.exe",
        "Saint-Beta-1.2.3-beta.1-x64.exe.blockmap",
        "latest.yml",
        "builder-debug.yml",
        "builder-effective-config.yaml",
        "Saint-Beta-1.2.3-beta.1-x86_64.AppImage",
        "win-unpacked",
        "install-saint.sh",
        "other.sh",
      ]),
    ).toEqual([
      "Saint-Beta-1.2.3-beta.1-x64.exe",
      "Saint-Beta-1.2.3-beta.1-x64.exe.blockmap",
      "Saint-Beta-1.2.3-beta.1-x86_64.AppImage",
      "install-saint.sh",
      "latest.yml",
    ]);
  });
});

describe("readReleaseVersion", () => {
  it("reads the version every manifest agrees on", () => {
    expect(
      readReleaseVersion([
        { name: "latest.yml", contents: "version: 1.2.3-beta.1\nfiles: []\n" },
        { name: "latest-linux.yml", contents: "version: '1.2.3-beta.1'\n" },
      ]),
    ).toBe("1.2.3-beta.1");
  });

  it("refuses missing or disagreeing manifests", () => {
    expect(() => readReleaseVersion([])).toThrow(/No updater manifest/);
    expect(() =>
      readReleaseVersion([
        { name: "latest.yml", contents: "version: 1.2.3\n" },
        { name: "latest-mac.yml", contents: "version: 1.2.4\n" },
      ]),
    ).toThrow(/disagree/);
  });
});

describe("static feed manifests", () => {
  it("names manifests for the updater channel of the version", () => {
    expect(staticFeedChannel("1.0.11")).toBe("saint");
    expect(staticFeedChannel("1.0.12-beta.3")).toBe("beta");
    expect(staticFeedManifestName("latest.yml", "saint")).toBe("saint.yml");
    expect(staticFeedManifestName("latest-linux.yml", "saint")).toBe("saint-linux.yml");
    expect(staticFeedManifestName("beta-mac.yml", "beta")).toBe("beta-mac.yml");
  });

  it("points relative file entries at the uploaded packages", () => {
    const base = "https://gitlab.com/api/v4/projects/a%2Fb/packages/generic/saint-desktop/1.0.11/";
    const manifest = [
      "version: 1.0.11",
      "files:",
      "  - url: Saint-1.0.11-x86_64.AppImage",
      "    sha512: abc==",
      "  - url: 'Saint 1.0.11.zip'",
      "  - url: https://example.com/already-absolute.zip",
      "path: Saint-1.0.11-x86_64.AppImage",
      "releaseDate: '2026-10-27T10:00:00.000Z'",
      "",
    ].join("\n");
    expect(rewriteManifestFileUrls(manifest, base)).toBe(
      [
        "version: 1.0.11",
        "files:",
        `  - url: ${base}Saint-1.0.11-x86_64.AppImage`,
        "    sha512: abc==",
        `  - url: '${base}Saint%201.0.11.zip'`,
        "  - url: https://example.com/already-absolute.zip",
        `path: ${base}Saint-1.0.11-x86_64.AppImage`,
        "releaseDate: '2026-10-27T10:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });
});
