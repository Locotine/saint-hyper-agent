// FILE: useProviderStatusesForLocalConfig.ts
// Purpose: Normalize server provider health against local binary overrides for composer-like sends.
// Layer: Web hook
// Depends on: server config query, app settings, and provider availability normalization.

import type { ServerProviderStatus } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { useQuery } from "@tanstack/react-query";

import { getCustomBinaryPathForProviderInstance, useAppSettings } from "../appSettings";
import { loadConfirmedCustomBinaryPaths } from "../confirmedCustomBinaryPathStore";
import {
  normalizeProviderStatusForLocalConfig,
  providerStatusInstanceKey,
} from "../lib/providerAvailability";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { isProviderKind } from "../providerOrdering";

const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];

// A connected host reports its own providers; this computer's binary overrides and disabled
// providers say nothing about them, so they are used as reported.
export function useProviderStatusesForLocalConfig(
  hostId: HostId = LOCAL_HOST_ID,
): readonly ServerProviderStatus[] {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions(hostId));
  const disabledProviders = new Set(settings.disabledProviders);

  if (hostId !== LOCAL_HOST_ID) return serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES;

  const confirmedCustomBinaryPaths = loadConfirmedCustomBinaryPaths();
  return (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
    .map((status) => {
      const provider = status.driver ?? status.provider;
      if (!isProviderKind(provider)) {
        return status;
      }
      const providerInstanceId = providerStatusInstanceKey(status);
      return normalizeProviderStatusForLocalConfig({
        provider,
        status,
        customBinaryPath: getCustomBinaryPathForProviderInstance(
          settings,
          provider,
          providerInstanceId,
        ),
        confirmedCustomBinaryPath: confirmedCustomBinaryPaths[providerInstanceId],
        disabled: disabledProviders.has(provider),
      });
    })
    .flatMap((status) => (status ? [status] : []));
}
