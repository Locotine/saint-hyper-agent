import {
  isBetaFeatureEnabled,
  MCP_CONNECTORS_BETA_FEATURE,
  REMOTE_SSH_BETA_FEATURE,
} from "@saint/shared/betaFeatures";
import { describe, expect, it } from "vitest";

import {
  isSettingsSectionAvailable,
  normalizeSettingsSection,
  SETTINGS_NAV_ITEMS,
  SETTINGS_SECTION_IDS,
} from "./settingsNavigation";

describe("settings sections", () => {
  it("hides Connectors where its Beta feature is off", () => {
    expect(isSettingsSectionAvailable("connectors", () => false)).toBe(false);
    expect(
      isSettingsSectionAvailable(
        "connectors",
        (feature) => feature === MCP_CONNECTORS_BETA_FEATURE,
      ),
    ).toBe(true);
    expect(isSettingsSectionAvailable("integrations", () => false)).toBe(true);
  });

  it("lists Connectors without a Beta badge and allows them on Stable", () => {
    expect(
      isSettingsSectionAvailable("connectors", (feature) =>
        isBetaFeatureEnabled(feature, "production"),
      ),
    ).toBe(true);
    const ids = SETTINGS_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Remote hosts also need the desktop bridge, which tests do not have.
    expect(ids.toSorted()).toEqual(
      SETTINGS_SECTION_IDS.filter((id) => id !== "remote-hosts").toSorted(),
    );
    expect(normalizeSettingsSection("connectors")).toBe("connectors");
    expect(SETTINGS_NAV_ITEMS.find((item) => item.id === "connectors")?.badge).toBeUndefined();
  });

  it("shows Remote hosts only on Beta desktop windows that expose the bridge", () => {
    const beta = (feature: string) => isBetaFeatureEnabled(feature, "beta");
    const stable = (feature: string) => isBetaFeatureEnabled(feature, "production");
    expect(isSettingsSectionAvailable("remote-hosts", beta, () => true)).toBe(true);
    expect(isSettingsSectionAvailable("remote-hosts", stable, () => true)).toBe(false);
    expect(isSettingsSectionAvailable("remote-hosts", beta, () => false)).toBe(false);
    expect(beta(REMOTE_SSH_BETA_FEATURE)).toBe(true);
    expect(normalizeSettingsSection("remote-hosts")).toBe("general");
  });

  it("falls back to General for unknown sections", () => {
    expect(normalizeSettingsSection("nope")).toBe("general");
    expect(normalizeSettingsSection(undefined)).toBe("general");
  });
});
