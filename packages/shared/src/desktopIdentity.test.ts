import { describe, expect, it } from "vitest";

import {
  desktopUpdateChannel,
  resolveSaintDesktopFlavor,
  resolveSaintDesktopRuntimeFlavor,
  canOverrideDesktopSmokeUserData,
  SAINT_SOURCE_DESKTOP_BUILD_MARKER,
  SAINT_BETA_BUNDLE_ID,
  SAINT_BETA_DESKTOP_ENTRY_URL,
  SAINT_BETA_DESKTOP_ORIGIN,
  SAINT_CANARY_BUNDLE_ID,
  SAINT_CANARY_DESKTOP_ENTRY_URL,
  SAINT_CANARY_DESKTOP_ORIGIN,
  SAINT_CUA_BUNDLE_ID,
  SAINT_CUA_DESKTOP_ENTRY_URL,
  SAINT_CUA_DESKTOP_ORIGIN,
  SAINT_DESKTOP_ENTRY_URL,
  SAINT_DESKTOP_ORIGIN,
  SAINT_DESKTOP_UPDATE_CHANNEL,
  SAINT_DEVELOPMENT_BUNDLE_ID,
  SAINT_PRODUCTION_BUNDLE_ID,
  saintDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SAINT_PRODUCTION_BUNDLE_ID).toBe("com.locotine.saint");
    expect(SAINT_DEVELOPMENT_BUNDLE_ID).toBe("com.locotine.saint.dev");
    expect(saintDesktopIdentity("production").bundleId).toBe(SAINT_PRODUCTION_BUNDLE_ID);
    expect(saintDesktopIdentity("development").bundleId).toBe(SAINT_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SAINT_DESKTOP_ORIGIN).toBe("saint://app");
    expect(SAINT_DESKTOP_ENTRY_URL).toBe("saint://app/index.html");
  });

  it("uses the isolated Saint desktop update channel", () => {
    expect(SAINT_DESKTOP_UPDATE_CHANNEL).toBe("saint");
  });

  it("matches the beta update channel to prerelease tags and keeps saint otherwise", () => {
    expect(desktopUpdateChannel("beta")).toBe("beta");
    expect(desktopUpdateChannel("production")).toBe(SAINT_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("canary")).toBe(SAINT_DESKTOP_UPDATE_CHANNEL);
    expect(desktopUpdateChannel("development")).toBe(SAINT_DESKTOP_UPDATE_CHANNEL);
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SAINT_CANARY_BUNDLE_ID).toBe("com.locotine.saint.canary");
    expect(SAINT_CANARY_DESKTOP_ORIGIN).toBe("saint-canary://app");
    expect(SAINT_CANARY_DESKTOP_ENTRY_URL).toBe("saint-canary://app/index.html");
    expect(saintDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Saint Canary",
      bundleId: SAINT_CANARY_BUNDLE_ID,
      scheme: "saint-canary",
      origin: SAINT_CANARY_DESKTOP_ORIGIN,
      entryUrl: SAINT_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-canary",
      defaultHomeDirectoryName: ".saint-canary",
      usesScriptedUpdates: true,
    });
  });

  it("gives Cua a fully separate desktop identity and storage profile", () => {
    expect(SAINT_CUA_BUNDLE_ID).toBe("com.locotine.saint.cua");
    expect(SAINT_CUA_DESKTOP_ORIGIN).toBe("saint-cua://app");
    expect(SAINT_CUA_DESKTOP_ENTRY_URL).toBe("saint-cua://app/index.html");
    expect(saintDesktopIdentity("cua")).toEqual({
      flavor: "cua",
      displayName: "Saint Cua",
      bundleId: SAINT_CUA_BUNDLE_ID,
      scheme: "saint-cua",
      origin: SAINT_CUA_DESKTOP_ORIGIN,
      entryUrl: SAINT_CUA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-cua",
      defaultHomeDirectoryName: ".saint-cua",
      usesScriptedUpdates: true,
    });
  });

  it("gives Beta a fully separate desktop identity and storage profile", () => {
    expect(SAINT_BETA_BUNDLE_ID).toBe("com.locotine.saint.beta");
    expect(SAINT_BETA_DESKTOP_ORIGIN).toBe("saint-beta://app");
    expect(SAINT_BETA_DESKTOP_ENTRY_URL).toBe("saint-beta://app/index.html");
    expect(saintDesktopIdentity("beta")).toEqual({
      flavor: "beta",
      displayName: "Saint Beta",
      bundleId: SAINT_BETA_BUNDLE_ID,
      scheme: "saint-beta",
      origin: SAINT_BETA_DESKTOP_ORIGIN,
      entryUrl: SAINT_BETA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "saint-beta",
      defaultHomeDirectoryName: ".saint-beta",
      usesScriptedUpdates: false,
    });
  });

  it("selects explicit source flavors without changing packaged Stable", () => {
    expect(resolveSaintDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSaintDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(
      resolveSaintDesktopFlavor({ isDevelopment: false, requestedFlavor: "development" }),
    ).toBe("production");
    expect(
      resolveSaintDesktopFlavor({
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(resolveSaintDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSaintDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
    expect(resolveSaintDesktopFlavor({ isDevelopment: false, requestedFlavor: "cua" })).toBe("cua");
    expect(resolveSaintDesktopFlavor({ isDevelopment: true, requestedFlavor: "CUA" })).toBe("cua");
    expect(resolveSaintDesktopFlavor({ isDevelopment: false, requestedFlavor: "beta" })).toBe(
      "beta",
    );
    expect(resolveSaintDesktopFlavor({ isDevelopment: false, requestedFlavor: " beta " })).toBe(
      "beta",
    );
    expect(resolveSaintDesktopFlavor({ isDevelopment: true, requestedFlavor: "beta" })).toBe(
      "beta",
    );
  });

  it("isolates development and Canary homes from packaged Stable", () => {
    expect(saintDesktopIdentity("development").defaultHomeDirectoryName).toBe(".saint-dev");
    expect(saintDesktopIdentity("canary").defaultHomeDirectoryName).toBe(".saint-canary");
    expect(saintDesktopIdentity("cua").defaultHomeDirectoryName).toBe(".saint-cua");
    expect(saintDesktopIdentity("beta").defaultHomeDirectoryName).toBe(".saint-beta");
    expect(saintDesktopIdentity("production").defaultHomeDirectoryName).toBe(".saint");
  });

  it.each(["production", "canary", "cua", "beta"] as const)(
    "uses the immutable %s package flavor despite inherited source settings",
    (packagedFlavor) => {
      expect(
        resolveSaintDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: true,
          packagedFlavor,
          requestedFlavor: "development",
          allowDevelopmentOverride: true,
        }),
      ).toBe(packagedFlavor);
    },
  );

  it("keeps legacy packaged Stable independent from a source shell's flavor", () => {
    expect(
      resolveSaintDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "cua",
      }),
    ).toBe("production");
  });

  it("preserves source launcher routing, including its bundled macOS bootstrap", () => {
    expect(
      resolveSaintDesktopRuntimeFlavor({
        isPackaged: true,
        isDevelopment: false,
        requestedFlavor: "development",
        allowDevelopmentOverride: true,
      }),
    ).toBe("development");
    expect(
      resolveSaintDesktopRuntimeFlavor({
        isPackaged: false,
        isDevelopment: true,
        requestedFlavor: "canary",
      }),
    ).toBe("canary");
  });

  it.each(["development", "CUA", null])(
    "rejects malformed packaged identity %j before opening any profile",
    (packagedFlavor) => {
      expect(() =>
        resolveSaintDesktopRuntimeFlavor({
          isPackaged: true,
          isDevelopment: false,
          packagedFlavor,
        }),
      ).toThrow("packaged Saint desktop flavor is invalid");
    },
  );

  it("isolates smoke profiles only for source launches or isolated packages", () => {
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "cua" })).toBe(true);
    expect(canOverrideDesktopSmokeUserData({ packagedFlavor: "beta" })).toBe(true);
    expect(
      canOverrideDesktopSmokeUserData({
        sourceBuildMarker: SAINT_SOURCE_DESKTOP_BUILD_MARKER,
      }),
    ).toBe(true);
    for (const packagedFlavor of ["production", "canary", "development", null]) {
      expect(
        canOverrideDesktopSmokeUserData({
          packagedFlavor,
          sourceBuildMarker: SAINT_SOURCE_DESKTOP_BUILD_MARKER,
        }),
      ).toBe(false);
    }
    expect(canOverrideDesktopSmokeUserData({})).toBe(false);
  });
});
