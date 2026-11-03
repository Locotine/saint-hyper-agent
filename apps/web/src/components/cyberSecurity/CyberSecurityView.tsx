// FILE: CyberSecurityView.tsx
// Purpose: Cyber Security for one project: run the read-only assessment, see
//          what was detected in the repo and the gate verdict, and triage the findings on a board
//          with Fix / Fix all that open a chat.
// Layer: Web cyber security view
// Exports: CyberSecurityView

import type {
  CyberDynamicScanRequest,
  CyberFinding,
  CyberFindingStatus,
  CyberScannerRun,
  CyberSecurityStatus,
  CyberSeverity,
  CyberSeverityCounts,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@saint/contracts";
import { getDefaultModel } from "@saint/shared/model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { SEVERITY_TONE } from "~/components/security/security.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { BUTTON_GROUP_ACTIVE_CLASS_NAME, ButtonGroup } from "~/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { StatusChip, StatusDot } from "~/components/ui/status-chip";
import { toastManager } from "~/components/ui/toast";
import { hostHandle, useHostId } from "~/hosts/hostScope";
import { cyberSecurityStatusQueryOptions, flowQueryKeys } from "~/lib/flowQueryOptions";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { getThreadFromState } from "~/threadDerivation";
import {
  attentionItems,
  cyberSecurityHostSupported,
  fixAllTargets,
  pickDynamicScript,
  SEVERITY_ORDER,
} from "./cyberSecurity.logic";
import { FindingsBoard } from "./FindingsBoard";
import { LocalOnlyNotice } from "./LocalOnlyNotice";
import { useFixInChat } from "./useFixInChat";

const failure = (title: string) => (error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Try again.",
  });

function VerdictBanner({ status }: { status: CyberSecurityStatus }) {
  const { assessment } = status;
  if (!assessment) return null;
  const tone = {
    running: "bg-muted/60 text-foreground",
    pass: "bg-success/10 text-success",
    fail: "bg-destructive/10 text-destructive",
    error: "bg-destructive/10 text-destructive",
  }[assessment.verdict];
  return (
    <div role="status" className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-ui", tone)}>
      {assessment.verdict === "running" ? <Spinner className="size-4" /> : null}
      <span className="font-medium capitalize">
        {assessment.verdict === "running" ? "Auditing" : assessment.verdict}
      </span>
      <span className="text-ui-sm">
        {assessment.verdict === "running"
          ? (assessment.error ?? assessment.categories.join(", "))
          : assessment.verdict === "error"
            ? (assessment.error ?? "The audit did not finish.")
            : assessment.verdict === "fail"
              ? `Unresolved findings at or above ${assessment.threshold} block production.${assessment.error ? ` Incomplete: ${assessment.error}` : ""}`
              : assessment.categories.length === 0
                ? "Nothing in this repo matches an area the assessment covers."
                : `No unresolved finding at or above ${assessment.threshold}.${assessment.error ? ` Note: ${assessment.error}` : ""}`}
      </span>
    </div>
  );
}

const SCANNER_DOT: Record<CyberScannerRun["status"], string> = {
  pending: "bg-muted-foreground/50",
  running: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
  unavailable: "bg-muted-foreground/30",
};

/** Each scanner that ran beside the model's review, and what it did. */
function Scanners({ scanners }: { scanners: ReadonlyArray<CyberScannerRun> }) {
  if (scanners.length === 0) return null;
  return (
    <section aria-label="Scanners" className="flex flex-col gap-2">
      <h2 className="text-ui-lg font-medium">Scanners</h2>
      <ul className="flex flex-col gap-1">
        {scanners.map((scanner) => (
          <li key={scanner.id} className="flex min-w-0 items-center gap-2 text-ui-sm">
            <StatusDot
              className={SCANNER_DOT[scanner.status]}
              pulse={scanner.status === "running"}
              aria-hidden
            />
            <span className="shrink-0 font-medium">{scanner.label}</span>
            <span className="shrink-0 text-muted-foreground">{scanner.status}</span>
            {scanner.summary ? (
              <span className="min-w-0 truncate text-muted-foreground" title={scanner.summary}>
                · {scanner.summary}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function CountCards({ counts }: { counts: CyberSeverityCounts }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {SEVERITY_ORDER.map((severity) => (
        <div key={severity} className="rounded-lg bg-muted/40 px-3 py-2">
          <div className="text-ui-sm text-muted-foreground capitalize">{severity}</div>
          <div
            className={cn("text-2xl font-medium", counts[severity] > 0 && SEVERITY_TONE[severity])}
          >
            {counts[severity]}
          </div>
        </div>
      ))}
    </div>
  );
}

function Detected({ status }: { status: CyberSecurityStatus }) {
  const { assessment } = status;
  if (!assessment) return null;
  const { inventory } = assessment;
  const rows: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["Languages", inventory.languages],
    ["Frameworks", inventory.frameworks],
    ["Surfaces found", inventory.surfaces],
    ["Audited", assessment.categories],
  ];
  return (
    <section aria-label="Detected in this repo" className="flex flex-col gap-2">
      <h2 className="text-ui-lg font-medium">Detected in this repo</h2>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-ui-sm">
        {rows.map(([label, values]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{values.length > 0 ? values.join(", ") : "None"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function CyberSecurityView({ projectId }: { projectId: ProjectId }) {
  const hostId = useHostId();
  const queryClient = useQueryClient();
  const project = useStore((state) => state.projects.find((entry) => entry.id === projectId));
  const hostSupported = cyberSecurityHostSupported(hostId);
  const query = useQuery({
    ...cyberSecurityStatusQueryOptions(hostId, projectId),
    enabled: hostSupported,
  });
  const queryKey = flowQueryKeys.cyberSecurity(hostId, projectId);
  const api = () => hostHandle(hostId).requireApi();
  const [severityFilter, setSeverityFilter] = useState<CyberSeverity | "all">("all");
  const fix = useFixInChat(projectId);

  // Attacking the running app is opt-in for each run: the option needs one unambiguous script that
  // starts it, and a confirmation names that script before anything starts.
  const scripts = useQuery({
    queryKey: ["cyberSecurity", "dev-script", hostId, project?.cwd ?? null],
    queryFn: () => api().projects.discoverScripts({ cwd: project!.cwd, depth: 2 }),
    enabled: hostSupported && Boolean(project?.cwd),
    staleTime: 60_000,
  });
  const dynamicScript = pickDynamicScript(scripts.data?.targets ?? []);
  const [scanApp, setScanApp] = useState(false);
  const [confirmingScan, setConfirmingScan] = useState(false);

  const start = useMutation({
    mutationFn: (dynamicScan?: CyberDynamicScanRequest) => {
      const modelSelection: ModelSelection = project?.defaultModelSelection ?? {
        provider: "codex",
        model: getDefaultModel("codex"),
      };
      return api().cyberSecurity.start({
        projectId,
        modelSelection,
        ...(dynamicScan ? { dynamicScan } : {}),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: failure("Couldn't start the assessment"),
  });
  const move = useMutation({
    mutationFn: (input: { finding: CyberFinding; status: CyberFindingStatus }) =>
      api().cyberSecurity.setFindingStatus({
        projectId,
        findingId: input.finding.id,
        status: input.status,
      }),
    onMutate: ({ finding, status }) => {
      // The card follows the drop at once; the next poll confirms it.
      queryClient.setQueryData<CyberSecurityStatus>(queryKey, (current) =>
        current
          ? {
              ...current,
              findings: current.findings.map((entry) =>
                entry.id === finding.id ? { ...entry, status } : entry,
              ),
            }
          : current,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
    onError: failure("Couldn't move the finding"),
  });

  const status = query.data;
  const assessment = status?.assessment ?? null;

  // A scanner that cannot run, or cannot be confined, until the person acts (install a package,
  // allow the network, an administrator right) is raised once per assessment in a dialog.
  const attention = attentionItems(status?.scanners ?? []);
  const attentionKey =
    attention.length > 0
      ? `${assessment?.id ?? ""}|${attention.map((item) => item.text).join("|")}`
      : "";
  const [dismissedAttention, setDismissedAttention] = useState("");
  const attentionOpen = attentionKey !== "" && attentionKey !== dismissedAttention;

  // A finding whose Fix chat finished its turn moves to Triaging, ready for your review.
  // Resolved stays your call: a finished chat is not proof, so you drag it there (or re-run).
  const inFix = (status?.findings ?? []).filter(
    (finding) => finding.status === "fixing" && finding.fixThreadId,
  );
  const fixTurnStates = useStore((state) =>
    inFix
      .map(
        (finding) =>
          getThreadFromState(state, finding.fixThreadId as ThreadId)?.latestTurn?.state ?? "",
      )
      .join(","),
  );
  const movedToReview = useRef(new Set<string>());
  useEffect(() => {
    const states = fixTurnStates.split(",");
    inFix.forEach((finding, index) => {
      if (states[index] !== "completed" || movedToReview.current.has(finding.id)) return;
      movedToReview.current.add(finding.id);
      move.mutate({ finding, status: "triaging" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the turn states
  }, [fixTurnStates]);
  const running = assessment?.verdict === "running";
  const targets = status && assessment ? fixAllTargets(status.findings, assessment.threshold) : [];

  if (!hostSupported) {
    return (
      <RouteInsetSurface>
        <RouteSurface>
          <RouteSurfaceHeader />
          <div className="mx-auto w-full max-w-[52rem] px-6 pt-10">
            <LocalOnlyNotice />
          </div>
        </RouteSurface>
      </RouteInsetSurface>
    );
  }

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          {assessment ? (
            <StatusChip
              className={cn(
                "ml-auto capitalize",
                assessment.verdict === "pass" ? "text-success" : "text-destructive",
              )}
            >
              {assessment.verdict}
            </StatusChip>
          ) : null}
        </RouteSurfaceHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-6 px-6 pt-10 pb-20">
            <header className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  Cyber Security
                </h1>
                <p className="text-ui text-muted-foreground">
                  {project?.name ?? "This project"}: a read-only check of what this repo contains,
                  before it goes to production.
                </p>
              </div>
              {status ? (
                <div className="flex items-center gap-2">
                  <label
                    className={cn(
                      "flex items-center gap-2 text-ui-sm",
                      !dynamicScript.ok && "text-muted-foreground",
                    )}
                    title={dynamicScript.ok ? undefined : dynamicScript.reason}
                  >
                    <Checkbox
                      checked={scanApp && dynamicScript.ok}
                      disabled={!dynamicScript.ok || running || start.isPending}
                      onCheckedChange={(checked) => setScanApp(checked === true)}
                    />
                    Also scan the running app
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={targets.length === 0 || fix.isPending}
                    onClick={() => fix.mutate({ findings: targets })}
                  >
                    Fix all{targets.length > 0 ? ` (${targets.length})` : ""}
                  </Button>
                  <Button
                    size="sm"
                    disabled={running || start.isPending}
                    onClick={() =>
                      scanApp && dynamicScript.ok
                        ? setConfirmingScan(true)
                        : start.mutate(undefined)
                    }
                  >
                    {running || start.isPending ? "Running…" : "Run assessment"}
                  </Button>
                </div>
              ) : null}
            </header>

            {dynamicScript.ok ? (
              <AlertDialog open={confirmingScan} onOpenChange={setConfirmingScan}>
                <AlertDialogPopup>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Attack your running app?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Saint will start <code>{dynamicScript.command}</code>
                      {dynamicScript.request.packagePath
                        ? ` in ${dynamicScript.request.packagePath}`
                        : ""}
                      , send Nuclei's safe HTTP checks to the localhost address it opens (no
                      intrusive or brute-force tests, nothing leaves this computer), then stop it. A
                      dev server already running for this project is scanned as it is and left
                      running.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                      Cancel
                    </AlertDialogClose>
                    <Button
                      size="sm"
                      onClick={() => {
                        setConfirmingScan(false);
                        start.mutate(dynamicScript.request);
                      }}
                    >
                      Start scan
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogPopup>
              </AlertDialog>
            ) : null}

            <AlertDialog
              open={attentionOpen}
              onOpenChange={(open) => {
                if (!open) setDismissedAttention(attentionKey);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Some scanners need your help</AlertDialogTitle>
                  <AlertDialogDescription>
                    These could not run, or could not be confined, on the machine that holds this
                    project. Nothing was changed there.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <ul className="space-y-2 px-6 pb-2 text-ui">
                  {attention.map((item) => (
                    <li key={item.text}>
                      <span className="font-medium">{item.label}</span>
                      <p className="text-ui-sm text-muted-foreground">{item.text}</p>
                    </li>
                  ))}
                </ul>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button size="sm" />}>Got it</AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {query.isError ? (
              <p className="text-ui text-destructive">Couldn't reach this project's host.</p>
            ) : null}

            {status ? (
              <>
                <p className="text-ui-sm text-muted-foreground">
                  Only the areas this repo has are audited.
                </p>
                {assessment ? (
                  <>
                    <VerdictBanner status={status} />
                    <CountCards counts={assessment.counts} />
                    <Detected status={status} />
                    <Scanners scanners={status.scanners} />
                    <section aria-label="Findings" className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-ui-lg font-medium">Findings</h2>
                        <ButtonGroup
                          label="Severity filter"
                          className="[&_button]:!w-auto [&_button]:px-3"
                        >
                          {(["all", ...SEVERITY_ORDER] as const).map((value) => (
                            <Button
                              key={value}
                              size="xs"
                              variant="ghost"
                              aria-pressed={severityFilter === value}
                              className={cn(
                                "capitalize",
                                severityFilter === value && BUTTON_GROUP_ACTIVE_CLASS_NAME,
                              )}
                              onClick={() => setSeverityFilter(value)}
                            >
                              {value}
                            </Button>
                          ))}
                        </ButtonGroup>
                      </div>
                      <FindingsBoard
                        findings={status.findings}
                        severityFilter={severityFilter}
                        fixing={fix.isPending}
                        onMove={(finding, next) => move.mutate({ finding, status: next })}
                        onFix={(finding) => fix.mutate({ findings: [finding] })}
                      />
                    </section>
                  </>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No assessment yet</EmptyTitle>
                      <EmptyDescription>
                        Run it to see what this repo contains and what needs fixing before
                        production.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </>
            ) : null}
          </div>
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
