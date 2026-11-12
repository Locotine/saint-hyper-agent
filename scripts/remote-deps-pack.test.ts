import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyRemoteDepsPatches,
  checkRemoteDepsPack,
  diffRemoteDepsDescriptor,
  expectedRemoteDepsDescriptor,
  REMOTE_DEPS_REBUILD_HINT,
} from "./lib/remote-deps-pack.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("committed remote dependency pack", () => {
  it("matches this checkout's remote dependencies, patches and lockfile versions", () => {
    const problems = checkRemoteDepsPack(repoRoot, undefined, {
      recomputeTrees: process.platform !== "win32",
    });
    expect(problems, `${problems.join("\n")}\n${REMOTE_DEPS_REBUILD_HINT}`).toEqual([]);
    // Unpacks the 85 MB pack and hashes it once per host, which a shared CI runner needs a while for.
  }, 60_000);

  it("pins every remote dependency to an exact version", () => {
    const { dependencies } = expectedRemoteDepsDescriptor(repoRoot);
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name === "node-pty") expect(spec).toMatch(/^npm:@lydell\/node-pty@\d/u);
      else expect(spec, name).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });
});

describe("checkRemoteDepsPack tree hashes", () => {
  const packFixture = (trees: Record<string, string> | undefined) => {
    const dir = mkdtempSync(join(tmpdir(), "saint-remote-deps-check-"));
    temporaryDirs.push(dir);
    const committed = join(repoRoot, "apps/server/remote-deps");
    writeFileSync(join(dir, "deps.tar.gz"), readFileSync(join(committed, "deps.tar.gz")));
    const lock = JSON.parse(readFileSync(join(committed, "deps.json"), "utf8"));
    writeFileSync(join(dir, "deps.json"), JSON.stringify({ ...lock, trees }));
    return dir;
  };

  it("needs a tree hash for every host, without unpacking the pack", () => {
    const problems = checkRemoteDepsPack(repoRoot, packFixture(undefined));
    expect(problems).toEqual([expect.stringContaining("has no tree hash for darwin-arm64")]);
    const partial = checkRemoteDepsPack(repoRoot, packFixture({ "linux-x64": "a".repeat(64) }));
    expect(partial[0]).toContain("darwin-arm64, darwin-x64, linux-arm64");
  });

  it("notices a tree hash that no longer matches the pack when asked to recompute", () => {
    const hosts = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
    const wrong = Object.fromEntries(hosts.map((host) => [host, "0".repeat(64)]));
    const dir = packFixture(wrong);
    expect(checkRemoteDepsPack(repoRoot, dir)).toEqual([]);
    expect(checkRemoteDepsPack(repoRoot, dir, { recomputeTrees: true })).toEqual([
      expect.stringContaining("trees do not match"),
    ]);
  }, 60_000);
});

describe("diffRemoteDepsDescriptor", () => {
  const base = {
    dependencies: { open: "10.2.0" },
    overrides: { ws: "^8.21.0" },
    patches: {},
    nodePtyHosts: ["darwin-arm64", "linux-x64"],
  };

  it("accepts the same descriptor in any key order", () => {
    expect(
      diffRemoteDepsDescriptor(base, {
        nodePtyHosts: ["darwin-arm64", "linux-x64"],
        patches: {},
        overrides: { ws: "^8.21.0" },
        dependencies: { open: "10.2.0" },
      }),
    ).toEqual([]);
  });

  it("reports a changed patch, dependency version or host list", () => {
    expect(diffRemoteDepsDescriptor({ ...base, patches: { "open.patch": "a" } }, base)).toEqual([
      expect.stringContaining("patches differ"),
    ]);
    expect(diffRemoteDepsDescriptor({ ...base, dependencies: { open: "10.3.0" } }, base)).toEqual([
      expect.stringContaining("dependencies differ"),
    ]);
    expect(diffRemoteDepsDescriptor({ ...base, nodePtyHosts: ["linux-x64"] }, base)).toEqual([
      expect.stringContaining("nodePtyHosts differ"),
    ]);
  });
});

describe("applyRemoteDepsPatches", () => {
  it("patches each package inside node_modules and fails for a missing package", () => {
    const nodeModules = mkdtempSync(join(tmpdir(), "saint-remote-deps-test-"));
    temporaryDirs.push(nodeModules);
    mkdirSync(join(nodeModules, "open"));
    writeFileSync(join(nodeModules, "open/index.js"), "");
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const run = (command: string, args: string[], cwd: string) => {
      calls.push({ command, args, cwd });
    };
    const patch = {
      packageName: "open",
      spec: "10.2.0",
      patchPath: "patches/open.patch",
      fileName: "open.patch",
    };

    applyRemoteDepsPatches("/repo", nodeModules, [patch], run);
    expect(calls).toEqual([
      {
        command: "patch",
        args: ["-p1", "--forward", "--batch", "-i", join("/repo", "patches/open.patch")],
        cwd: join(nodeModules, "open"),
      },
    ]);
    expect(() =>
      applyRemoteDepsPatches("/repo", nodeModules, [{ ...patch, packageName: "missing" }], run),
    ).toThrow(/Cannot patch missing: it is not in the remote pack/u);
  });
});
