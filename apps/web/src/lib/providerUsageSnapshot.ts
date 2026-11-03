// FILE: providerUsageSnapshot.ts
// Purpose: Normalize provider usage snapshots returned by the server into the
// same shapes consumed by the shared usage/rate-limit UI in the web app.

import type { ServerGetProviderUsageSnapshotResult } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";

import type { OpenUsageUsageLine } from "./openUsageRateLimits";
import type { ProviderRateLimit } from "./rateLimits";

export function isProviderUsageSnapshotNonOk(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): boolean {
  return snapshot?.status !== undefined && snapshot.status !== "ok";
}

/**
 * Another host shows only usage read from it successfully: a failed read (including a host that
 * is not connected), a missing snapshot or a non-ok one hides it rather than fall back to numbers
 * that may belong to another machine. This computer's usage renders as before.
 */
export function isHostUsageHidden(input: {
  hostId: HostId;
  isError: boolean;
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined;
}): boolean {
  if (input.hostId === LOCAL_HOST_ID) return false;
  return input.isError || !input.snapshot || isProviderUsageSnapshotNonOk(input.snapshot);
}

export function normalizeServerProviderUsageRateLimit(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): ProviderRateLimit | null {
  if (!snapshot || snapshot.limits.length === 0) {
    return null;
  }

  return {
    provider: snapshot.provider,
    updatedAt: snapshot.updatedAt,
    limits: snapshot.limits.map((limit) => ({
      window: limit.window,
      ...(limit.usedPercent !== undefined ? { usedPercent: limit.usedPercent } : {}),
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowDurationMins !== undefined
        ? { windowDurationMins: limit.windowDurationMins }
        : {}),
    })),
  };
}

export function normalizeServerProviderUsageLines(
  snapshot: ServerGetProviderUsageSnapshotResult | null | undefined,
): OpenUsageUsageLine[] {
  if (!snapshot || snapshot.usageLines.length === 0) {
    return [];
  }

  return snapshot.usageLines.map((line) => ({
    label: line.label,
    value: line.value,
    ...(line.subtitle ? { subtitle: line.subtitle } : {}),
  }));
}
