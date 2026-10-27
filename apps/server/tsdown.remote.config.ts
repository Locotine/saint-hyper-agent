// FILE: tsdown.remote.config.ts
// Purpose: Builds the server bundle remote SSH hosts run (`dist/remote`). Unlike
//          `dist`, it inlines every pure-JavaScript dependency, so a host installs
//          only the few packages that must stay on disk (see
//          REMOTE_SERVER_INSTALLED_DEPENDENCIES) instead of the full dependency tree.
// Layer: Server build config
// Depends on: tsdown, tsdown.config.ts.

import * as fs from "node:fs";
import { builtinModules } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

import {
  createRemoteServerInstallManifest,
  isRemoteServerExternalModule,
  parsePatchAddedLines,
} from "../../packages/shared/src/remoteServerInstall.ts";
import rootPackageJson from "../../package.json" with { type: "json" };
import serverPackageJson from "./package.json" with { type: "json" };
import baseConfig from "./tsdown.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const builtins = new Set(builtinModules);

type RemoteBundlePlugin = NonNullable<
  Extract<NonNullable<Parameters<typeof defineConfig>[0]>, { plugins?: unknown }>["plugins"]
>;

/** `effect/Stream` -> `effect`, `@scope/name/x` -> `@scope/name`; null for paths and builtins. */
function bareModuleName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return builtins.has(name) ? null : name;
}

// Runtime `require` calls (through `createRequire`) are invisible to the bundler,
// so a package loaded that way would be missing on the host.
const RUNTIME_REQUIRE_PATTERN = /\b(?:require|__require)\(\s*"([^"]+)"\s*\)/gu;

/**
 * Fails the build when the bundle needs a module the host will not have: an
 * import the bundler left external without being listed, or a runtime require
 * of a package that is neither inlined nor installed.
 */
function verifyRemoteExternals() {
  return {
    name: "saint-remote-externals",
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      const missing = new Set<string>();
      for (const output of Object.values(bundle)) {
        const chunk = output as {
          type?: string;
          code?: string;
          imports?: string[];
          dynamicImports?: string[];
        };
        if (chunk.type !== "chunk") continue;
        const specifiers = [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])];
        for (const match of (chunk.code ?? "").matchAll(RUNTIME_REQUIRE_PATTERN)) {
          if (match[1]) specifiers.push(match[1]);
        }
        for (const specifier of specifiers) {
          // `imports` also names the bundle's own chunks by file name.
          if (Object.hasOwn(bundle, specifier)) continue;
          const name = bareModuleName(specifier);
          if (name && !isRemoteServerExternalModule(specifier)) missing.add(name);
        }
      }
      if (missing.size > 0) {
        throw new Error(
          `The remote server bundle needs modules a remote host does not install: ${[...missing].join(", ")}. ` +
            "Bundle them, or list them in REMOTE_SERVER_INSTALLED_DEPENDENCIES (packages/shared/src/remoteServerInstall.ts).",
        );
      }
    },
  };
}

/**
 * The bundle inlines patched packages from this checkout's install, so every
 * line their tracked patch adds must be in the copy the bundler read.
 */
function verifyBundledPatches() {
  const manifest = createRemoteServerInstallManifest({
    serverPackageJson,
    catalog: rootPackageJson.workspaces.catalog,
    overrides: rootPackageJson.overrides,
    patchedDependencies: rootPackageJson.patchedDependencies,
  });
  return {
    name: "saint-remote-bundled-patches",
    buildEnd(this: { getModuleIds(): IterableIterator<string> }, error?: Error) {
      if (error) return;
      const moduleIds = [...this.getModuleIds()].map((id) => id.replaceAll("\\", "/"));
      for (const patch of manifest.bundledPatches) {
        const marker = `/node_modules/${patch.packageName}/`;
        const roots = new Set<string>();
        for (const id of moduleIds) {
          const index = id.lastIndexOf(marker);
          if (index !== -1) roots.add(id.slice(0, index + marker.length));
        }
        const contents = fs.readFileSync(path.join(repoRoot, patch.patchPath), "utf8");
        for (const root of roots) {
          for (const expectation of parsePatchAddedLines(contents)) {
            const file = path.join(root, expectation.file);
            const source = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
            const absent = expectation.addedLines.find((line) => !source.includes(line));
            if (absent !== undefined) {
              throw new Error(
                `${patch.packageName} at ${root} is missing ${patch.patchPath}: ${expectation.file} ` +
                  `does not contain "${absent}". Run 'bun install' to reapply tracked patches.`,
              );
            }
          }
        }
      }
    },
  };
}

export default defineConfig({
  ...baseConfig,
  // The remote runs only the server and the editor's language worker it spawns.
  entry: {
    index: "src/index.ts",
    languageWorker: "src/editor/languageWorker.ts",
  },
  outDir: "dist/remote",
  external: [/^bun:/u],
  noExternal: (id) => !isRemoteServerExternalModule(id),
  // Inlining dependencies is the point of this bundle.
  inlineOnly: false,
  plugins: [verifyRemoteExternals(), verifyBundledPatches()] as RemoteBundlePlugin,
});
