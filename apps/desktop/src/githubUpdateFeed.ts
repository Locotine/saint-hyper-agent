// FILE: githubUpdateFeed.ts
// Purpose: Derives human-facing GitHub and GitLab release URLs from electron-updater config.
// Layer: Desktop update utility
// Exports: resolveGitHubUpdateSource, buildGitHubReleasesPageUrl, resolveGitLabReleasesPageUrl

type GitHubUpdateSource = {
  readonly owner: string;
  readonly repo: string;
  readonly host: string;
  readonly protocol: "http" | "https";
};

function normalizeGitHubProtocol(protocol: string | undefined): "http" | "https" {
  return protocol === "http" ? "http" : "https";
}

export function resolveGitHubUpdateSource(
  rawConfig: Record<string, string> | null,
): GitHubUpdateSource | null {
  if (rawConfig?.provider !== "github") {
    return null;
  }

  const owner = rawConfig.owner?.trim();
  const repo = rawConfig.repo?.trim();
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    host: rawConfig.host?.trim() || "github.com",
    protocol: normalizeGitHubProtocol(rawConfig.protocol?.trim()),
  };
}

// Human-facing releases page used only by the manual-download fallback.
export function buildGitHubReleasesPageUrl(source: GitHubUpdateSource, tag?: string): string {
  const path =
    tag && tag.trim().length > 0
      ? `/${source.owner}/${source.repo}/releases/tag/${tag.trim()}`
      : `/${source.owner}/${source.repo}/releases/latest`;
  return new URL(path, `${source.protocol}://${source.host}`).toString();
}

// GitLab's latest-release page for a `namespace/project` feed. A numeric
// project id has no web path, so it gets no page.
export function resolveGitLabReleasesPageUrl(
  rawConfig: Record<string, string> | null,
): string | null {
  if (rawConfig?.provider !== "gitlab") {
    return null;
  }
  const rawProject = rawConfig.projectId?.trim().replace(/^["']|["']$/gu, "") ?? "";
  // Builds store the path URL-encoded (`namespace%2Fproject`) for the API.
  let project: string;
  try {
    project = decodeURIComponent(rawProject);
  } catch {
    return null;
  }
  if (!project || !project.includes("/")) {
    return null;
  }
  const host = rawConfig.host?.trim() || "gitlab.com";
  return new URL(`/${project}/-/releases/permalink/latest`, `https://${host}`).toString();
}
