// FILE: remoteServerInstall.ts
// Purpose: Builds the npm manifest a remote SSH host installs the Saint server from.
// Layer: Shared runtime utility (desktop main and the desktop artifact build)
// Exports: createRemoteServerInstallManifest, remoteServerPatchIndex,
//          REMOTE_SERVER_INSTALLED_DEPENDENCIES, REMOTE_SERVER_EXTERNAL_MODULES,
//          isRemoteServerExternalModule, parsePatchAddedLines

/** A Bun patch the remote applies after `npm install`, since npm never reads `patchedDependencies`. */
export interface RemoteServerPatch {
  readonly packageName: string;
  /** Path of the patch file relative to the repository root, e.g. `patches/x.patch`. */
  readonly patchPath: string;
  /** Basename the patch is shipped under inside the install bundle's `patches/` folder. */
  readonly fileName: string;
}

export interface RemoteServerInstallManifest {
  readonly packageJson: {
    readonly name: string;
    readonly version: string;
    readonly private: true;
    readonly type: "module";
    readonly dependencies: Record<string, string>;
    readonly overrides: Record<string, string>;
  };
  /** Patches the host applies after `npm install` (installed dependencies only). */
  readonly patches: readonly RemoteServerPatch[];
  /**
   * Patches of every other package. The remote bundle inlines those from the
   * repository's patched install, so the build verifies them instead.
   */
  readonly bundledPatches: readonly RemoteServerPatch[];
}

export interface RemoteServerInstallManifestInput {
  readonly serverPackageJson: {
    readonly version: string;
    readonly dependencies?: Record<string, unknown>;
  };
  /** Root `workspaces.catalog`. */
  readonly catalog: Record<string, unknown>;
  /** Root `overrides` (Bun syntax: `parent>child` selectors allowed). */
  readonly overrides?: Record<string, unknown>;
  /** Root `patchedDependencies`: `name@spec` -> patch path. */
  readonly patchedDependencies?: Record<string, unknown>;
}

/**
 * The only server dependencies a remote host installs with npm. The remote
 * bundle (`apps/server/tsdown.remote.config.ts`) inlines every other package,
 * so a new version uploads plain JavaScript and the host reuses one install of
 * these per native ABI. Each one must stay a real package on disk: node-pty is
 * native, typescript reads its `lib.*.d.ts` files next to itself, the Agent SDK
 * resolves its own files, open runs the `xdg-open` script it ships, and the
 * server loads @xterm/headless through `createRequire`, which no bundler follows.
 */
export const REMOTE_SERVER_INSTALLED_DEPENDENCIES: readonly string[] = [
  "node-pty",
  "typescript",
  "@anthropic-ai/claude-agent-sdk",
  "open",
  "@xterm/headless",
];

/**
 * Modules the remote bundle leaves as imports but the host never installs:
 * Bun builtins (guarded by `process.versions.bun`), the SDKs of providers a
 * remote server refuses (loaded lazily), and the optional native helpers `ws`
 * probes for inside try/catch.
 */
const REMOTE_SERVER_UNINSTALLED_EXTERNALS: readonly string[] = [
  "@earendil-works/pi-coding-agent",
  "@agentclientprotocol/sdk",
  "@effect/sql-sqlite-bun",
  "bufferutil",
  "utf-8-validate",
];

/** Every module the remote bundle keeps external, installed or not. */
export const REMOTE_SERVER_EXTERNAL_MODULES: readonly string[] = [
  ...REMOTE_SERVER_INSTALLED_DEPENDENCIES,
  ...REMOTE_SERVER_UNINSTALLED_EXTERNALS,
];

/** Whether the remote bundle keeps `id` (a bare import specifier) external. */
export function isRemoteServerExternalModule(id: string): boolean {
  if (id.startsWith("bun:")) return true;
  return REMOTE_SERVER_EXTERNAL_MODULES.some((name) => id === name || id.startsWith(`${name}/`));
}

function resolveSpec(
  name: string,
  spec: unknown,
  catalog: Record<string, unknown>,
  label: string,
): string {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new Error(`Remote server ${label} '${name}' has no version spec.`);
  }
  if (spec.startsWith("workspace:")) {
    throw new Error(`Remote server ${label} '${name}' is a workspace package (${spec}).`);
  }
  if (!spec.startsWith("catalog:")) return spec;
  const key = spec.slice("catalog:".length).trim() || name;
  const resolved = catalog[key];
  if (typeof resolved !== "string" || resolved.length === 0) {
    throw new Error(`Unable to resolve '${spec}' for remote server ${label} '${name}'.`);
  }
  return resolved;
}

/** `@scope/name@spec` -> [`@scope/name`, `spec`]. */
function splitPatchedDependencyKey(key: string): readonly [string, string] | null {
  const at = key.indexOf("@", 1);
  if (at <= 0) return null;
  return [key.slice(0, at), key.slice(at + 1)];
}

function patchFileName(patchPath: string): string {
  return patchPath.slice(patchPath.lastIndexOf("/") + 1);
}

/**
 * Translate the server's Bun workspace manifest into one plain npm can install:
 * catalog specs resolved, patched packages pinned to the exact version their
 * patch targets, and overrides flattened to npm's top-level form. npm rejects an
 * override that disagrees with a direct dependency's spec, so those are dropped
 * and the direct spec wins.
 */
export function createRemoteServerInstallManifest(
  input: RemoteServerInstallManifestInput,
): RemoteServerInstallManifest {
  const dependencies: Record<string, string> = {};
  const serverDependencies = input.serverPackageJson.dependencies ?? {};
  for (const name of REMOTE_SERVER_INSTALLED_DEPENDENCIES) {
    if (!Object.hasOwn(serverDependencies, name)) {
      throw new Error(`Remote server dependency '${name}' is not a server dependency.`);
    }
    dependencies[name] = resolveSpec(name, serverDependencies[name], input.catalog, "dependency");
  }

  const overrides: Record<string, string> = {};
  for (const [selector, spec] of Object.entries(input.overrides ?? {})) {
    const name = selector.slice(selector.lastIndexOf(">") + 1).trim();
    const resolved = resolveSpec(name, spec, input.catalog, "override");
    const direct = dependencies[name];
    if (direct !== undefined && direct !== resolved) continue;
    overrides[name] = resolved;
  }

  const patches: RemoteServerPatch[] = [];
  const bundledPatches: RemoteServerPatch[] = [];
  for (const [key, patchPath] of Object.entries(input.patchedDependencies ?? {})) {
    const parts = splitPatchedDependencyKey(key);
    if (!parts || typeof patchPath !== "string") continue;
    const [packageName, spec] = parts;
    const patch = { packageName, patchPath, fileName: patchFileName(patchPath) };
    if (dependencies[packageName] === undefined) {
      bundledPatches.push(patch);
      continue;
    }
    dependencies[packageName] = spec;
    if (overrides[packageName] !== undefined) overrides[packageName] = spec;
    patches.push(patch);
  }

  return {
    packageJson: {
      name: "saint-remote-server",
      version: input.serverPackageJson.version,
      private: true,
      type: "module",
      dependencies,
      overrides,
    },
    patches,
    bundledPatches,
  };
}

/** Tab-separated `packageName<TAB>fileName` lines the remote install script reads. */
export function remoteServerPatchIndex(patches: readonly RemoteServerPatch[]): string {
  return patches.map((patch) => `${patch.packageName}\t${patch.fileName}\n`).join("");
}

export interface PatchFileExpectation {
  /** Path inside the patched package, e.g. `dist/index.js`. */
  readonly file: string;
  /** Trimmed, non-empty lines the patch adds to that file. */
  readonly addedLines: ReadonlyArray<string>;
}

/**
 * The lines a unified-diff patch adds, per target file. Builds check them in
 * installed packages because package managers can skip a tracked patch
 * silently (that shipped broken Windows provider updates in v0.5.2–v0.5.5).
 */
export function parsePatchAddedLines(patchContents: string): PatchFileExpectation[] {
  const expectations: Array<{ file: string; addedLines: string[] }> = [];
  let current: { file: string; addedLines: string[] } | null = null;
  for (const line of patchContents.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null;
        continue;
      }
      current = { file: target.startsWith("b/") ? target.slice(2) : target, addedLines: [] };
      expectations.push(current);
      continue;
    }
    if (current && line.startsWith("+")) {
      const added = line.slice(1).trim();
      if (added.length > 0) {
        current.addedLines.push(added);
      }
    }
  }
  return expectations.filter((expectation) => expectation.addedLines.length > 0);
}
