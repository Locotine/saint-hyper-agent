import {
  saintDesktopIdentity,
  type SaintPackagedDesktopFlavor,
} from "@saint/shared/desktopIdentity";

export function createDesktopArtifactIdentity(input: {
  readonly platform: "mac" | "linux" | "win";
  readonly flavor: SaintPackagedDesktopFlavor;
}) {
  // Stable's NSIS GUID deliberately survives public bundle ID changes. An
  // experimental installer must not register itself as that same product; beta
  // ships its own WINDOWS_BETA_INSTALLER_GUID, so it is exempt.
  if (input.platform === "win" && input.flavor !== "production" && input.flavor !== "beta") {
    throw new Error("Isolated desktop flavors are currently supported on macOS and Linux only.");
  }
  const identity = saintDesktopIdentity(input.flavor);
  const suffix = input.flavor === "production" ? "" : `-${input.flavor}`;
  return {
    identity,
    packageMetadata: {
      name: `saint-desktop${suffix}`,
      productName: identity.displayName,
      saintDesktopFlavor: input.flavor,
    },
    buildConfig: {
      appId: identity.bundleId,
      productName: identity.displayName,
      artifactName: `${identity.displayName.replaceAll(" ", "-")}-\${version}-\${arch}.\${ext}`,
      ...(input.flavor !== "production"
        ? { protocols: [{ name: identity.displayName, schemes: [identity.scheme] }] }
        : {}),
    },
    releaseDirectoryName: `release${suffix}`,
  };
}
