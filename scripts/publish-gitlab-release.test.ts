import { describe, expect, it } from "vitest";

import { readReleaseVersion, selectReleaseAssets } from "./publish-gitlab-release.ts";

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
        "install-saint-beta.sh",
        "other.sh",
      ]),
    ).toEqual([
      "Saint-Beta-1.2.3-beta.1-x64.exe",
      "Saint-Beta-1.2.3-beta.1-x64.exe.blockmap",
      "Saint-Beta-1.2.3-beta.1-x86_64.AppImage",
      "install-saint-beta.sh",
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
