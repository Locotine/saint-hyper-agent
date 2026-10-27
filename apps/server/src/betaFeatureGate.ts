// FILE: betaFeatureGate.ts
// Purpose: The server's read of the shared Beta-only feature list.
// Layer: Runtime gate (consumed by settings projection and provider messaging)
// Exports: SERVER_DESKTOP_FLAVOR, isServerBetaFeatureEnabled, isServerProviderAvailable,
//          isServerProviderAllowed

import { desktopFlavorFromBundleId, isBetaFeatureEnabled } from "@saint/shared/betaFeatures";
import { SAINT_DESKTOP_BUNDLE_ID_ENV } from "@saint/shared/desktopIdentity";
import { parseServerProviderAllowlist, SAINT_PROVIDERS_ENV } from "@saint/shared/serverProviders";

/** The hosting desktop's flavor; "unknown" (non-desktop hosts) keeps Beta-only features on. */
export const SERVER_DESKTOP_FLAVOR = desktopFlavorFromBundleId(
  process.env[SAINT_DESKTOP_BUNDLE_ID_ENV],
);

export const isServerBetaFeatureEnabled = (feature: string): boolean =>
  isBetaFeatureEnabled(feature, SERVER_DESKTOP_FLAVOR);

/** `SAINT_PROVIDERS`: remote SSH servers run only the providers they installed. */
const SERVER_PROVIDER_ALLOWLIST = parseServerProviderAllowlist(process.env[SAINT_PROVIDERS_ENV]);

export const isServerProviderAllowed = (provider: string): boolean =>
  SERVER_PROVIDER_ALLOWLIST === null || SERVER_PROVIDER_ALLOWLIST.has(provider);

/** A provider this server can run: on for this build and allowed on this host. */
export const isServerProviderAvailable = (provider: string): boolean =>
  isServerBetaFeatureEnabled(provider) && isServerProviderAllowed(provider);
