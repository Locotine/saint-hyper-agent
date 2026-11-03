// FILE: parsers.ts
// Purpose: Turns the output of each scanner (JSON or SARIF) into the shared finding shape. The
//          readers are tolerant: a malformed entry is skipped, a secret's value is never kept.
// Layer: Server cyber security scanners (pure)
// Exports: parseGitleaks, parseOsv, parseHadolint, parseSarif, parseNuclei, finalizeFindings,
//          SCANNER_FINDING_CAP

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CyberSeverity } from "@saint/contracts";

import { severityRank, type ParsedFinding } from "../findings.ts";

/** A scanner can report thousands of dependency alerts; the board keeps the worst of them. */
export const SCANNER_FINDING_CAP = 100;

const cvssSeverity = (score: number): CyberSeverity =>
  score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";

function severityFromName(value: unknown): CyberSeverity | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
    case "error":
      return "high";
    case "medium":
    case "moderate":
    case "warning":
      return "medium";
    case "low":
    case "info":
    case "note":
    case "style":
    case "none":
      return "low";
    default:
      return null;
  }
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asText = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const asLine = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** `node:path` for one platform; the scanner runs on one, tests exercise the other. */
export type PathApi = typeof path.posix;

/**
 * A path relative to the scanned folder, so findings read the same on every host: `file:` URIs
 * are decoded the way the platform spells them (`file:///C:/proj/a` is `C:\proj\a` on Windows),
 * a path outside the folder is kept as the scanner wrote it, and Windows separators become `/`.
 */
export function relativePath(root: string, file: unknown, pathApi: PathApi = path): string | null {
  let text = asText(file, 500);
  if (!text) return null;
  const windows = pathApi.sep === "\\";
  if (/^file:/i.test(text)) {
    try {
      text = fileURLToPath(text, { windows });
    } catch {
      text = text.replace(/^file:\/\//i, "");
    }
  }
  const relative = pathApi.isAbsolute(text) ? pathApi.relative(root, text) : text;
  // Outside the folder (`..`), or on another drive (an absolute result): keep it as written.
  const outside = /^\.\.(?:[\\/]|$)/.test(relative) || pathApi.isAbsolute(relative);
  const shown = outside ? text : relative;
  return (windows ? shown.replaceAll("\\", "/") : shown) || null;
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/** Worst first, then capped; what was left out is reported by the caller. */
export function finalizeFindings(findings: ReadonlyArray<ParsedFinding>): {
  readonly kept: ParsedFinding[];
  readonly dropped: number;
} {
  const sorted = findings.toSorted((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    kept: sorted.slice(0, SCANNER_FINDING_CAP),
    dropped: Math.max(0, sorted.length - SCANNER_FINDING_CAP),
  };
}

/** gitleaks JSON report. The matched value is never read, so no secret reaches the database. */
export function parseGitleaks(output: string, root: string, pathApi?: PathApi): ParsedFinding[] {
  return asArray(parseJson(output)).flatMap((entry) => {
    const item = asObject(entry);
    if (!item) return [];
    const rule = asText(item.RuleID, 80) || "secret";
    return [
      {
        title: `Secret in source: ${rule}`.slice(0, 200),
        severity: "high" as const,
        category: "secrets",
        file: relativePath(root, item.File, pathApi),
        line: asLine(item.StartLine),
        detail:
          asText(item.Description, 500) ||
          "A credential-like value is committed to the repository.",
        fix: "Remove it from the code and the git history, rotate the credential, and load it from the environment or a secret store.",
      },
    ];
  });
}

/** osv-scanner JSON report: one finding per vulnerable package and advisory. */
export function parseOsv(output: string, root: string, pathApi?: PathApi): ParsedFinding[] {
  const seen = new Set<string>();
  const findings: ParsedFinding[] = [];
  for (const result of asArray(asObject(parseJson(output))?.results)) {
    const source = asObject(asObject(result)?.source);
    const file = relativePath(root, source?.path, pathApi);
    for (const entry of asArray(asObject(result)?.packages)) {
      const pkg = asObject(asObject(entry)?.package);
      const name = asText(pkg?.name, 120);
      const version = asText(pkg?.version, 60);
      const groups = asArray(asObject(entry)?.groups).map(asObject);
      for (const vulnerability of asArray(asObject(entry)?.vulnerabilities)) {
        const vuln = asObject(vulnerability);
        const id = asText(vuln?.id, 80);
        if (!vuln || !id || !name) continue;
        const key = `${id}|${name}|${version}|${file ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const group = groups.find((candidate) => asArray(candidate?.ids).includes(id));
        const score = Number.parseFloat(asText(group?.max_severity, 12));
        const severity =
          severityFromName(asObject(vuln.database_specific)?.severity) ??
          (Number.isFinite(score) ? cvssSeverity(score) : "medium");
        const fixed = asArray(vuln.affected)
          .flatMap((affected) => asArray(asObject(affected)?.ranges))
          .flatMap((range) => asArray(asObject(range)?.events))
          .map((event) => asText(asObject(event)?.fixed, 60))
          .find(Boolean);
        findings.push({
          title: `${id}: ${name}${version ? `@${version}` : ""}`.slice(0, 200),
          severity,
          category: "supply-chain",
          file,
          line: null,
          detail: asText(vuln.summary, 300) || asText(vuln.details, 500),
          fix: fixed ? `Upgrade ${name} to ${fixed} or later.` : `Upgrade or replace ${name}.`,
        });
      }
    }
  }
  return findings;
}

/** hadolint JSON report (Dockerfile rules). */
export function parseHadolint(output: string, root: string, pathApi?: PathApi): ParsedFinding[] {
  return asArray(parseJson(output)).flatMap((entry) => {
    const item = asObject(entry);
    const code = asText(item?.code, 20);
    if (!item || !code) return [];
    return [
      {
        title: `${code}: ${asText(item.message, 160)}`,
        severity: severityFromName(item.level) ?? "low",
        category: "container",
        file: relativePath(root, item.file, pathApi),
        line: asLine(item.line),
        detail: asText(item.message, 500),
        fix: `Follow the hadolint rule ${code}.`,
      },
    ];
  });
}

/** What a SARIF rule id says about the area, for scanners that mix several kinds of finding. */
function categoryFromRule(ruleId: string, file: string | null): string {
  if (/^(CVE|GHSA|OSV|PYSEC|RUSTSEC)-/i.test(ruleId)) return "supply-chain";
  const name = (file ?? "").toLowerCase();
  if (/dockerfile|\.dockerfile$/.test(name) || /^(AVD-)?DS-?\d/i.test(ruleId)) return "container";
  if (/\.tf$|\.tfvars$|cloudformation|terraform/.test(name) || /^AVD-(AWS|AZU|GCP)/i.test(ruleId)) {
    return "cloud";
  }
  if (/^AVD-KSV/i.test(ruleId)) return "container";
  return "misconfiguration";
}

/** SARIF 2.1 report (trivy, and semgrep or checkov when present). */
export function parseSarif(
  output: string,
  root: string,
  fixedCategory?: string,
  pathApi?: PathApi,
): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const run of asArray(asObject(parseJson(output))?.runs)) {
    const rules = new Map<string, Record<string, unknown>>();
    for (const rule of asArray(asObject(asObject(asObject(run)?.tool)?.driver)?.rules)) {
      const object = asObject(rule);
      const id = asText(object?.id, 120);
      if (object && id) rules.set(id, object);
    }
    for (const entry of asArray(asObject(run)?.results)) {
      const result = asObject(entry);
      if (!result) continue;
      const ruleId = asText(result.ruleId, 120);
      const rule = rules.get(ruleId);
      const properties = asObject(rule?.properties);
      const score = Number.parseFloat(asText(properties?.["security-severity"], 12));
      const severity =
        (Number.isFinite(score) ? cvssSeverity(score) : null) ??
        severityFromName(asObject(rule?.defaultConfiguration)?.level) ??
        severityFromName(result.level) ??
        "medium";
      const physical = asObject(asObject(asArray(result.locations)[0])?.physicalLocation);
      const file = relativePath(root, asObject(physical?.artifactLocation)?.uri, pathApi);
      const message = asText(asObject(result.message)?.text, 600);
      const title =
        asText(asObject(rule?.shortDescription)?.text, 160) ||
        (message.split("\n")[0] ?? "").slice(0, 160) ||
        ruleId;
      if (!title) continue;
      findings.push({
        title: ruleId && !title.startsWith(ruleId) ? `${ruleId}: ${title}`.slice(0, 200) : title,
        severity,
        category: fixedCategory ?? categoryFromRule(ruleId, file),
        file,
        line: asLine(asObject(physical?.region)?.startLine),
        detail: message,
        fix: asText(asObject(rule?.help)?.text, 500) || "See the rule's guidance.",
      });
    }
  }
  return findings;
}

/** What a nuclei template's tags say about the area of the finding. */
function categoryFromTags(tags: ReadonlyArray<string>): string {
  if (tags.includes("cve")) return "supply-chain";
  if (tags.includes("exposure") || tags.includes("tech") || tags.includes("panel")) {
    return "info-exposure";
  }
  if (tags.includes("misconfig") || tags.includes("config")) return "misconfiguration";
  return "web";
}

/**
 * nuclei JSONL report (one JSON object per line). Only the template's own words are kept: the
 * request, the response and extracted values are dropped, so a leaked secret or a page body
 * never reaches the database. The matched URL is reduced to its path.
 */
export function parseNuclei(output: string): ParsedFinding[] {
  const seen = new Set<string>();
  const findings: ParsedFinding[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const item = asObject(parseJson(line));
    const info = asObject(item?.info);
    const templateId = asText(item?.["template-id"], 120);
    const name = asText(info?.name, 160);
    if (!item || !templateId || !name) continue;
    let matchedPath: string | null = null;
    try {
      const url = new URL(asText(item["matched-at"], 500));
      matchedPath = `${url.pathname}${url.search ? "?…" : ""}`.slice(0, 200);
    } catch {
      matchedPath = null;
    }
    const key = `${templateId}|${matchedPath ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = asArray(info?.tags).flatMap((tag) =>
      typeof tag === "string" ? [tag.toLowerCase()] : [],
    );
    const matcher = asText(item["matcher-name"], 80);
    findings.push({
      title: `${templateId}: ${name}`.slice(0, 200),
      severity: severityFromName(info?.severity) ?? "low",
      category: categoryFromTags(tags),
      file: matchedPath,
      line: null,
      detail: [
        asText(info?.description, 400),
        `Seen on the running app${matchedPath ? ` at ${matchedPath}` : ""}${matcher ? ` (${matcher})` : ""}.`,
      ]
        .filter(Boolean)
        .join(" "),
      fix:
        asText(info?.remediation, 500) ||
        "Remove or restrict what the template found, then run the scan again.",
    });
  }
  return findings;
}
