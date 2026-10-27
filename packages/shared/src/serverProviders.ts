// FILE: serverProviders.ts
// Purpose: Limits which providers a Saint server runs. Remote SSH servers run only
//          the providers whose CLIs they use from the host, so their installs can
//          leave out every other provider's SDK.
// Layer: Shared runtime utility (desktop main, server, web)
// Exports: SAINT_PROVIDERS_ENV, REMOTE_SERVER_PROVIDERS, parseServerProviderAllowlist

/** Comma-separated ProviderKinds the server may run; unset or blank runs every provider. */
export const SAINT_PROVIDERS_ENV = "SAINT_PROVIDERS";

/**
 * Providers of a remote SSH server: Codex (`codex app-server`) and Claude (the
 * host's `claude` CLI through the Agent SDK). Both use binaries on the host's PATH.
 */
export const REMOTE_SERVER_PROVIDERS = ["codex", "claudeAgent"] as const;

/** The allowlist from `SAINT_PROVIDERS`, or null when every provider may run. */
export function parseServerProviderAllowlist(
  value: string | undefined,
): ReadonlySet<string> | null {
  const providers = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return providers.length > 0 ? new Set(providers) : null;
}
