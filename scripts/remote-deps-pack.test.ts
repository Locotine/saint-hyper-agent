import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const problems = checkRemoteDepsPack(repoRoot);
    expect(problems, `${problems.join("\n")}\n${REMOTE_DEPS_REBUILD_HINT}`).toEqual([]);
  });

  it("pins every remote dependency to an exact version", () => {
    const { dependencies } = expectedRemoteDepsDescriptor(repoRoot);
    for (const [name, spec] of Object.entries(dependencies)) {
      if (name === "node-pty") expect(spec).toMatch(/^npm:@lydell\/node-pty@\d/u);
      else expect(spec, name).toMatch(/^\d+\.\d+\.\d+/u);
    }
  });
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
    const patch = { packageName: "open", patchPath: "patches/open.patch", fileName: "open.patch" };

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
