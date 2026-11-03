// FILE: cyberSecurity.ts
// Purpose: Cyber Security contracts — the pre-production, report-only security assessment of one
//          project: what the repo contains, the findings it produced, and their triage status.
// Layer: Shared contracts (server, web)

import { Schema } from "effect";

import { AegisSeverity } from "./aegis";
import {
  FlowRunId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas";
import { ModelSelection } from "./orchestration";

export const CyberSeverity = AegisSeverity;
export type CyberSeverity = typeof CyberSeverity.Type;

/** open → triaging → fixing → resolved: the columns of the dashboard board. */
export const CyberFindingStatus = Schema.Literals(["open", "triaging", "fixing", "resolved"]);
export type CyberFindingStatus = typeof CyberFindingStatus.Type;

/** `fail` while any unresolved finding reaches the threshold; `pass` once none does. */
export const CyberAssessmentVerdict = Schema.Literals(["running", "pass", "fail", "error"]);
export type CyberAssessmentVerdict = typeof CyberAssessmentVerdict.Type;

/** What the detect phase found in the repo; the audit runs only for the surfaces listed. */
export const CyberRepoInventory = Schema.Struct({
  languages: Schema.Array(TrimmedNonEmptyString),
  frameworks: Schema.Array(TrimmedNonEmptyString),
  /** web, api, auth, crypto, container, k8s, cloud, cicd, supply-chain, ai. */
  surfaces: Schema.Array(TrimmedNonEmptyString),
  manifests: Schema.Array(TrimmedNonEmptyString),
});
export type CyberRepoInventory = typeof CyberRepoInventory.Type;

export const CyberSeverityCounts = Schema.Struct({
  critical: NonNegativeInt,
  high: NonNegativeInt,
  medium: NonNegativeInt,
  low: NonNegativeInt,
});
export type CyberSeverityCounts = typeof CyberSeverityCounts.Type;

export const CyberAssessment = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  flowId: Schema.NullOr(FlowRunId),
  verdict: CyberAssessmentVerdict,
  /** Findings at or above this severity block the gate until resolved. */
  threshold: CyberSeverity,
  inventory: CyberRepoInventory,
  /** The skill categories the audit ran: only those that match the inventory. */
  categories: Schema.Array(TrimmedNonEmptyString),
  /** The steps a partial run was limited to (`audit:<area>`, `scanner:<id>`); null for a full run. */
  steps: Schema.NullOr(Schema.Array(TrimmedNonEmptyString)),
  counts: CyberSeverityCounts,
  error: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type CyberAssessment = typeof CyberAssessment.Type;

export const CyberFinding = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  assessmentId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  severity: CyberSeverity,
  category: TrimmedNonEmptyString,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(NonNegativeInt),
  detail: Schema.String,
  fix: Schema.String,
  status: CyberFindingStatus,
  /** `review` (the model's read of the code) or `scanner:<id>` (a scanner's evidence). */
  source: TrimmedNonEmptyString,
  /** The chat started by Fix; the board moves the finding to review when its turn finishes. */
  fixThreadId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CyberFinding = typeof CyberFinding.Type;

export const CyberScannerStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "unavailable",
]);
export type CyberScannerStatus = typeof CyberScannerStatus.Type;

/** One scanner's run within the newest assessment. */
export const CyberScannerRun = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  status: CyberScannerStatus,
  /** Why it did not run, or what it covered. */
  summary: Schema.String,
  findings: NonNegativeInt,
  /**
   * Something the person must do before this scanner can run or be confined (install a package,
   * allow network access, an admin right). The app shows it in a dialog.
   */
  attention: Schema.NullOr(Schema.String),
});
export type CyberScannerRun = typeof CyberScannerRun.Type;

export const CyberSecurityStatusInput = Schema.Struct({ projectId: ProjectId });
export const CyberSecurityStatus = Schema.Struct({
  /** The newest assessment of the project, null before the first run. */
  assessment: Schema.NullOr(CyberAssessment),
  findings: Schema.Array(CyberFinding),
  scanners: Schema.Array(CyberScannerRun),
});
export type CyberSecurityStatus = typeof CyberSecurityStatus.Type;

/**
 * The person's confirmation to attack their own running app for this one run: which package
 * script starts it. The server re-resolves the script from the project, so no command comes from
 * the client, and the target is always a localhost address the started server opens.
 */
export const CyberDynamicScanRequest = Schema.Struct({
  /** The package folder relative to the project root; empty for the root. */
  packagePath: Schema.String,
  script: TrimmedNonEmptyString,
});
export type CyberDynamicScanRequest = typeof CyberDynamicScanRequest.Type;

export const CyberSecurityStartInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  threshold: Schema.optional(CyberSeverity),
  /** Absent unless the person confirmed a dynamic scan of this run. */
  dynamicScan: Schema.optional(CyberDynamicScanRequest),
  /**
   * Run only these steps: `audit:<area>` and `scanner:<id>`. Absent runs every step the repo has.
   */
  steps: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

export const CyberSecuritySetFindingStatusInput = Schema.Struct({
  projectId: ProjectId,
  findingId: TrimmedNonEmptyString,
  status: CyberFindingStatus,
  fixThreadId: Schema.optional(TrimmedNonEmptyString),
});
