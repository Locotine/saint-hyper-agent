// FILE: AppRailUsage.logic.ts
// Purpose: Pure selection rules for the provider usage rings at the bottom of the app rail.

import type { ProviderInstanceId, ProviderKind } from "@saint/contracts";
import type { ResolvedProviderInstance } from "@saint/shared/providerInstances";
import { PROVIDER_USAGE_PROVIDERS, providerUsageDisplayName } from "@saint/shared/providerUsage";

import type { RailUsageWindow } from "~/appSettings";
import { providerAccountQualifiedLabel } from "~/lib/providerInstancePresentation";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

export const RAIL_USAGE_WINDOW_OPTIONS = [
  { value: "both", label: "Both" },
  { value: "fiveHour", label: "5h" },
  { value: "weekly", label: "Weekly" },
] as const satisfies ReadonlyArray<{ value: RailUsageWindow; label: string }>;

export interface RailUsageAccount {
  readonly instance: ResolvedProviderInstance;
  readonly label: string;
  readonly dotted: boolean;
}

/** Enabled usage-capable accounts, named consistently in Settings and the rail. */
export function getRailUsageAccounts(
  instances: ReadonlyArray<ResolvedProviderInstance>,
  disabledProviders: ReadonlyArray<ProviderKind> = [],
): ReadonlyArray<RailUsageAccount> {
  return PROVIDER_USAGE_PROVIDERS.flatMap((provider) => {
    const accounts = instances.filter(
      (instance) =>
        instance.enabled &&
        instance.driver === provider &&
        !disabledProviders.includes(instance.driver),
    );
    const providerName = providerUsageDisplayName(provider);
    return accounts.map((instance) => {
      const showAccountName =
        !instance.isDefault || accounts.length > 1 || Boolean(instance.raw.displayName?.trim());
      const accountName =
        instance.isDefault && !instance.raw.displayName?.trim()
          ? "Default account"
          : instance.displayName;
      return {
        instance,
        dotted: accounts.length > 1 && !instance.isDefault,
        label: showAccountName
          ? providerAccountQualifiedLabel(providerName, accountName)
          : providerName,
      };
    });
  });
}

/**
 * Stored selection → unique available accounts.
 * `null` means show all available enabled accounts (every connected provider).
 */
export function resolveRailUsageAccounts(
  selected: ReadonlyArray<ProviderInstanceId> | null,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<RailUsageAccount> {
  if (selected === null) {
    return available;
  }
  const byId = new Map(available.map((account) => [account.instance.instanceId, account]));
  return [...new Set(selected)].flatMap((instanceId) => {
    const account = byId.get(instanceId);
    return account ? [account] : [];
  });
}

/** Whether every currently available account is selected for the sidebar rail. */
export function areAllRailUsageAccountsSelected(
  selected: ReadonlyArray<ProviderInstanceId> | null,
  available: ReadonlyArray<RailUsageAccount>,
): boolean {
  if (selected === null) {
    return true;
  }
  const selectedSet = new Set(selected);
  return available.every((account) => selectedSet.has(account.instance.instanceId));
}

/**
 * Next selection after toggling an account in Settings or the sidebar quick menu.
 * Materializes `null` (show-all) into an explicit list when an account is toggled off,
 * while preserving hidden/disabled accounts already saved in an explicit selection.
 */
export function toggleRailUsageAccount(
  selected: ReadonlyArray<ProviderInstanceId> | null,
  instanceId: ProviderInstanceId,
  enabled: boolean,
  available: ReadonlyArray<RailUsageAccount>,
): ReadonlyArray<ProviderInstanceId> {
  const current =
    selected === null
      ? available.map((account) => account.instance.instanceId)
      : [...new Set(selected)];
  if (!enabled) {
    return current.filter((entry) => entry !== instanceId);
  }
  if (current.includes(instanceId)) {
    return current;
  }
  return [...current, instanceId];
}

/**
 * The rows a rail ring draws, outermost first. Named model/pool sublimits can share the
 * account windows' durations, so the account rows are picked by label. A provider that does
 * not report the chosen window shows its other account window, and one with neither keeps
 * its most constrained row, so a chosen provider never loses its ring.
 */
export function selectRailUsageRows(
  rows: ReadonlyArray<ProviderUsageDisplayRow>,
  primaryRow: ProviderUsageDisplayRow | null,
  window: RailUsageWindow,
): ReadonlyArray<ProviderUsageDisplayRow> {
  const weekly = rows.find((row) => row.label === "Weekly");
  const fiveHour = rows.find((row) => row.label === "5h");
  const preferred =
    window === "both"
      ? [weekly, fiveHour]
      : window === "weekly"
        ? [weekly ?? fiveHour]
        : [fiveHour ?? weekly];
  const selected = preferred.filter((row) => row !== undefined);
  if (selected.length > 0) {
    return selected;
  }
  return primaryRow ? [primaryRow] : [];
}

export type RailUsageRingTone = "healthy" | "fair" | "low" | "critical";

/** Remaining quota → ring colour step; the last two match the usage bars' warning/danger. */
export function railUsageRingTone(remainingPercent: number): RailUsageRingTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "low";
  if (remainingPercent <= 50) return "fair";
  return "healthy";
}
