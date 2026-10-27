// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const SAINT_DESKTOP_SCHEME = "saint";
export const SAINT_DESKTOP_ORIGIN = `${SAINT_DESKTOP_SCHEME}://app`;
export const SAINT_DESKTOP_ENTRY_URL = `${SAINT_DESKTOP_ORIGIN}/index.html`;
export const SAINT_DESKTOP_UPDATE_CHANNEL = "saint";
export const SAINT_PRODUCTION_BUNDLE_ID = "com.locotine.saint";
export const SAINT_DEVELOPMENT_BUNDLE_ID = `${SAINT_PRODUCTION_BUNDLE_ID}.dev`;
export const SAINT_CANARY_BUNDLE_ID = `${SAINT_PRODUCTION_BUNDLE_ID}.canary`;
/** Display/setup identity of the GUI host; this value does not confer native authority. */
export const SAINT_DESKTOP_BUNDLE_ID_ENV = "SAINT_DESKTOP_BUNDLE_ID";
export const SAINT_CANARY_DESKTOP_SCHEME = "saint-canary";
export const SAINT_CANARY_DESKTOP_ORIGIN = `${SAINT_CANARY_DESKTOP_SCHEME}://app`;
export const SAINT_CANARY_DESKTOP_ENTRY_URL = `${SAINT_CANARY_DESKTOP_ORIGIN}/index.html`;
export const SAINT_CUA_BUNDLE_ID = `${SAINT_PRODUCTION_BUNDLE_ID}.cua`;
export const SAINT_CUA_DESKTOP_SCHEME = "saint-cua";
export const SAINT_CUA_DESKTOP_ORIGIN = `${SAINT_CUA_DESKTOP_SCHEME}://app`;
export const SAINT_CUA_DESKTOP_ENTRY_URL = `${SAINT_CUA_DESKTOP_ORIGIN}/index.html`;
export const SAINT_BETA_BUNDLE_ID = `${SAINT_PRODUCTION_BUNDLE_ID}.beta`;
export const SAINT_BETA_DESKTOP_SCHEME = "saint-beta";
export const SAINT_BETA_DESKTOP_ORIGIN = `${SAINT_BETA_DESKTOP_SCHEME}://app`;
export const SAINT_BETA_DESKTOP_ENTRY_URL = `${SAINT_BETA_DESKTOP_ORIGIN}/index.html`;
export const SAINT_SOURCE_DESKTOP_BUILD_MARKER = "saint-source-desktop-build-v2";
export const SAINT_DESKTOP_SMOKE_USER_DATA_ENV = "SAINT_DESKTOP_SMOKE_USER_DATA";

export type SaintDesktopFlavor = "production" | "development" | "canary" | "cua" | "beta";
export const SAINT_PACKAGED_DESKTOP_FLAVORS = ["production", "canary", "cua", "beta"] as const;
export type SaintPackagedDesktopFlavor = (typeof SAINT_PACKAGED_DESKTOP_FLAVORS)[number];

/**
 * electron-updater matches the update channel against the release tag's
 * prerelease identifier, so the beta flavor must use the `beta` channel to see
 * `vX.Y.Z-beta.N` releases. Every other flavor keeps the `saint` channel.
 */
export function desktopUpdateChannel(flavor: SaintDesktopFlavor): string {
  return flavor === "beta" ? "beta" : SAINT_DESKTOP_UPDATE_CHANNEL;
}

export interface SaintDesktopIdentity {
  readonly flavor: SaintDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveSaintDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): SaintDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "cua") {
    return "cua";
  }
  if (requestedFlavor === "canary") {
    return "canary";
  }
  if (requestedFlavor === "beta") {
    return "beta";
  }
  if (
    requestedFlavor === "development" &&
    (input.isDevelopment || input.allowDevelopmentOverride === true)
  ) {
    return "development";
  }
  return input.isDevelopment ? "development" : "production";
}

/** Packaged identity is fixed when the artifact is staged, before it is signed. */
export function resolveSaintDesktopRuntimeFlavor(input: {
  readonly isPackaged: boolean;
  readonly isDevelopment: boolean;
  readonly packagedFlavor?: unknown;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): SaintDesktopFlavor {
  if (input.isPackaged && input.packagedFlavor !== undefined) {
    const flavor = input.packagedFlavor;
    if (flavor === "production" || flavor === "canary" || flavor === "cua" || flavor === "beta") {
      return flavor;
    }
    throw new Error("The packaged Saint desktop flavor is invalid. Rebuild the application.");
  }
  // Source launchers also use an app bundle on macOS. Their build marker keeps
  // the existing environment-based routing, while legacy packaged apps remain
  // Stable even when a developer shell happens to export a different flavor.
  if (input.isPackaged && input.allowDevelopmentOverride !== true) {
    return "production";
  }
  return resolveSaintDesktopFlavor(input);
}

export function canOverrideDesktopSmokeUserData(input: {
  readonly packagedFlavor?: unknown;
  readonly sourceBuildMarker?: string | undefined;
}): boolean {
  return (
    input.packagedFlavor === "cua" ||
    input.packagedFlavor === "beta" ||
    (input.packagedFlavor === undefined &&
      input.sourceBuildMarker === SAINT_SOURCE_DESKTOP_BUILD_MARKER)
  );
}

export function saintDesktopIdentity(flavor: SaintDesktopFlavor): SaintDesktopIdentity {
  if (flavor === "cua") {
    return {
      flavor,
      displayName: "Saint Cua",
      bundleId: SAINT_CUA_BUNDLE_ID,
      scheme: SAINT_CUA_DESKTOP_SCHEME,
      origin: SAINT_CUA_DESKTOP_ORIGIN,
      entryUrl: SAINT_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-cua",
      defaultHomeDirectoryName: ".saint-cua",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Saint Canary",
      bundleId: SAINT_CANARY_BUNDLE_ID,
      scheme: SAINT_CANARY_DESKTOP_SCHEME,
      origin: SAINT_CANARY_DESKTOP_ORIGIN,
      entryUrl: SAINT_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-canary",
      defaultHomeDirectoryName: ".saint-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "beta") {
    return {
      flavor,
      displayName: "Saint Beta",
      bundleId: SAINT_BETA_BUNDLE_ID,
      scheme: SAINT_BETA_DESKTOP_SCHEME,
      origin: SAINT_BETA_DESKTOP_ORIGIN,
      entryUrl: SAINT_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-beta",
      defaultHomeDirectoryName: ".saint-beta",
      usesScriptedUpdates: false,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Saint (Dev)",
      bundleId: SAINT_DEVELOPMENT_BUNDLE_ID,
      scheme: SAINT_DESKTOP_SCHEME,
      origin: SAINT_DESKTOP_ORIGIN,
      entryUrl: SAINT_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-dev",
      defaultHomeDirectoryName: ".saint-dev",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Saint",
    bundleId: SAINT_PRODUCTION_BUNDLE_ID,
    scheme: SAINT_DESKTOP_SCHEME,
    origin: SAINT_DESKTOP_ORIGIN,
    entryUrl: SAINT_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "saint",
    defaultHomeDirectoryName: ".saint",
    usesScriptedUpdates: false,
  };
}
