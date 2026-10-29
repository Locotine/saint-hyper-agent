// FILE: rules.ts
// Purpose: Aegis hard rules (no model involved): autonomy-ladder locks, the default egress
//          allowlist and tripwire scanning. Policy decisions are Cedar (`policy.ts`).
// Layer: Server Aegis domain (pure)

import type { AutonomyLevel, RuntimeMode } from "@saint/contracts";

export const AUTONOMY_ORDER: ReadonlyArray<AutonomyLevel> = ["L0", "L1", "L2", "L3", "L4"];
export const autonomyAtLeast = (level: AutonomyLevel, floor: AutonomyLevel) =>
  AUTONOMY_ORDER.indexOf(level) >= AUTONOMY_ORDER.indexOf(floor);

/** The approval mode a flow step may run with at this level, at most what was asked for. */
export function runtimeModeCap(level: AutonomyLevel, requested: RuntimeMode): RuntimeMode {
  const cap: RuntimeMode =
    level === "L0" ? "approval-required" : level === "L1" ? "auto" : "full-access";
  const order: ReadonlyArray<RuntimeMode> = ["approval-required", "auto", "full-access"];
  return order[Math.min(order.indexOf(cap), order.indexOf(requested))]!;
}

export interface AutonomyEnvironment {
  readonly sandboxAvailable: boolean;
  readonly tripwires: number;
  readonly signedOff: boolean;
}

/** Why each level that cannot be chosen now is locked. */
export function autonomyLocks(env: AutonomyEnvironment): Partial<Record<AutonomyLevel, string>> {
  const locks: Partial<Record<AutonomyLevel, string>> = {
    L4: "Self-planning needs the AP-03 review loop, which Saint does not ship yet.",
  };
  if (!env.sandboxAvailable) {
    locks.L2 = "No OS sandbox on this host (needs bwrap on Linux or sandbox-exec on macOS).";
    locks.L3 = locks.L2;
  } else if (env.tripwires < 3) {
    locks.L3 = `Unattended needs at least 3 tripwires; ${env.tripwires} armed.`;
  } else if (!env.signedOff) {
    locks.L3 = "Unattended needs a person's sign-off first.";
  }
  return locks;
}

/** Hosts every provider needs to reach its own API, so turning egress on does not cut them off. */
export const DEFAULT_EGRESS_ALLOWLIST: ReadonlyArray<string> = [
  "*.anthropic.com",
  "anthropic.com",
  "*.claude.ai",
  "claude.ai",
  "*.openai.com",
  "openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  "*.googleapis.com",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "localhost",
  "127.0.0.1",
];

/** Paths no agent has a reason to read. */
export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[\s"'=/~])\.aws\/credentials\b/,
  /(^|[\s"'=/~])\.ssh\/id_[a-z0-9_]+/i,
  /(^|[\s"'=/~])\.config\/gcloud\/(application_default_credentials|credentials\.db)/,
  /(^|[\s"'=/~])\.saint(-beta)?\/(userdata\/)?secrets?\b/,
  /Library\/Keychains\//,
];

export interface TripwireHit {
  readonly kind: "canary" | "sensitive_path";
  readonly match: string;
}

/** Looks for a planted canary value or a sensitive credential path in tool-call text. */
export function scanForTripwire(text: string, canaries: ReadonlyArray<string>): TripwireHit | null {
  const canary = canaries.find((value) => value.length >= 16 && text.includes(value));
  if (canary) return { kind: "canary", match: `${canary.slice(0, 6)}…` };
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    const found = pattern.exec(text);
    if (found) return { kind: "sensitive_path", match: found[0].trim() };
  }
  return null;
}
