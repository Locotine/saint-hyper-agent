// FILE: findings.ts
// Purpose: Turns the report step's handoff into findings and decides the gate verdict.
// Layer: Server cyber security (pure)
// Exports: parseFindingRefs, countUnresolved, verdictFor, severityRank, MAX_FINDINGS

import type {
  CyberAssessmentVerdict,
  CyberFindingStatus,
  CyberSeverity,
  CyberSeverityCounts,
} from "@saint/contracts";

export const MAX_FINDINGS = 32;

export interface ParsedFinding {
  readonly title: string;
  readonly severity: CyberSeverity;
  readonly category: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly detail: string;
  readonly fix: string;
}

const RANK: Record<CyberSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const severityRank = (severity: CyberSeverity) => RANK[severity];

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Handoff `refs` carry one compact JSON object per finding. Entries that are not valid findings
 * (a plain file pointer, malformed JSON) are skipped instead of failing the assessment.
 */
export function parseFindingRefs(
  refs: ReadonlyArray<string>,
  fallbackCategory = "general",
): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const ref of refs) {
    let value: unknown;
    try {
      value = JSON.parse(ref);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const title = text(record.title, 200);
    const severity = text(record.severity, 16).toLowerCase();
    if (!title || !(severity in RANK)) continue;
    const line =
      typeof record.line === "number" && Number.isInteger(record.line) ? record.line : null;
    findings.push({
      title,
      severity: severity as CyberSeverity,
      category: text(record.category, 64) || fallbackCategory,
      file: text(record.file, 500) || null,
      line: line !== null && line >= 0 ? line : null,
      detail: text(record.detail, 2_000),
      fix: text(record.fix, 2_000),
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

type Triaged = { readonly severity: CyberSeverity; readonly status: CyberFindingStatus };

/** Findings still waiting for a fix; resolved ones no longer count against the gate. */
export function countUnresolved(findings: ReadonlyArray<Triaged>): CyberSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    if (finding.status !== "resolved") counts[finding.severity] += 1;
  }
  return counts;
}

/** `fail` while any unresolved finding reaches the threshold. */
export function verdictFor(
  findings: ReadonlyArray<Triaged>,
  threshold: CyberSeverity,
): Extract<CyberAssessmentVerdict, "pass" | "fail"> {
  return findings.some(
    (finding) => finding.status !== "resolved" && RANK[finding.severity] >= RANK[threshold],
  )
    ? "fail"
    : "pass";
}
