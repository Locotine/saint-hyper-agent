// FILE: mac-update-zip.test.ts
// Purpose: Locks down macOS update zip validation and latest-mac.yml patching.
// Layer: Release/build tests
// Depends on: scripts/lib/mac-update-zip.ts.

import { assert, describe, it } from "@effect/vitest";

import {
  assertMacUpdateManifestZipMetadata,
  buildMacUpdateZipSymlinkEntries,
  isZipInfoSymlink,
  resolveMacUpdateManifestFileNames,
  resolveSingleMacUpdateZipFileName,
  resolveSingleTopLevelMacAppBundle,
  updateMacUpdateManifestZipEntry,
} from "./lib/mac-update-zip.ts";

describe("mac-update-zip", () => {
  it("detects symlink entries from unzip verbose metadata", () => {
    assert.equal(
      isZipInfoSymlink(
        `  Unix file attributes (120755 octal):            lrwxr-xr-x
  MS-DOS file attributes (00 hex):                none
`,
      ),
      true,
    );
    assert.equal(
      isZipInfoSymlink(
        `  Unix file attributes (100755 octal):            -rwxr-xr-x
  MS-DOS file attributes (00 hex):                none
`,
      ),
      false,
    );
  });

  it("builds Electron framework symlink paths for the top-level app bundle", () => {
    assert.deepStrictEqual(buildMacUpdateZipSymlinkEntries("Saint.app"), [
      "Saint.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
      "Saint.app/Contents/Frameworks/Electron Framework.framework/Helpers",
      "Saint.app/Contents/Frameworks/Electron Framework.framework/Libraries",
      "Saint.app/Contents/Frameworks/Electron Framework.framework/Resources",
      "Saint.app/Contents/Frameworks/Electron Framework.framework/Versions/Current",
    ]);
  });

  it("resolves exactly one top-level .app from update zip entries", () => {
    assert.equal(
      resolveSingleTopLevelMacAppBundle([
        "__MACOSX/Saint.app/Contents/Info.plist",
        "Saint.app/Contents/Info.plist",
        "Saint.app/Contents/MacOS/Saint",
      ]),
      "Saint.app",
    );

    assert.throws(
      () =>
        resolveSingleTopLevelMacAppBundle([
          "Saint.app/Contents/Info.plist",
          "Other.app/Contents/Info.plist",
        ]),
      /Expected one top-level \.app bundle/,
    );
  });

  it("resolves exactly one macOS update zip artifact", () => {
    assert.equal(
      resolveSingleMacUpdateZipFileName([
        "Saint-0.1.5-arm64.dmg",
        "Saint-0.1.5-arm64.zip",
        "latest-mac.yml",
      ]),
      "Saint-0.1.5-arm64.zip",
    );

    assert.throws(
      () => resolveSingleMacUpdateZipFileName(["Saint-0.1.5-arm64.zip", "Saint-0.1.5-x64.zip"]),
      /Expected one macOS update zip artifact/,
    );
  });

  it("requires at least one macOS update manifest", () => {
    assert.deepStrictEqual(
      resolveMacUpdateManifestFileNames([
        "Saint-0.1.5-arm64.dmg",
        "Saint-0.1.5-arm64.zip",
        "latest-mac.yml",
      ]),
      ["latest-mac.yml"],
    );

    assert.throws(
      () => resolveMacUpdateManifestFileNames(["Saint-0.1.5-arm64.dmg"]),
      /Expected at least one macOS update manifest/,
    );
  });

  it("allows a missing manifest only for an explicitly scripted-update artifact", () => {
    const artifacts = ["Saint-Cua-0.8.4-arm64.zip"];
    assert.deepStrictEqual(resolveMacUpdateManifestFileNames(artifacts, { required: false }), []);
    assert.throws(() => resolveMacUpdateManifestFileNames(artifacts, { required: true }));
    assert.throws(() => resolveMacUpdateManifestFileNames(artifacts));
  });

  it("still returns present manifests for validation when a feed is optional", () => {
    assert.deepStrictEqual(
      resolveMacUpdateManifestFileNames(["Saint-Cua-0.8.4-arm64.zip", "latest-mac.yml"], {
        required: false,
      }),
      ["latest-mac.yml"],
    );
  });

  it.each([false, true])(
    "updates zip metadata and preserves dmg fields (blockmaps: %s)",
    (withBlockmaps) => {
      const manifest = `version: 0.1.4
files:
  - url: Saint-0.1.4-arm64.zip
    sha512: oldzip
    size: 100
${withBlockmaps ? "    blockMapSize: 50\n" : ""}  - url: Saint-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
${withBlockmaps ? "    blockMapSize: 75\n" : ""}path: 'Saint-0.1.4-arm64.zip'
sha512: oldzip
releaseDate: '2026-06-07T12:00:00.000Z'
`;

      const updated = updateMacUpdateManifestZipEntry(manifest, "Saint-0.1.4-arm64.zip", {
        sha512: "newzip",
        size: 12345,
      });

      assert.equal(
        updated,
        `version: 0.1.4
files:
  - url: Saint-0.1.4-arm64.zip
    sha512: newzip
    size: 12345
  - url: Saint-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
${withBlockmaps ? "    blockMapSize: 75\n" : ""}path: 'Saint-0.1.4-arm64.zip'
sha512: newzip
releaseDate: '2026-06-07T12:00:00.000Z'
`,
      );
    },
  );

  it("rejects manifests missing the target zip entry", () => {
    assert.throws(
      () =>
        updateMacUpdateManifestZipEntry(
          `version: 0.1.4
files:
  - url: Saint-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
releaseDate: '2026-06-07T12:00:00.000Z'
`,
          "Saint-0.1.4-arm64.zip",
          {
            sha512: "newzip",
            size: 12345,
          },
        ),
      /Could not update Saint-0.1.4-arm64.zip entry/,
    );
  });

  it("validates manifest metadata after zip repack", () => {
    const manifest = `version: 0.1.5
files:
  - url: Saint-0.1.5-arm64.zip
    sha512: newzip
    size: 12345
path: Saint-0.1.5-arm64.zip
sha512: newzip
releaseDate: '2026-06-07T12:00:00.000Z'
`;
    const metadata = { sha512: "newzip", size: 12345 };

    assert.deepStrictEqual(
      assertMacUpdateManifestZipMetadata(manifest, "Saint-0.1.5-arm64.zip", metadata),
      {
        manifestHasZipPath: true,
        manifestHasZipSha: true,
        manifestHasZipSize: true,
      },
    );
  });
});
