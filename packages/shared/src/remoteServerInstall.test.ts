import { describe, expect, it } from "vitest";

import {
  createRemoteServerInstallManifest,
  isRemoteServerExternalModule,
  REMOTE_SERVER_INSTALLED_DEPENDENCIES,
  remoteServerPatchIndex,
} from "./remoteServerInstall";

const catalog = {
  effect: "https://pkg.example/effect@abc",
  typescript: "^5.7.3",
};

/** The installed dependencies as the server manifest declares them. */
const installedDependencies = {
  "node-pty": "^1.1.0",
  typescript: "catalog:",
  "@anthropic-ai/claude-agent-sdk": "0.3.296",
  open: "^10.1.0",
  "@xterm/headless": "^6.0.0",
};

describe("createRemoteServerInstallManifest", () => {
  it("installs only the dependencies the remote bundle keeps external", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: {
        version: "1.2.3",
        dependencies: {
          ...installedDependencies,
          effect: "catalog:",
          ws: "^8.21.0",
          "@earendil-works/pi-coding-agent": "^0.87.1",
        },
      },
      catalog,
    });
    expect(manifest.packageJson).toEqual({
      name: "saint-remote-server",
      version: "1.2.3",
      private: true,
      type: "module",
      dependencies: {
        "node-pty": "^1.1.0",
        typescript: "^5.7.3",
        "@anthropic-ai/claude-agent-sdk": "0.3.296",
        open: "^10.1.0",
        "@xterm/headless": "^6.0.0",
      },
      overrides: {},
    });
  });

  it("fails when an installed dependency is no longer a server dependency", () => {
    expect(() =>
      createRemoteServerInstallManifest({
        serverPackageJson: { version: "1.0.0", dependencies: { "node-pty": "^1.1.0" } },
        catalog,
      }),
    ).toThrow(/typescript/);
  });

  it("flattens Bun selectors and drops overrides that conflict with direct specs", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: { version: "1.0.0", dependencies: installedDependencies },
      catalog,
      overrides: {
        "@effect/platform-node>effect": "catalog:",
        "node-pty": "^1.0.0",
        axios: "^1.16.0",
      },
    });
    expect(manifest.packageJson.overrides).toEqual({
      effect: "https://pkg.example/effect@abc",
      axios: "^1.16.0",
    });
  });

  it("applies patches of installed packages on the host and leaves the rest to the bundle", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: { version: "1.0.0", dependencies: installedDependencies },
      catalog,
      patchedDependencies: {
        "node-pty@1.1.0": "patches/node-pty@1.1.0.patch",
        "@pierre/diffs@1.3.5": "patches/@pierre%2Fdiffs@1.3.5.patch",
      },
    });
    expect(manifest.packageJson.dependencies["node-pty"]).toBe("1.1.0");
    expect(manifest.packageJson.overrides).toEqual({});
    expect(remoteServerPatchIndex(manifest.patches)).toBe("node-pty\tnode-pty@1.1.0.patch\n");
    expect(manifest.bundledPatches).toEqual([
      {
        packageName: "@pierre/diffs",
        patchPath: "patches/@pierre%2Fdiffs@1.3.5.patch",
        fileName: "@pierre%2Fdiffs@1.3.5.patch",
      },
    ]);
  });

  it("refuses workspace and unresolved catalog dependencies", () => {
    expect(() =>
      createRemoteServerInstallManifest({
        serverPackageJson: {
          version: "1.0.0",
          dependencies: { ...installedDependencies, open: "workspace:*" },
        },
        catalog,
      }),
    ).toThrow(/workspace package/);
    expect(() =>
      createRemoteServerInstallManifest({
        serverPackageJson: { version: "1.0.0", dependencies: installedDependencies },
        catalog: {},
      }),
    ).toThrow(/Unable to resolve/);
  });
});

describe("isRemoteServerExternalModule", () => {
  it("keeps installed, refused-provider, and Bun modules external", () => {
    for (const name of REMOTE_SERVER_INSTALLED_DEPENDENCIES) {
      expect(isRemoteServerExternalModule(name)).toBe(true);
    }
    expect(isRemoteServerExternalModule("typescript/lib/lib.d.ts")).toBe(true);
    expect(isRemoteServerExternalModule("@agentclientprotocol/sdk")).toBe(true);
    expect(isRemoteServerExternalModule("bun:sqlite")).toBe(true);
  });

  it("bundles everything else, including look-alike names", () => {
    expect(isRemoteServerExternalModule("effect/Effect")).toBe(false);
    expect(isRemoteServerExternalModule("node-pty-prebuilt")).toBe(false);
    expect(isRemoteServerExternalModule("opener")).toBe(false);
  });
});
