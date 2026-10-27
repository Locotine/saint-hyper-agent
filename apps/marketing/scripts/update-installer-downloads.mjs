// FILE: update-installer-downloads.mjs
// Purpose: Refreshes the stored latest direct download links.
// Layer: Maintenance script for the Codex daily automation
// Depends on: GitLab Releases API, src/data installer JSON snapshots
// Note: GitLab release asset links carry no download counts, so the stored
//       installer total in installer-downloads.json is left untouched.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const latestOutputPath = resolve(projectRoot, "src/data/latest-release-downloads.json");
const releasesApiUrl = "https://gitlab.com/api/v4/projects/locotine%2Fsaint-releases/releases";
const latestReleaseApiUrl = `${releasesApiUrl}/permalink/latest`;
const releasesPageUrl = "https://gitlab.com/locotine/saint-releases/-/releases";

function createGitLabHeaders() {
  const headers = { Accept: "application/json" };

  if (process.env.GITLAB_TOKEN) {
    headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
  }

  return headers;
}

// Mirrors the website resolver's `/releases/permalink/latest` source.
async function fetchLatestRelease() {
  const response = await fetch(latestReleaseApiUrl, {
    headers: createGitLabHeaders(),
  });

  if (!response.ok) {
    throw new Error(`GitLab Latest Release API failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function getReleaseDownloads(release, source) {
  const assets = release.assets?.links ?? [];
  const releasesUrl = release._links?.self ?? `${releasesPageUrl}/${release.tag_name}`;
  const urlFor = (pattern) =>
    assets.find((asset) => asset.name && pattern.test(asset.name))?.url ?? releasesUrl;

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
