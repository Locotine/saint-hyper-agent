// FILE: remoteServerInstall.ts
// Purpose: Builds the npm manifest a remote SSH host installs the Saint server from.
// Layer: Shared runtime utility (desktop main and the desktop artifact build)
// Exports: createRemoteServerInstallManifest, remoteServerPatchIndex,
//          REMOTE_SERVER_OMITTED_DEPENDENCIES

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
  readonly patches: readonly RemoteServerPatch[];
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
 * Dependencies only the providers a remote server leaves out load (lazily), so
 * remote installs skip them. See REMOTE_SERVER_PROVIDERS in `./serverProviders`.
 */
export const REMOTE_SERVER_OMITTED_DEPENDENCIES: readonly string[] = [
  "@earendil-works/pi-coding-agent",
  "@agentclientprotocol/sdk",
];

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
  for (const [name, spec] of Object.entries(input.serverPackageJson.dependencies ?? {})) {
    if (REMOTE_SERVER_OMITTED_DEPENDENCIES.includes(name)) continue;
    dependencies[name] = resolveSpec(name, spec, input.catalog, "dependency");
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
  for (const [key, patchPath] of Object.entries(input.patchedDependencies ?? {})) {
    const parts = splitPatchedDependencyKey(key);
    if (!parts || typeof patchPath !== "string") continue;
    const [packageName, spec] = parts;
    if (dependencies[packageName] !== undefined) {
      dependencies[packageName] = spec;
      if (overrides[packageName] !== undefined) overrides[packageName] = spec;
    } else {
      overrides[packageName] = spec;
    }
    patches.push({ packageName, patchPath, fileName: patchFileName(patchPath) });
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
  };
}

/** Tab-separated `packageName<TAB>fileName` lines the remote install script reads. */
export function remoteServerPatchIndex(patches: readonly RemoteServerPatch[]): string {
  return patches.map((patch) => `${patch.packageName}\t${patch.fileName}\n`).join("");
}
