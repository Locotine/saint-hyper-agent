// FILE: CyberSecurity.ts
// Purpose: Pre-production security assessment of one project: install the methodology skills,
//          detect what the repo contains, audit only the matching areas through a Flow, and keep
//          the findings the dashboard triages.
// Layer: Server service contract

import type {
  CyberAssessment,
  CyberDynamicScanRequest,
  CyberFinding,
  CyberFindingStatus,
  CyberSecurityStatus,
  CyberSeverity,
  ModelSelection,
  ProjectId,
} from "@saint/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export class CyberSecurityError extends Data.TaggedError("CyberSecurityError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CyberSecurityStartInput {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly threshold?: CyberSeverity | undefined;
  /** Set only when the person confirmed an attack on the running app for this run. */
  readonly dynamicScan?: CyberDynamicScanRequest | undefined;
  readonly startedBy: string;
}

export interface CyberSecurityShape {
  /** Skills, the newest assessment and its findings; settles a finished flow into findings first. */
  readonly status: (projectId: ProjectId) => Effect.Effect<CyberSecurityStatus, CyberSecurityError>;
  /** Detects the repo, then starts the audit flow for the matching areas only. */
  readonly start: (
    input: CyberSecurityStartInput,
  ) => Effect.Effect<CyberAssessment, CyberSecurityError>;
  /** Moves a finding between board columns and re-evaluates the gate verdict. */
  readonly setFindingStatus: (input: {
    readonly projectId: ProjectId;
    readonly findingId: string;
    readonly status: CyberFindingStatus;
    readonly fixThreadId?: string | undefined;
  }) => Effect.Effect<CyberFinding, CyberSecurityError>;
}

export class CyberSecurity extends ServiceMap.Service<CyberSecurity, CyberSecurityShape>()(
  "saint/cyberSecurity/Services/CyberSecurity",
) {}
