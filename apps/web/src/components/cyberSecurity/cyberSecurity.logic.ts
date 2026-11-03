// FILE: cyberSecurity.logic.ts
// Purpose: Pure helpers for the Cyber Security screen: board columns and ordering, which
//          findings "Fix all" takes, and the prompt a Fix chat starts with.
// Layer: Web cyber security view
// Exports: FINDING_COLUMNS, groupFindings, fixAllTargets, buildFixPrompt, sourceLabel,
//          pickDynamicScript

import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import type {
  CyberDynamicScanRequest,
  CyberFinding,
  CyberFindingStatus,
  CyberSeverity,
  ProjectDiscoveredScriptTarget,
} from "@saint/contracts";

export const FINDING_COLUMNS: ReadonlyArray<{
  readonly status: CyberFindingStatus;
  readonly label: string;
}> = [
  { status: "open", label: "Open" },
  { status: "triaging", label: "Triaging" },
  { status: "fixing", label: "Fixing" },
  { status: "resolved", label: "Resolved" },
];

export const SEVERITY_ORDER: ReadonlyArray<CyberSeverity> = ["critical", "high", "medium", "low"];
const RANK: Record<CyberSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Findings per board column, most severe first; `filter` narrows to one severity. */
export function groupFindings(
  findings: ReadonlyArray<CyberFinding>,
  filter: CyberSeverity | "all" = "all",
): Record<CyberFindingStatus, CyberFinding[]> {
  const columns: Record<CyberFindingStatus, CyberFinding[]> = {
    open: [],
    triaging: [],
    fixing: [],
    resolved: [],
  };
  for (const finding of findings) {
    if (filter === "all" || finding.severity === filter) columns[finding.status].push(finding);
  }
  for (const status of Object.keys(columns) as CyberFindingStatus[]) {
    columns[status] = columns[status].toSorted(
      (a, b) => RANK[a.severity] - RANK[b.severity] || a.createdAt.localeCompare(b.createdAt),
    );
  }
  return columns;
}

/** "Fix all" takes what nobody is on yet and that blocks the gate. */
export function fixAllTargets(
  findings: ReadonlyArray<CyberFinding>,
  threshold: CyberSeverity,
): CyberFinding[] {
  return findings
    .filter(
      (finding) =>
        (finding.status === "open" || finding.status === "triaging") &&
        RANK[finding.severity] <= RANK[threshold],
    )
    .toSorted((a, b) => RANK[a.severity] - RANK[b.severity]);
}

const location = (finding: CyberFinding) =>
  finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : "unknown";

function describe(finding: CyberFinding): string {
  return [
    `[${finding.severity.toUpperCase()}] ${finding.title}`,
    `Where: ${location(finding)} (${finding.category})`,
    ...(finding.detail ? [`Problem: ${finding.detail}`] : []),
    ...(finding.fix ? [`Suggested fix: ${finding.fix}`] : []),
  ].join("\n");
}

/** The first message of a Fix chat: what to fix, how small, and what not to do on its own. */
export function buildFixPrompt(findings: ReadonlyArray<CyberFinding>): string {
  const many = findings.length > 1;
  return [
    many
      ? `Fix these ${findings.length} security findings in this repository, one at a time, most severe first.`
      : "Fix this security finding in this repository.",
    "",
    findings.map(describe).join("\n\n"),
    "",
    "For each: fix the root cause with the smallest change, add or update a test that fails without the fix, and run the project's checks. Do not commit or push.",
  ].join("\n");
}

/** The short label of where a finding came from: "review" or the scanner's name. */
export function sourceLabel(source: string): string {
  return source.startsWith("scanner:") ? source.slice("scanner:".length) : source;
}

export type DynamicScriptChoice =
  | { readonly ok: true; readonly request: CyberDynamicScanRequest; readonly command: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The one script that starts the app for a dynamic scan: `dev`, else `start`, and only when a
 * single package has it. With none or several, nothing is guessed and the option stays off.
 */
export function pickDynamicScript(
  targets: ReadonlyArray<ProjectDiscoveredScriptTarget>,
): DynamicScriptChoice {
  for (const name of ["dev", "start"] as const) {
    const matches = targets.filter((target) =>
      target.scripts.some((script) => script.name === name),
    );
    if (matches.length > 1) {
      return { ok: false, reason: `Several packages have a "${name}" script; none is guessed.` };
    }
    const target = matches[0];
    const script = target?.scripts.find((entry) => entry.name === name);
    if (target && script) {
      return {
        ok: true,
        request: { packagePath: target.relativePath, script: name },
        command: script.command,
      };
    }
  }
  return { ok: false, reason: 'No "dev" or "start" script was found in this project.' };
}

/** What the scanners say only the person can fix, once per distinct message. */
export function attentionItems(
  scanners: ReadonlyArray<{ readonly label: string; readonly attention: string | null }>,
): Array<{ readonly label: string; readonly text: string }> {
  const seen = new Set<string>();
  const items: Array<{ readonly label: string; readonly text: string }> = [];
  for (const scanner of scanners) {
    const text = scanner.attention?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push({ label: scanner.label, text });
  }
  return items;
}

/** Cyber Security runs on this computer's projects only for now; a remote host is added later. */
export const cyberSecurityHostSupported = (hostId: HostId): boolean => hostId === LOCAL_HOST_ID;
