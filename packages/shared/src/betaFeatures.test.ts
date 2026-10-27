import { describe, expect, it } from "vitest";

import {
  desktopFlavorFromBundleId,
  desktopFlavorFromProtocol,
  GROUPS_BETA_FEATURE,
  INLINE_VISUALS_BETA_FEATURE,
  isBetaFeatureEnabled,
  MCP_CONNECTORS_BETA_FEATURE,
  NATIVE_EDITOR_BETA_FEATURE,
  REMOTE_SSH_BETA_FEATURE,
} from "./betaFeatures";
import {
  SAINT_BETA_BUNDLE_ID,
  SAINT_CANARY_BUNDLE_ID,
  SAINT_CUA_BUNDLE_ID,
  SAINT_DEVELOPMENT_BUNDLE_ID,
  SAINT_PRODUCTION_BUNDLE_ID,
} from "./desktopIdentity";

describe("isBetaFeatureEnabled", () => {
  it.each(["inbox", "pull-request-auto-fix", "tasks"])(
    "offers %s in Stable and Beta",
    (feature) => {
      expect(isBetaFeatureEnabled(feature, "production")).toBe(true);
      expect(isBetaFeatureEnabled(feature, "beta")).toBe(true);
    },
  );

  it("enables Oh My Pi in Stable and all other flavors", () => {
    for (const flavor of [
      "production",
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled("omp", flavor)).toBe(true);
    }
  });

  it("offers Hubs in Stable and all other flavors", () => {
    for (const flavor of [
      "production",
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled(GROUPS_BETA_FEATURE, flavor)).toBe(true);
    }
  });

  it("offers inline visuals in Stable and all other flavors", () => {
    expect(isBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE, "production")).toBe(true);
    for (const flavor of ["beta", "development", "canary", "cua", "unknown"] as const) {
      expect(isBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE, flavor)).toBe(true);
    }
  });

  it.each([MCP_CONNECTORS_BETA_FEATURE, NATIVE_EDITOR_BETA_FEATURE])(
    "offers %s in Stable and all other flavors",
    (feature) => {
      for (const flavor of [
        "production",
        "beta",
        "development",
        "canary",
        "cua",
        "unknown",
      ] as const) {
        expect(isBetaFeatureEnabled(feature, flavor)).toBe(true);
      }
    },
  );

  it("ships remote SSH hosts in Stable and Beta", () => {
    for (const flavor of [
      "production",
      "beta",
      "development",
      "canary",
      "cua",
      "unknown",
    ] as const) {
      expect(isBetaFeatureEnabled(REMOTE_SSH_BETA_FEATURE, flavor)).toBe(true);
    }
  });

  it("enables the rail sidebar layout in both Beta and Stable", () => {
    expect(isBetaFeatureEnabled("sidebarV2", "beta")).toBe(true);
    expect(isBetaFeatureEnabled("sidebarV2", "production")).toBe(true);
  });

  it("enables audio-driven message trails in both Beta and Stable", () => {
    expect(isBetaFeatureEnabled("audio-trail", "beta")).toBe(true);
    expect(isBetaFeatureEnabled("audio-trail", "production")).toBe(true);
  });

  it("leaves unlisted features enabled everywhere", () => {
    // The list is the whole gate: a feature not present is enabled everywhere,
    // which is also the steady state once a feature is promoted to Stable.
    for (const flavor of [
      "development",
      "canary",
      "cua",
      "beta",
      "unknown",
      "production",
    ] as const) {
      expect(isBetaFeatureEnabled("codex", flavor)).toBe(true);
    }
  });
});

describe("desktopFlavorFromBundleId", () => {
  it("maps each known bundle id", () => {
    expect(desktopFlavorFromBundleId(SAINT_PRODUCTION_BUNDLE_ID)).toBe("production");
    expect(desktopFlavorFromBundleId(SAINT_DEVELOPMENT_BUNDLE_ID)).toBe("development");
    expect(desktopFlavorFromBundleId(SAINT_CANARY_BUNDLE_ID)).toBe("canary");
    expect(desktopFlavorFromBundleId(SAINT_CUA_BUNDLE_ID)).toBe("cua");
    expect(desktopFlavorFromBundleId(SAINT_BETA_BUNDLE_ID)).toBe("beta");
  });

  it("trims surrounding whitespace", () => {
    expect(desktopFlavorFromBundleId(` ${SAINT_BETA_BUNDLE_ID} `)).toBe("beta");
  });

  it("returns unknown for blank or unrecognized ids", () => {
    expect(desktopFlavorFromBundleId(undefined)).toBe("unknown");
    expect(desktopFlavorFromBundleId("")).toBe("unknown");
    expect(desktopFlavorFromBundleId("   ")).toBe("unknown");
    expect(desktopFlavorFromBundleId("com.example.other")).toBe("unknown");
  });
});

describe("desktopFlavorFromProtocol", () => {
  it("maps each desktop scheme", () => {
    expect(desktopFlavorFromProtocol("saint-beta:", false)).toBe("beta");
    expect(desktopFlavorFromProtocol("saint-canary:", false)).toBe("canary");
    expect(desktopFlavorFromProtocol("saint-cua:", false)).toBe("cua");
    expect(desktopFlavorFromProtocol("saint:", false)).toBe("production");
  });

  it("treats the saint scheme in a dev build as development", () => {
    expect(desktopFlavorFromProtocol("saint:", true)).toBe("development");
  });

  it("returns unknown for non-desktop protocols and missing values", () => {
    expect(desktopFlavorFromProtocol("http:", false)).toBe("unknown");
    expect(desktopFlavorFromProtocol("https:", true)).toBe("unknown");
    expect(desktopFlavorFromProtocol(undefined, false)).toBe("unknown");
  });
});
