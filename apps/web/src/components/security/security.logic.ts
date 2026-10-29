// FILE: security.logic.ts
// Purpose: Pure helpers for the Security screen: risk order of alerts and the autonomy ladder.
// Layer: Web security view
// Exports: sortAlertsByRisk, AUTONOMY_LEVELS, SEVERITY_TONE

import type { AegisAlert, AegisSeverity, AutonomyLevel } from "@saint/contracts";

const SEVERITY_RANK: Record<AegisSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const SEVERITY_TONE: Record<AegisSeverity, string> = {
  critical: "text-destructive",
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
};

/** Open alerts first, then the riskiest, then the newest. */
export function sortAlertsByRisk(alerts: ReadonlyArray<AegisAlert>): AegisAlert[] {
  return alerts.toSorted(
    (a, b) =>
      Number(b.state === "open") - Number(a.state === "open") ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

export const AUTONOMY_LEVELS: ReadonlyArray<{
  level: AutonomyLevel;
  label: string;
  detail: string;
}> = [
  { level: "L0", label: "Suggest", detail: "Every action waits for approval." },
  { level: "L1", label: "Worktree", detail: "Agents edit and run freely inside the project." },
  {
    level: "L2",
    label: "Allowlist",
    detail: "Full access inside the sandbox; network only to allowed hosts.",
  },
  {
    level: "L3",
    label: "Unattended",
    detail: "Runs without a person; needs sandbox, egress, tripwires and a sign-off.",
  },
  { level: "L4", label: "Self-planning", detail: "Agents plan their own flows." },
];
