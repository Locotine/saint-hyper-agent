import { describe, expect, it } from "vitest";

import { createRemoteServerInstallManifest, remoteServerPatchIndex } from "./remoteServerInstall";

const catalog = {
  effect: "https://pkg.example/effect@abc",
  "@effect/platform-node": "https://pkg.example/@effect/platform-node@abc",
};

describe("createRemoteServerInstallManifest", () => {
  it("resolves catalog specs and keeps plain ranges", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: {
        version: "1.2.3",
        dependencies: { effect: "catalog:", ws: "^8.21.0", "@effect/platform-node": "catalog:" },
      },
      catalog,
    });
    expect(manifest.packageJson).toEqual({
      name: "saint-remote-server",
      version: "1.2.3",
      private: true,
      type: "module",
      dependencies: {
        effect: "https://pkg.example/effect@abc",
        ws: "^8.21.0",
        "@effect/platform-node": "https://pkg.example/@effect/platform-node@abc",
      },
      overrides: {},
    });
  });

  it("leaves out the SDKs of providers a remote server does not run", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: {
        version: "1.2.3",
        dependencies: {
          ws: "^8.21.0",
          "@earendil-works/pi-coding-agent": "^0.87.1",
          "@agentclientprotocol/sdk": "^0.20.0",
          "@anthropic-ai/claude-agent-sdk": "0.3.296",
        },
      },
      catalog,
    });
    expect(manifest.packageJson.dependencies).toEqual({
      ws: "^8.21.0",
      "@anthropic-ai/claude-agent-sdk": "0.3.296",
    });
  });

  it("flattens Bun selectors and drops overrides that conflict with direct specs", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: {
        version: "1.0.0",
        dependencies: { effect: "catalog:", "smol-toml": "^1.7.0", ws: "^8.21.0" },
      },
      catalog,
      overrides: {
        "@effect/platform-node>effect": "catalog:",
        "smol-toml": "^1.6.1",
        ws: "^8.21.0",
        axios: "^1.16.0",
      },
    });
    expect(manifest.packageJson.overrides).toEqual({
      effect: "https://pkg.example/effect@abc",
      ws: "^8.21.0",
      axios: "^1.16.0",
    });
  });

  it("pins patched packages to the version their patch targets", () => {
    const manifest = createRemoteServerInstallManifest({
      serverPackageJson: {
        version: "1.0.0",
        dependencies: { "@pierre/diffs": "^1.2.12" },
      },
      catalog,
      patchedDependencies: {
        "@pierre/diffs@1.3.5": "patches/@pierre%2Fdiffs@1.3.5.patch",
        "@effect/platform-node-shared@https://pkg.example/shared@abc":
          "patches/@effect%2Fplatform-node-shared@abc.patch",
      },
    });
    expect(manifest.packageJson.dependencies).toEqual({ "@pierre/diffs": "1.3.5" });
    expect(manifest.packageJson.overrides).toEqual({
      "@effect/platform-node-shared": "https://pkg.example/shared@abc",
    });
    expect(remoteServerPatchIndex(manifest.patches)).toBe(
      "@pierre/diffs\t@pierre%2Fdiffs@1.3.5.patch\n" +
        "@effect/platform-node-shared\t@effect%2Fplatform-node-shared@abc.patch\n",
    );
  });

  it("refuses workspace and unresolved catalog dependencies", () => {
    expect(() =>
      createRemoteServerInstallManifest({
        serverPackageJson: { version: "1.0.0", dependencies: { "@saint/shared": "workspace:*" } },
        catalog,
      }),
    ).toThrow(/workspace package/);
    expect(() =>
      createRemoteServerInstallManifest({
        serverPackageJson: { version: "1.0.0", dependencies: { vitest: "catalog:" } },
        catalog,
      }),
    ).toThrow(/Unable to resolve/);
  });
});
