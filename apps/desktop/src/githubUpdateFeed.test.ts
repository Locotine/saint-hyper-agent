// FILE: githubUpdateFeed.test.ts
// Purpose: Verifies GitHub release fallback URL helpers for desktop updates.
// Layer: Desktop update tests

import { describe, expect, it } from "vitest";

import {
  buildGitHubReleasesPageUrl,
  resolveGitHubUpdateSource,
  resolveGitLabReleasesPageUrl,
} from "./githubUpdateFeed";

describe("resolveGitHubUpdateSource", () => {
  it("returns null for non-github providers", () => {
    expect(resolveGitHubUpdateSource({ provider: "generic" })).toBeNull();
  });

  it("normalizes a github source with default host and protocol", () => {
    expect(
      resolveGitHubUpdateSource({
        provider: "github",
        owner: "openai",
        repo: "codex",
      }),
    ).toEqual({
      owner: "openai",
      repo: "codex",
      host: "github.com",
      protocol: "https",
    });
  });
});

describe("buildGitHubReleasesPageUrl", () => {
  it("points the manual fallback at the latest release page by default", () => {
    expect(
      buildGitHubReleasesPageUrl({
        owner: "openai",
        repo: "codex",
        host: "github.com",
        protocol: "https",
      }),
    ).toBe("https://github.com/openai/codex/releases/latest");
  });

  it("can point at a specific tag when one is known", () => {
    expect(
      buildGitHubReleasesPageUrl(
        {
          owner: "openai",
          repo: "codex",
          host: "github.com",
          protocol: "https",
        },
        "v0.0.31",
      ),
    ).toBe("https://github.com/openai/codex/releases/tag/v0.0.31");
  });
});

describe("resolveGitLabReleasesPageUrl", () => {
  it("points at the latest GitLab release page", () => {
    expect(
      resolveGitLabReleasesPageUrl({ provider: "gitlab", projectId: "squad/saint-releases" }),
    ).toBe("https://gitlab.com/squad/saint-releases/-/releases/permalink/latest");
    expect(
      resolveGitLabReleasesPageUrl({ provider: "gitlab", projectId: "squad%2Fsaint-releases" }),
    ).toBe("https://gitlab.com/squad/saint-releases/-/releases/permalink/latest");
    expect(
      resolveGitLabReleasesPageUrl({
        provider: "gitlab",
        projectId: "'squad/saint-releases'",
        host: "git.example.com",
      }),
    ).toBe("https://git.example.com/squad/saint-releases/-/releases/permalink/latest");
  });

  it("returns null for other providers and numeric project ids", () => {
    expect(resolveGitLabReleasesPageUrl({ provider: "github" })).toBeNull();
    expect(resolveGitLabReleasesPageUrl({ provider: "gitlab", projectId: "71361100" })).toBeNull();
  });
});
