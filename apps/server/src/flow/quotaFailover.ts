// FILE: quotaFailover.ts
// Purpose: What a flow step does when its provider runs out of quota — switch to another allowed
//          provider (never one with weaker data terms), ask the person, or wait for the reset.
// Layer: Server flow domain (pure)

import type { FlowDataTerms, FlowNodeSpec, FlowSpec, ProviderKind } from "@saint/contracts";

/** How long a `wait` step sleeps before trying again when the provider gave no reset time. */
export const QUOTA_WAIT_MS = 15 * 60_000;

const QUOTA_ERROR =
  /rate[ _-]?limit|usage limit|quota|too many requests|\b429\b|insufficient_quota|credit balance|limit reached|resets? (at|in)/i;

export const isQuotaError = (text: string | null | undefined) => !!text && QUOTA_ERROR.test(text);

const TIER_RANK: Record<FlowDataTerms, number> = { standard: 0, no_training: 1, zero_retention: 2 };

export const dataTermsRank = (spec: FlowSpec, provider: ProviderKind) =>
  TIER_RANK[spec.dataTerms?.[provider] ?? "standard"];

export type QuotaDecision =
  | { readonly type: "switch"; readonly provider: ProviderKind }
  | { readonly type: "ask"; readonly reason: string }
  | { readonly type: "wait"; readonly reason: string; readonly delayMs: number };

/** The next allowed provider with data terms at least as good as `current`'s, or null. */
export function nextAllowedProvider(
  spec: FlowSpec,
  current: ProviderKind,
  skip: ReadonlyArray<ProviderKind>,
): ProviderKind | null {
  const floor = dataTermsRank(spec, current);
  return (
    (spec.allowedProviders ?? []).find(
      (provider) =>
        provider !== current && !skip.includes(provider) && dataTermsRank(spec, provider) >= floor,
    ) ?? null
  );
}

export function decideQuota(input: {
  readonly spec: FlowSpec;
  readonly node: FlowNodeSpec;
  readonly current: ProviderKind;
  /** Providers this step already ran out of quota on. */
  readonly exhausted: ReadonlyArray<ProviderKind>;
}): QuotaDecision {
  const { spec, node, current } = input;
  // Autopilot may change provider on its own; every other mode asks first by default.
  const policy = node.onQuota ?? (node.mode === "autopilot" ? "switch" : "ask");
  if (policy === "ask") {
    return {
      type: "ask",
      reason: `${current} ran out of quota. Switch provider or wait for the reset.`,
    };
  }
  if (policy === "switch") {
    const next = nextAllowedProvider(spec, current, input.exhausted);
    if (next) return { type: "switch", provider: next };
  }
  return {
    type: "wait",
    reason: `${current} ran out of quota${policy === "switch" ? " and no allowed provider with the same data terms is left" : ""}; trying again in ${QUOTA_WAIT_MS / 60_000} min.`,
    delayMs: QUOTA_WAIT_MS,
  };
}
