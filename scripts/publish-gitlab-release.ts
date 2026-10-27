// FILE: publish-gitlab-release.ts
// Purpose: Uploads locally built desktop installers and updater manifests to a GitLab
//          Releases feed (see `resolveGitLabPublishConfig` in build-desktop-artifact.ts).
// Usage: GITLAB_TOKEN=... node scripts/publish-gitlab-release.ts [asset-dir]
//          [--project namespace/project] [--host gitlab.com] [--ref main]
//        Run once per build machine; each run adds its files to the same release.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "saint-desktop";
const ASSET_PATTERN = /\.(?:dmg|zip|exe|AppImage|blockmap|yml)$/u;
/** Unversioned assets every release carries next to its installers. */
const RELEASE_HELPERS = ["install-saint.sh", "copy-saint-beta-data.sh", "copy-saint-beta-data.ps1"];

export interface GitLabReleaseOptions {
  readonly assetDir: string;
  readonly project: string;
  readonly host: string;
  readonly ref: string;
  readonly token: string;
}

/** Installers, blockmaps, updater manifests and helpers; electron-builder's debug files stay local. */
export function selectReleaseAssets(fileNames: readonly string[]): string[] {
  return fileNames
    .filter(
      (name) =>
        RELEASE_HELPERS.includes(name) ||
        (ASSET_PATTERN.test(name) && !name.startsWith("builder-")),
    )
    .toSorted();
}

/** The version every updater manifest in the folder announces; they must agree. */
export function readReleaseVersion(manifests: ReadonlyArray<{ name: string; contents: string }>) {
  const versions = new Set<string>();
  for (const manifest of manifests) {
    const match = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/mu.exec(manifest.contents);
    if (!match?.[1]) throw new Error(`${manifest.name} has no version.`);
    versions.add(match[1]);
  }
  if (versions.size !== 1) {
    throw new Error(
      versions.size === 0
        ? "No updater manifest (latest*.yml) found. Build with SAINT_DESKTOP_UPDATE_GITLAB_PROJECT set."
        : `Updater manifests disagree on the version: ${[...versions].join(", ")}.`,
    );
  }
  return [...versions][0]!;
}

function parseArgs(args: readonly string[]): GitLabReleaseOptions {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
    flags.set(arg.slice(2), value);
    index += 1;
  }
  const project = flags.get("project") ?? process.env.SAINT_DESKTOP_UPDATE_GITLAB_PROJECT ?? "";
  if (!project.includes("/")) {
    throw new Error("Set --project or SAINT_DESKTOP_UPDATE_GITLAB_PROJECT to namespace/project.");
  }
  const token = process.env.GITLAB_TOKEN ?? "";
  if (!token) throw new Error("Set GITLAB_TOKEN to a token with the api scope on the project.");
  return {
    assetDir: resolve(positionals[0] ?? "release"),
    project,
    host: flags.get("host") ?? process.env.SAINT_DESKTOP_UPDATE_GITLAB_HOST ?? "gitlab.com",
    ref: flags.get("ref") ?? "main",
    token,
  };
}

async function publish(options: GitLabReleaseOptions): Promise<void> {
  const api = `https://${options.host}/api/v4/projects/${encodeURIComponent(options.project)}`;
  const headers = { "PRIVATE-TOKEN": options.token };
  // Only a GET may come back missing; any other 404 is a failure.
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as unknown;
  };

  const assets = selectReleaseAssets(readdirSync(options.assetDir));
  const manifests = assets
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, contents: readFileSync(join(options.assetDir, name), "utf8") }));
  const version = readReleaseVersion(manifests);
  const tag = `v${version}`;
  const binaries = assets.filter(
    (name) => name.endsWith(".yml") || name.includes(version) || RELEASE_HELPERS.includes(name),
  );

  const links: Array<{ name: string; url: string }> = [];
  for (const name of binaries) {
    const path = `/packages/generic/${PACKAGE_NAME}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
    const size = statSync(join(options.assetDir, name)).size;
    console.log(`Uploading ${name} (${(size / 1_048_576).toFixed(1)} MB)...`);
    const response = await fetch(`${api}${path}`, {
      method: "PUT",
      headers,
      body: readFileSync(join(options.assetDir, name)),
    });
    if (!response.ok) {
      throw new Error(`Upload of ${name} failed (${response.status}): ${await response.text()}`);
    }
    links.push({ name, url: `${api}${path}` });
  }

  const release = (await request("GET", `/releases/${encodeURIComponent(tag)}`)) as {
    assets?: { links?: Array<{ id: number; name: string }> };
  } | null;
  if (!release) {
    await request("POST", "/releases", { tag_name: tag, ref: options.ref, name: tag });
  }
  const existing = new Map((release?.assets?.links ?? []).map((link) => [link.name, link.id]));
  for (const link of links) {
    const id = existing.get(link.name);
    const body = { name: link.name, url: link.url, link_type: "package" };
    if (id === undefined) {
      await request("POST", `/releases/${encodeURIComponent(tag)}/assets/links`, body);
    } else {
      await request("PUT", `/releases/${encodeURIComponent(tag)}/assets/links/${id}`, body);
    }
  }
  console.log(`Published ${links.length} files to ${options.project} release ${tag}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publish(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
