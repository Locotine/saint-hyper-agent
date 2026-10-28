// FILE: update-installer-downloads.mjs
// Purpose: Refreshes the stored latest direct download links.
// Layer: Maintenance script for the Codex daily automation
// Depends on: GitHub Releases API, src/data installer JSON snapshots
// Note: The stored installer total in installer-downloads.json is a snapshot
//       carried over from earlier release hosts and is left untouched.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const latestOutputPath = resolve(projectRoot, "src/data/latest-release-downloads.json");
const releasesApiUrl = "https://api.github.com/repos/Locotine/saint-hyper-agent/releases";
const latestReleaseApiUrl = `${releasesApiUrl}/latest`;
const releasesPageUrl = "https://github.com/Locotine/saint-hyper-agent/releases";

function createGitHubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

// Mirrors the website resolver's `/releases/latest` source.
async function fetchLatestRelease() {
  const response = await fetch(latestReleaseApiUrl, {
    headers: createGitHubHeaders(),
  });

  if (!response.ok) {
    throw new Error(`GitHub Latest Release API failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function getReleaseDownloads(release, source) {
  const assets = release.assets ?? [];
  const releasesUrl = release.html_url ?? `${releasesPageUrl}/tag/${release.tag_name}`;
  const urlFor = (pattern) =>
    assets.find((asset) => asset.name && pattern.test(asset.name))?.browser_download_url ??
    releasesUrl;

  const downloads = {
    version: release.tag_name ?? null,
    releasesUrl,
    mac: {
      arm64: urlFor(/arm64\.dmg$/i),
      x64: urlFor(/x64\.dmg$/i),
    },
    windows: urlFor(/\.exe$/i),
    linux: urlFor(/\.AppImage$/i),
    updatedAt: new Date().toISOString(),
    source,
  };

  if (
    !downloads.version ||
    downloads.mac.arm64 === releasesUrl ||
    downloads.mac.x64 === releasesUrl ||
    downloads.windows === releasesUrl ||
    downloads.linux === releasesUrl
  ) {
    throw new Error(
      `Latest release ${release.tag_name ?? "unknown"} is missing an installer asset.`,
    );
  }

  return downloads;
}

const latestRelease = await fetchLatestRelease();
const nextLatestSnapshot = getReleaseDownloads(latestRelease, latestReleaseApiUrl);

await mkdir(dirname(latestOutputPath), { recursive: true });
await writeFile(latestOutputPath, `${JSON.stringify(nextLatestSnapshot, null, 2)}\n`);

console.log(`Latest release downloads: ${nextLatestSnapshot.version}`);
