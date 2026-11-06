// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SAINT_DESKTOP_UPDATE_CHANNEL,
  SAINT_PRODUCTION_BUNDLE_ID,
} from "@saint/shared/desktopIdentity";

import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Saint-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Saint-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Saint-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
path: Saint-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: string; bin?: Record<string, string> };
  if (serverPackage.name !== "@saint/cli") {
    throw new Error(`Expected CLI package @saint/cli, got ${serverPackage.name ?? "<missing>"}.`);
  }
  const expectedBinaries = {
    saint: "dist/index.mjs",
    "saint-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  if (JSON.stringify(serverPackage.bin ?? {}) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      "Expected the CLI to expose only the Saint entry point and migration recovery binary.",
    );
  }
  if (SAINT_PRODUCTION_BUNDLE_ID !== "com.locotine.saint") {
    throw new Error(`Unexpected production bundle ID: ${SAINT_PRODUCTION_BUNDLE_ID}.`);
  }
  if (SAINT_DESKTOP_UPDATE_CHANNEL !== "saint") {
    throw new Error(`Unexpected desktop update channel: ${SAINT_DESKTOP_UPDATE_CHANNEL}.`);
  }

  const releasePolicy = readReleaseUpdatePolicyConfig(repoRoot);
  const resolvedPolicy = resolveReleaseUpdatePolicy("9.9.9", releasePolicy);
  if (
    resolvedPolicy.lane !== "clean" ||
    !resolvedPolicy.makeLatest ||
    resolvedPolicy.mirrorToStableChannel
  ) {
    throw new Error("Expected stable clean Saint releases to publish on GitHub Latest.");
  }
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  const gitAttributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  assertContains(
    gitAttributes,
    "bun.lock text eol=lf",
    "Expected bun.lock to retain byte-identical LF endings on every release runner.",
  );
  assertContains(
    buildScript,
    "bun install --frozen-lockfile --ignore-scripts --linker hoisted",
    "Expected macOS and Linux desktop staging to install from the repository's frozen workspace lockfile.",
  );
  assertContains(
    buildScript,
    'if (platform === "win")',
    "Expected Windows staging to use its explicit Bun lockfile-workaround path.",
  );
  assertContains(
    buildScript,
    "bun install --omit=dev --ignore-scripts --linker hoisted",
    "Expected Windows staging to omit dev dependencies without Bun's implicitly frozen production mode.",
  );
  assertNotContains(
    buildScript,
    "--production --frozen-lockfile",
    "Desktop staging must avoid Bun's divergent frozen production-workspace lockfile resolution.",
  );
  assertNotContains(
    buildScript,
    "bun install --production",
    "Windows staging must not use Bun's production flag because it implicitly forces frozen mode.",
  );
  assertNotContains(
    buildScript,
    "--filter @saint/",
    "Desktop staging must not use Bun workspace filters because filtered hoisted installs can diverge from bun.lock.",
  );
  assertContains(
    buildScript,
    'npm rebuild node-pty --foreground-scripts --prefix ${path.join(stageAppDir, "node_modules", "node-pty")}',
    "Expected Linux desktop staging to build only node-pty after the script-free frozen install.",
  );
  assertNotContains(
    buildScript,
    "npm rebuild --foreground-scripts",
    "Desktop staging must never enable every dependency lifecycle script.",
  );
  assertNotContains(
    buildScript,
    "bun pm trust --all",
    "Desktop staging must never trust every dependency lifecycle script.",
  );
  assertContains(
    buildScript,
    'createRequire(new URL("./package.json", import.meta.url))',
    "Expected desktop packaging to resolve dependencies from the owning scripts workspace.",
  );
  assertContains(
    buildScript,
    'requireFromScriptsWorkspace.resolve("electron-builder/cli.js")',
    "Expected desktop packaging to resolve electron-builder across Bun hoisting layouts.",
  );
  assertContains(
    buildScript,
    "`${process.execPath} ${electronBuilderCliPath}",
    "Expected desktop packaging to invoke electron-builder through Node without platform-specific bin shims.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a Windows bin shim that Bun may hoist elsewhere.",
  );
  assertContains(
    buildScript,
    "saintCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "saintLockfileSha256: resolvedLockfileSha256",
    "Expected the staged package to carry its repository lockfile digest.",
  );
  assertContains(
    buildScript,
    "saintWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject",
    "Expected signed Windows packages to carry the independently configured certificate subject DN.",
  );

  const lockfile = readFileSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), "utf8");
  const packagesSectionOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesSectionOffset < 0) {
    throw new Error("Expected bun.lock to contain a packages section.");
  }
  const workspaceImporters = lockfile.slice(0, packagesSectionOffset);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const workspacePath = manifestPath === "package.json" ? "" : dirname(manifestPath);
    if (!workspaceImporters.includes(`${JSON.stringify(workspacePath)}: {`)) {
      throw new Error(`Expected ${manifestPath} to have a matching importer in bun.lock.`);
    }
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "saint-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyDesktopStageLockAuthority();
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Saint-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Saint-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );
  assertNotContains(
    mergedManifest,
    ".dmg",
    "macOS updater manifests must describe only the finalized ZIP artifacts.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
