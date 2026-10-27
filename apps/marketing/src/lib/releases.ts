// FILE: releases.ts
// Purpose: Fetches the latest GitLab release and maps its asset links to a per-platform
//          download map (macOS arm64/x64, Windows, Linux) for the /install page.
// Layer: Server utility
// Depends on: GitLab Releases API, optional GITLAB_TOKEN

import "server-only";

import storedLatestReleaseDownloads from "@/data/latest-release-downloads.json";

const RELEASES_API_URL = "https://gitlab.com/api/v4/projects/locotine%2Fsaint-releases/releases";
const LATEST_RELEASE_API_URL = `${RELEASES_API_URL}/permalink/latest`;

export const RELEASES_URL = "https://gitlab.com/locotine/saint-releases/-/releases";

export type ReleaseDownloads = {
  // Tag for the latest release (e.g. "v0.1.0"), or null when unknown.
  version: string | null;
  // Page that lists every asset — used as the universal fallback target.
  releasesUrl: string;
  mac: { arm64: string; x64: string };
  windows: string;
  linux: string;
};

type GitLabReleaseLink = {
  name?: string;
  url?: string;
};

type GitLabRelease = {
  tag_name?: string;
  _links?: { self?: string };
  assets?: { links?: GitLabReleaseLink[] };
};

type StoredReleaseDownloads = ReleaseDownloads & {
  updatedAt?: string;
  source?: string;
};

const STORED_FALLBACK = storedLatestReleaseDownloads as StoredReleaseDownloads;

// Last-resort fallback: the public release listing is better than a broken href.
const FALLBACK: ReleaseDownloads = {
  version: null,
  releasesUrl: RELEASES_URL,
  mac: { arm64: RELEASES_URL, x64: RELEASES_URL },
  windows: RELEASES_URL,
  linux: RELEASES_URL,
};

// Uses the checked-in snapshot before the generic releases page so installer
// links remain direct even when GitLab's API blocks the production server.
function getFallbackDownloads(): ReleaseDownloads {
  return STORED_FALLBACK.version &&
    STORED_FALLBACK.mac?.arm64 &&
    STORED_FALLBACK.mac?.x64 &&
    STORED_FALLBACK.windows &&
    STORED_FALLBACK.linux
    ? {
        version: STORED_FALLBACK.version,
        releasesUrl: STORED_FALLBACK.releasesUrl,
        mac: STORED_FALLBACK.mac,
        windows: STORED_FALLBACK.windows,
        linux: STORED_FALLBACK.linux,
      }
    : FALLBACK;
}

export async function getReleaseDownloads(): Promise<ReleaseDownloads> {
  if (process.env.VISUAL_TEST === "1") return getFallbackDownloads();

  try {
    const headers: HeadersInit = { Accept: "application/json" };
    if (process.env.GITLAB_TOKEN) {
      headers["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;
    }

    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers,
      // Release artifacts change rarely; cache for 30 minutes.
      next: { revalidate: 1800 },
    });

    if (!response.ok) return getFallbackDownloads();

    const release = (await response.json()) as GitLabRelease;
    const assets = release.assets?.links ?? [];
    const releasesUrl = release._links?.self ?? RELEASES_URL;

    // First asset whose name matches wins; fall back to the listing page.
    const urlFor = (pattern: RegExp): string =>
      assets.find((asset) => asset.name && pattern.test(asset.name))?.url ?? releasesUrl;

    return {
      version: release.tag_name ?? null,
      releasesUrl,
      mac: {
        arm64: urlFor(/arm64\.dmg$/i),
        x64: urlFor(/x64\.dmg$/i),
      },
      windows: urlFor(/\.exe$/i),
      linux: urlFor(/\.AppImage$/i),
    };
  } catch {
    return getFallbackDownloads();
  }
}
