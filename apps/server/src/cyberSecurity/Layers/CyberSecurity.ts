import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type {
  CyberAssessment,
  CyberDynamicScanRequest,
  CyberAssessmentVerdict,
  CyberFinding,
  CyberRepoInventory,
  CyberScannerRun,
  CyberSecurityStatus,
  CyberSeverity,
  FlowRunId,
  ProjectId,
} from "@saint/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { detectSandbox } from "../../aegis/sandbox.ts";
import { Aegis } from "../../aegis/Services/Aegis.ts";
import { ServerConfig } from "../../config.ts";
import { DevServerManager } from "../../devServerManager.ts";
import { FlowService } from "../../flow/Services/FlowService.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { discoverProjectScripts } from "../../workspaceEntries.ts";
import {
  buildAssessmentFlow,
  matchCategories,
  narrowSteps,
  REPORT_NODE_ID,
} from "../assessmentFlow.ts";
import { countUnresolved, parseFindingRefs, verdictFor, type ParsedFinding } from "../findings.ts";
import { detectRepoInventory } from "../repoInventory.ts";
import {
  findDevServerListener,
  resolveNucleiTemplates,
  waitForHttp,
} from "../scanners/dynamicRun.ts";
import {
  decideDynamic,
  pickDevScript,
  pickLocalTarget,
  type DynamicDecision,
} from "../scanners/dynamicTarget.ts";
import { decideOnline, type OnlineDecision } from "../scanners/egress.ts";
import { installAttention, installNucleiTemplates } from "../scanners/install.ts";
import { applicableScanners, SCANNERS } from "../scanners/registry.ts";
import { ensureScannerBinary, runScanner, type ScannerOutcome } from "../scanners/runScanner.ts";
import {
  CyberSecurity,
  CyberSecurityError,
  type CyberSecurityShape,
} from "../Services/CyberSecurity.ts";

const DEFAULT_THRESHOLD: CyberSeverity = "high";

const toError = (message: string) => (cause: unknown) =>
  new CyberSecurityError({
    message: cause instanceof Error && cause.message ? `${message} ${cause.message}` : message,
    cause,
  });

interface AssessmentRow {
  readonly assessmentId: string;
  readonly projectId: string;
  readonly flowId: string | null;
  readonly verdict: string;
  readonly threshold: string;
  readonly inventoryJson: string;
  readonly categoriesJson: string;
  /** The steps a partial run was limited to, as JSON; null for a full run. */
  readonly stepsJson: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly ingested: number;
}

interface ScannerRunRow {
  readonly scannerId: string;
  readonly status: string;
  readonly summary: string;
  readonly findingCount: number;
  readonly attention: string | null;
}

interface FindingRow {
  readonly findingId: string;
  readonly projectId: string;
  readonly assessmentId: string;
  readonly title: string;
  readonly severity: string;
  readonly category: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly detail: string;
  readonly fix: string;
  readonly status: string;
  readonly source: string;
  readonly fixThreadId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const toFinding = (row: FindingRow): CyberFinding => ({
  id: row.findingId,
  projectId: row.projectId as ProjectId,
  assessmentId: row.assessmentId,
  title: row.title,
  severity: row.severity as CyberFinding["severity"],
  category: row.category,
  file: row.file,
  line: row.line,
  detail: row.detail,
  fix: row.fix,
  status: row.status as CyberFinding["status"],
  source: row.source,
  fixThreadId: row.fixThreadId,
  createdAt: row.createdAt as CyberFinding["createdAt"],
  updatedAt: row.updatedAt as CyberFinding["updatedAt"],
});

const unavailable = (summary: string): ScannerOutcome => ({
  status: "unavailable",
  summary,
  findings: [],
});
const failed = (cause: unknown): ScannerOutcome => ({
  status: "failed",
  summary: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200),
  findings: [],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const flow = yield* FlowService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;
  // Scanners keep their caches (vulnerability databases) here between runs, one private
  // subfolder each; it is the only folder outside a run's scratch that a sandboxed scanner writes.
  const scannerHome = path.join(config.stateDir, "cyber-security", "home");
  // Scanners are fetched here the first time they are needed (pinned official releases), so
  // nothing ships in the app and a remote host keeps only what it runs.
  const toolsDir = path.join(config.stateDir, "cyber-security", "tools");
  const aegis = Option.getOrUndefined(yield* Effect.serviceOption(Aegis));
  const devServers = Option.getOrUndefined(yield* Effect.serviceOption(DevServerManager));
  // Assessments whose scanners this server is running right now; a "running" scanner row of any
  // other assessment was cut off by a restart.
  const activeScans = new Set<string>();

  const selectAssessments = (projectId: string) =>
    sql<AssessmentRow>`
      SELECT assessment_id AS "assessmentId", project_id AS "projectId", flow_id AS "flowId",
        verdict, threshold, inventory_json AS "inventoryJson", categories_json AS "categoriesJson",
        steps_json AS "stepsJson", error, started_at AS "startedAt", finished_at AS "finishedAt", ingested
      FROM cyber_security_assessments WHERE project_id = ${projectId}
      ORDER BY started_at DESC LIMIT 1
    `.pipe(Effect.mapError(toError("Could not read the assessments.")));

  const selectAssessment = (assessmentId: string) =>
    sql<AssessmentRow>`
      SELECT assessment_id AS "assessmentId", project_id AS "projectId", flow_id AS "flowId",
        verdict, threshold, inventory_json AS "inventoryJson", categories_json AS "categoriesJson",
        steps_json AS "stepsJson", error, started_at AS "startedAt", finished_at AS "finishedAt", ingested
      FROM cyber_security_assessments WHERE assessment_id = ${assessmentId}
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(toError("Could not read the assessment.")),
    );

  const selectFindings = (assessmentId: string) =>
    sql<FindingRow>`
      SELECT finding_id AS "findingId", project_id AS "projectId", assessment_id AS "assessmentId",
        title, severity, category, file, line, detail, fix, status, source, fix_thread_id AS "fixThreadId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM cyber_security_findings WHERE assessment_id = ${assessmentId}
      ORDER BY created_at ASC, finding_id ASC
    `.pipe(Effect.mapError(toError("Could not read the findings.")));

  const toAssessment = (
    row: AssessmentRow,
    findings: ReadonlyArray<CyberFinding>,
    note: string | null = null,
  ): CyberAssessment => ({
    id: row.assessmentId,
    projectId: row.projectId as ProjectId,
    flowId: row.flowId as FlowRunId | null,
    verdict: row.verdict as CyberAssessmentVerdict,
    threshold: row.threshold as CyberSeverity,
    inventory: JSON.parse(row.inventoryJson) as CyberRepoInventory,
    categories: JSON.parse(row.categoriesJson) as string[],
    steps: row.stepsJson ? (JSON.parse(row.stepsJson) as string[]) : null,
    counts: countUnresolved(findings),
    error: row.error ?? note,
    startedAt: row.startedAt as CyberAssessment["startedAt"],
    finishedAt: row.finishedAt as CyberAssessment["finishedAt"],
  });

  const finish = (assessmentId: string, verdict: CyberAssessmentVerdict, error: string | null) =>
    sql`
      UPDATE cyber_security_assessments
      SET verdict = ${verdict}, error = ${error}, finished_at = ${new Date().toISOString()},
        ingested = 1
      WHERE assessment_id = ${assessmentId} AND ingested = 0
    `.pipe(Effect.asVoid, Effect.mapError(toError("Could not save the assessment.")));

  /** Finding ids are deterministic, so two windows settling the same flow write the same rows. */
  const insertFindings = (
    row: AssessmentRow,
    findings: ReadonlyArray<ParsedFinding>,
    origin: { readonly idPrefix: string; readonly source: string } = {
      idPrefix: "",
      source: "review",
    },
  ) =>
    Effect.forEach(findings, (finding, index) => {
      const now = new Date().toISOString();
      return sql`
        INSERT INTO cyber_security_findings (finding_id, project_id, assessment_id, title, severity,
          category, file, line, detail, fix, status, source, created_at, updated_at)
        VALUES (${`${row.assessmentId}:${origin.idPrefix}${index + 1}`}, ${row.projectId},
          ${row.assessmentId}, ${finding.title}, ${finding.severity}, ${finding.category},
          ${finding.file}, ${finding.line}, ${finding.detail}, ${finding.fix}, 'open',
          ${origin.source}, ${now}, ${now})
        ON CONFLICT (finding_id) DO NOTHING
      `;
    }).pipe(Effect.asVoid, Effect.mapError(toError("Could not save the findings.")));

  const selectScannerRuns = (assessmentId: string) =>
    sql<ScannerRunRow>`
      SELECT scanner_id AS "scannerId", status, summary, finding_count AS "findingCount", attention
      FROM cyber_security_scanner_runs WHERE assessment_id = ${assessmentId}
      ORDER BY scanner_id ASC
    `.pipe(Effect.mapError(toError("Could not read the scanners.")));

  const saveScannerRun = (
    assessmentId: string,
    scannerId: string,
    state: {
      status: string;
      summary?: string;
      findings?: number;
      finished?: boolean;
      attention?: string | null;
    },
  ) =>
    sql`
      INSERT INTO cyber_security_scanner_runs (assessment_id, scanner_id, status, summary,
        finding_count, started_at, finished_at, attention)
      VALUES (${assessmentId}, ${scannerId}, ${state.status}, ${state.summary ?? ""},
        ${state.findings ?? 0}, ${new Date().toISOString()},
        ${state.finished ? new Date().toISOString() : null}, ${state.attention ?? null})
      ON CONFLICT (assessment_id, scanner_id) DO UPDATE SET status = excluded.status,
        summary = excluded.summary, finding_count = excluded.finding_count,
        finished_at = excluded.finished_at, attention = excluded.attention
    `.pipe(Effect.asVoid, Effect.mapError(toError("Could not save the scanner run.")));

  /** Scanner rows left unfinished by a restart can never finish: mark them so the verdict can. */
  const sweepInterrupted = (assessmentId: string) =>
    activeScans.has(assessmentId)
      ? Effect.void
      : sql`
          UPDATE cyber_security_scanner_runs
          SET status = 'failed', summary = 'Interrupted by a server restart.',
            finished_at = ${new Date().toISOString()}
          WHERE assessment_id = ${assessmentId} AND status IN ('pending', 'running')
        `.pipe(Effect.asVoid, Effect.mapError(toError("Could not update the scanners.")));

  /**
   * Attacks the person's own running app with the dynamic scanner. The dev server is started from
   * the project's own script only when none is running, the scanner is given a single localhost
   * port, and a server started here is always stopped again, on success, failure or interruption.
   */
  const runDynamic = (
    row: AssessmentRow,
    root: string,
    inventory: CyberRepoInventory,
    scratchRoot: string,
    request: CyberDynamicScanRequest,
  ): Effect.Effect<ScannerOutcome> => {
    const scanner = SCANNERS.find((entry) => entry.dynamic)!;
    return Effect.gen(function* () {
      if (!devServers) return unavailable("Dev servers are not available on this host.");
      // The person confirmed this run and the autonomy gate passed, so fetching the pinned nuclei
      // release and templates (once, cached on this machine) is part of it.
      const templatesDir = yield* Effect.promise(() =>
        resolveNucleiTemplates(process.env, toolsDir),
      );
      const templates = templatesDir
        ? templatesDir
        : yield* Effect.promise(async () => {
            const installed = await installNucleiTemplates({ cacheDir: toolsDir });
            return installed.ok ? installed.path : installed;
          });
      if (typeof templates !== "string") {
        return {
          ...unavailable(`nuclei templates could not be installed: ${templates.message}`),
          ...(templates.kind === "download" || templates.kind === "write"
            ? { attention: installAttention("nuclei templates", templates, toolsDir) }
            : {}),
        };
      }
      // The scanner is in place before any dev server starts, so a missing or blocked download
      // never leaves the person's app running for nothing.
      const ensured = yield* Effect.promise(() =>
        ensureScannerBinary(scanner, { toolsDir, download: true }),
      );
      if ("outcome" in ensured) return ensured.outcome;
      const discovered = yield* Effect.tryPromise(() => discoverProjectScripts({ cwd: root }));
      const script = pickDevScript(discovered.targets, request);
      if (!script.ok) return unavailable(script.reason);

      const projectId = row.projectId as ProjectId;
      const alreadyRunning = (yield* devServers.list).servers.some(
        (server) => server.projectId === projectId,
      );
      return yield* Effect.acquireUseRelease(
        // A server the person already runs is scanned as it is and left running.
        alreadyRunning
          ? Effect.succeed(false)
          : devServers
              .run({
                projectId,
                command: script.command,
                cwd: script.cwd,
                env: { SAINT_PROJECT_ROOT: root },
              })
              .pipe(Effect.as(true)),
        () =>
          Effect.gen(function* () {
            const deadline = Date.now() + 90_000;
            let found: ReturnType<typeof pickLocalTarget> | null = null;
            while (Date.now() < deadline) {
              const tracked = (yield* devServers.list).servers;
              const mine = tracked.find((server) => server.projectId === projectId);
              if (!mine) return failed(new Error("The dev server exited before it listened."));
              const server = yield* Effect.tryPromise(() =>
                findDevServerListener({ devServer: mine, tracked }),
              );
              if (server) {
                found = pickLocalTarget(server);
                break;
              }
              yield* Effect.sleep("1 second");
            }
            if (!found) return failed(new Error("The dev server did not start listening in time."));
            if (!found.ok) return unavailable(found.reason);
            const { target } = found;
            const host = target.bridgeHost === "::1" ? "[::1]" : target.bridgeHost;
            const ready = yield* Effect.promise(() =>
              waitForHttp(`http://${host}:${target.port}/`, { timeoutMs: 30_000 }),
            );
            if (!ready) return failed(new Error("The app did not answer HTTP in time."));
            const outcome = yield* Effect.tryPromise(() =>
              runScanner(scanner, {
                root,
                inventory,
                scratchRoot,
                scannerHome,
                toolsDir,
                download: true,
                online: false,
                dynamic: { target, templates },
              }),
            );
            return {
              ...outcome,
              summary: [`Scanned ${target.url} (${script.label})`, outcome.summary].join("; "),
            };
          }),
        (started) => (started ? devServers.stop({ projectId }).pipe(Effect.ignore) : Effect.void),
      );
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(cause))));
  };

  /** Runs the scanners in the background and records each one's findings as it finishes. */
  const runScanners = (
    row: AssessmentRow,
    root: string,
    inventory: CyberRepoInventory,
    online: OnlineDecision,
    dynamic: {
      readonly decision: DynamicDecision;
      readonly request: CyberDynamicScanRequest | null;
    },
  ) => {
    const scratchRoot = path.join(config.stateDir, "cyber-security", row.assessmentId);
    return Effect.forEach(
      applicableScanners(inventory),
      (scanner) =>
        Effect.gen(function* () {
          yield* saveScannerRun(row.assessmentId, scanner.id, { status: "running" });
          const outcome: ScannerOutcome = scanner.dynamic
            ? !dynamic.decision.allowed || !dynamic.request
              ? unavailable(
                  dynamic.decision.allowed
                    ? "Not requested for this run."
                    : dynamic.decision.reason,
                )
              : yield* runDynamic(row, root, inventory, scratchRoot, dynamic.request)
            : yield* Effect.tryPromise({
                try: () =>
                  runScanner(scanner, {
                    root,
                    inventory,
                    scratchRoot,
                    scannerHome,
                    toolsDir,
                    download: online.online,
                    online: online.online,
                    ...(online.online ? {} : { offlineReason: online.reason }),
                  }),
                catch: (cause) => cause,
              }).pipe(Effect.catch((cause) => Effect.succeed(failed(cause))));
          yield* insertFindings(row, outcome.findings, {
            idPrefix: `${scanner.id}:`,
            source: `scanner:${scanner.id}`,
          });
          yield* saveScannerRun(row.assessmentId, scanner.id, {
            status: outcome.status,
            summary: outcome.summary,
            findings: outcome.findings.length,
            finished: true,
            attention: outcome.attention ?? null,
          });
        }),
      { concurrency: 2, discard: true },
    ).pipe(
      Effect.ensuring(
        Effect.promise(() =>
          rm(scratchRoot, { recursive: true, force: true }).catch(() => {}),
        ).pipe(Effect.andThen(Effect.sync(() => activeScans.delete(row.assessmentId)))),
      ),
      Effect.catchCause(() => Effect.void),
    );
  };

  /**
   * Turns the finished audit flow and the finished scanners into findings and one verdict. It
   * waits until both are done; a slow scanner is never reported as a clean repo.
   */
  const settle = (row: AssessmentRow) =>
    Effect.gen(function* () {
      if (row.verdict !== "running") return;
      yield* sweepInterrupted(row.assessmentId);
      const runs = yield* selectScannerRuns(row.assessmentId);
      if (runs.some((run) => run.status === "pending" || run.status === "running")) return;

      const incomplete: string[] = [];
      let review: ParsedFinding[] = [];
      if (row.flowId) {
        const view = yield* flow
          .get(row.flowId as FlowRunId)
          .pipe(Effect.mapError(toError("Could not read the audit flow.")));
        const areaOf = (nodeId: string) => nodeId.replace(/^audit-/, "");
        if (!view) {
          incomplete.push("The audit flow no longer exists.");
        } else if (view.run.status === "running" || view.run.status === "paused") {
          return;
        } else {
          const audits = view.nodes.filter((node) => node.nodeId !== REPORT_NODE_ID);
          if (view.run.status === "completed") {
            const report = view.nodes.find((node) => node.nodeId === REPORT_NODE_ID);
            review = report?.handoff
              ? parseFindingRefs(report.handoff.refs)
              : audits.flatMap((node) =>
                  parseFindingRefs(node.handoff?.refs ?? [], areaOf(node.nodeId)),
                );
          } else {
            // One refused or failed area must not discard the rest: keep what the settled areas
            // found, never call the repo clean, and name what was not audited and why.
            review = audits.flatMap((node) =>
              parseFindingRefs(node.handoff?.refs ?? [], areaOf(node.nodeId)),
            );
            const skipped = audits
              .filter((node) => node.status !== "settled")
              .map((node) => areaOf(node.nodeId));
            const why =
              view.nodes.find((node) => node.statusReason)?.statusReason ?? view.run.statusReason;
            incomplete.push(
              [
                skipped.length > 0 ? `Not audited: ${skipped.join(", ")}.` : null,
                why ?? `The audit flow ${view.run.status}.`,
              ]
                .filter(Boolean)
                .join(" "),
            );
          }
        }
      }
      yield* insertFindings(row, review);

      const failedScanners = runs.filter((run) => run.status === "failed");
      if (failedScanners.length > 0) {
        incomplete.push(
          `Scanner failed: ${failedScanners.map((run) => `${run.scannerId} (${run.summary})`).join("; ")}.`,
        );
      }
      const notRun = runs.filter((run) => run.status === "unavailable").map((run) => run.scannerId);
      const all = (yield* selectFindings(row.assessmentId)).map(toFinding);
      const blocked = verdictFor(all, row.threshold as CyberSeverity) === "fail";
      const note = [
        ...incomplete,
        notRun.length > 0 ? `Scanners not run: ${notRun.join(", ")}.` : null,
      ]
        .filter(Boolean)
        .join(" ");
      yield* finish(
        row.assessmentId,
        blocked ? "fail" : incomplete.length > 0 ? "error" : "pass",
        note || null,
      );
    });

  /** A running audit stuck on a step that waits for a person (quota, approval): say so, not "running". */
  const attentionOf = (row: AssessmentRow) =>
    Effect.gen(function* () {
      if (row.verdict !== "running" || !row.flowId) return null;
      const view = yield* flow
        .get(row.flowId as FlowRunId)
        .pipe(Effect.mapError(toError("Could not read the audit flow.")));
      const waiting = view?.nodes.filter((node) => node.status === "needs_you") ?? [];
      if (waiting.length === 0) return null;
      const areas = waiting.map((node) => node.nodeId.replace(/^audit-/, "")).join(", ");
      return `Waiting for you on: ${areas}. ${waiting[0]?.statusReason ?? ""} Open Flows to continue.`.trim();
    });

  const status: CyberSecurityShape["status"] = (projectId) =>
    Effect.gen(function* () {
      const latest = (yield* selectAssessments(projectId))[0];
      if (!latest)
        return { assessment: null, findings: [], scanners: [] } satisfies CyberSecurityStatus;
      yield* settle(latest);
      const row = (yield* selectAssessment(latest.assessmentId)) ?? latest;
      const findings = (yield* selectFindings(row.assessmentId)).map(toFinding);
      const note = yield* attentionOf(row);
      const scanners = (yield* selectScannerRuns(row.assessmentId)).map(
        (run): CyberScannerRun => ({
          id: run.scannerId,
          label: SCANNERS.find((scanner) => scanner.id === run.scannerId)?.label ?? run.scannerId,
          status: run.status as CyberScannerRun["status"],
          summary: run.summary,
          findings: run.findingCount,
          attention: run.attention,
        }),
      );
      return { assessment: toAssessment(row, findings, note), findings, scanners };
    });

  const start: CyberSecurityShape["start"] = (input) =>
    Effect.gen(function* () {
      const running = (yield* selectAssessments(input.projectId))[0];
      if (running?.verdict === "running") {
        return toAssessment(running, []);
      }
      const shell = yield* snapshotQuery
        .getProjectShellById(input.projectId)
        .pipe(Effect.mapError(toError("Could not read the project.")));
      const root = Option.getOrNull(shell)?.workspaceRoot;
      if (!root) {
        return yield* new CyberSecurityError({ message: "This project has no folder to assess." });
      }
      const inventory = yield* Effect.tryPromise({
        try: () => detectRepoInventory(root),
        catch: toError("Could not scan the repository."),
      });
      const applicable = applicableScanners(inventory);
      const narrowed = narrowSteps(
        input.steps,
        matchCategories(inventory),
        applicable.map((scanner) => scanner.id),
      );
      if ("error" in narrowed) return yield* new CyberSecurityError({ message: narrowed.error });
      const matched = narrowed.categories;
      const scanners = applicable.filter((scanner) => narrowed.scannerIds.includes(scanner.id));
      const assessmentId = randomUUID();
      const threshold = input.threshold ?? DEFAULT_THRESHOLD;
      const startedAt = new Date().toISOString();

      // The model reviews the areas the repo has; the scanners run beside it. Nothing for either:
      // record the scan and pass.
      let flowId: string | null = null;
      if (matched.length > 0) {
        const spec = buildAssessmentFlow({
          name: "Cyber Security assessment",
          inventory,
          categories: matched,
        });
        const view = yield* flow
          .start({
            projectId: input.projectId,
            spec,
            modelSelection: input.modelSelection,
            runtimeMode: "auto",
            startedBy: input.startedBy,
          })
          .pipe(Effect.mapError(toError("Could not start the audit flow.")));
        flowId = view.run.id;
      }
      const hasWork = flowId !== null || scanners.length > 0;

      yield* sql`
        INSERT INTO cyber_security_assessments (assessment_id, project_id, flow_id, verdict,
          threshold, inventory_json, categories_json, steps_json, error, started_at, finished_at,
          ingested)
        VALUES (${assessmentId}, ${input.projectId}, ${flowId},
          ${hasWork ? "running" : "pass"}, ${threshold}, ${JSON.stringify(inventory)},
          ${JSON.stringify(matched)}, ${input.steps ? JSON.stringify(input.steps) : null}, NULL, ${startedAt}, ${hasWork ? null : startedAt},
          ${hasWork ? 0 : 1})
      `.pipe(Effect.mapError(toError("Could not save the assessment.")));

      if (scanners.length > 0) {
        yield* Effect.forEach(
          scanners,
          (scanner) => saveScannerRun(assessmentId, scanner.id, { status: "pending" }),
          { discard: true },
        );
        const created = yield* selectAssessment(assessmentId);
        activeScans.add(assessmentId);
        // Network scanners run only when a person started this run at an autonomy level that
        // allows egress; otherwise they stay offline and say why in their summary.
        const autonomy = aegis
          ? yield* aegis.settings().pipe(
              Effect.map((settings) => settings.autonomy),
              Effect.orElseSucceed(() => null),
            )
          : null;
        const sandboxAvailable = detectSandbox() !== null;
        const online = decideOnline({
          autonomy,
          startedBy: input.startedBy,
          sandboxAvailable,
        });
        const dynamic = {
          decision: decideDynamic({
            confirmed: input.dynamicScan !== undefined,
            autonomy,
            startedBy: input.startedBy,
            sandboxAvailable,
          }),
          request: input.dynamicScan ?? null,
        };
        yield* Effect.forkDetach(runScanners(created!, root, inventory, online, dynamic));
      }

      const row = yield* selectAssessment(assessmentId);
      return toAssessment(row!, []);
    });

  const setFindingStatus: CyberSecurityShape["setFindingStatus"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE cyber_security_findings
        SET status = ${input.status}, updated_at = ${new Date().toISOString()},
          fix_thread_id = COALESCE(${input.fixThreadId ?? null}, fix_thread_id)
        WHERE finding_id = ${input.findingId} AND project_id = ${input.projectId}
      `.pipe(Effect.mapError(toError("Could not update the finding.")));
      const found = (yield* sql<FindingRow>`
        SELECT finding_id AS "findingId", project_id AS "projectId", assessment_id AS "assessmentId",
          title, severity, category, file, line, detail, fix, status, source, fix_thread_id AS "fixThreadId",
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM cyber_security_findings
        WHERE finding_id = ${input.findingId} AND project_id = ${input.projectId}
      `.pipe(Effect.mapError(toError("Could not read the finding."))))[0];
      if (!found)
        return yield* new CyberSecurityError({ message: "That finding no longer exists." });

      // The gate follows the board: resolving the last blocking finding turns the verdict to pass.
      const assessment = yield* selectAssessment(found.assessmentId);
      if (assessment && (assessment.verdict === "pass" || assessment.verdict === "fail")) {
        const verdict = verdictFor(
          (yield* selectFindings(found.assessmentId)).map(toFinding),
          assessment.threshold as CyberSeverity,
        );
        yield* sql`
          UPDATE cyber_security_assessments SET verdict = ${verdict}
          WHERE assessment_id = ${assessment.assessmentId}
        `.pipe(Effect.mapError(toError("Could not update the verdict.")));
      }
      return toFinding(found);
    });

  return { status, start, setFindingStatus } satisfies CyberSecurityShape;
});

export const CyberSecurityLive = Layer.effect(CyberSecurity, make);
