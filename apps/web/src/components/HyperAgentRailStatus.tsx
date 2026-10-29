// FILE: HyperAgentRailStatus.tsx
// Purpose: The rail's HyperAgent chips: a status button (autonomy level, open alerts, host memory,
//          agent seats, flows waiting) whose hover card is the status bar, and a Kill button,
//          shown while flows run, that cancels every flow after a confirm.
// Layer: Web shell
// Exports: HyperAgentRailStatus

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { appRailButtonClassName } from "./AppRail";
import { useFlowAttention } from "./flows/FlowAttention";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { StatusDot } from "./ui/status-chip";
import { toastManager } from "./ui/toast";
import { UsageProgressTrack } from "./UsageProgressTrack";
import {
  aegisStatusQueryOptions,
  economyStatusQueryOptions,
  flowListQueryOptions,
  flowQueryKeys,
} from "~/lib/flowQueryOptions";
import { ShieldCheckIcon, StopFilledIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureLocalNativeApi } from "~/nativeApi";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-ui-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function HyperAgentRailStatus({ onOpenSecurity }: { onOpenSecurity: () => void }) {
  const aegis = useQuery(aegisStatusQueryOptions()).data;
  const economy = useQuery(economyStatusQueryOptions()).data;
  const runs = useQuery(flowListQueryOptions()).data?.runs ?? [];
  const waiting = useFlowAttention().length;
  const running = runs.filter((run) => run.status === "running" || run.status === "paused").length;
  const latest = economy?.latest ?? null;
  const usedPct = latest && latest.totalMb > 0 ? (latest.usedMb / latest.totalMb) * 100 : 0;
  const openAlerts = aegis?.openAlerts ?? 0;
  const tone =
    latest?.level === "critical" || openAlerts > 0
      ? "bg-destructive"
      : latest?.level === "warn" || waiting > 0
        ? "bg-warning"
        : null;

  return (
    <>
      <PreviewCard>
        <PreviewCardTrigger
          {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
          render={
            <button
              type="button"
              aria-label={`Autonomy ${aegis?.settings.autonomy ?? "unknown"}, ${openAlerts} open alerts. Open Security`}
              className={cn(
                appRailButtonClassName(false),
                "relative flex shrink-0 items-center justify-center",
              )}
              onClick={onOpenSecurity}
            />
          }
        >
          <ShieldCheckIcon className="size-4" aria-hidden />
          {tone ? <StatusDot className={cn("absolute top-1 right-1", tone)} /> : null}
        </PreviewCardTrigger>
        <PreviewCardPopup
          {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
          align="end"
          sideOffset={6}
          className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
        >
          <div className="space-y-2 p-2.5">
            <Row label="Autonomy" value={aegis?.settings.autonomy ?? "—"} />
            <Row label="Open alerts" value={String(openAlerts)} />
            <Row label="Flows waiting for you" value={String(waiting)} />
            <Row label="Flows running" value={String(running)} />
            <Row
              label="Host memory"
              value={latest ? `${Math.round(usedPct)}% · ${latest.level}` : "—"}
            />
            {latest ? (
              <UsageProgressTrack
                label="Host memory used"
                remainingPercent={usedPct}
                markerPercent={economy?.settings.warnUsedPct}
                fillClassName={
                  latest.level === "ok"
                    ? "bg-success"
                    : latest.level === "warn"
                      ? "bg-warning"
                      : "bg-destructive"
                }
                markerClassName="bg-warning"
              />
            ) : null}
            <Row
              label="Agent seats"
              value={
                economy
                  ? `${economy.seatsUsed}${economy.settings.seatCap === null ? "" : ` / ${economy.settings.seatCap}`}`
                  : "—"
              }
            />
          </div>
        </PreviewCardPopup>
      </PreviewCard>
      {running > 0 ? <KillAllButton running={running} /> : null}
    </>
  );
}

function KillAllButton({ running }: { running: number }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const kill = useMutation({
    mutationFn: () => ensureLocalNativeApi().flows.killAll({}),
    onSuccess: ({ cancelled }) => {
      setOpen(false);
      toastManager.add({
        type: "success",
        title: `Stopped ${cancelled} ${cancelled === 1 ? "flow" : "flows"}`,
      });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't stop the flows",
        description: error instanceof Error ? error.message : String(error),
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: flowQueryKeys.all }),
  });
  return (
    <>
      <button
        type="button"
        aria-label={`Kill ${running} running ${running === 1 ? "flow" : "flows"}`}
        title="Kill every flow"
        className={cn(
          appRailButtonClassName(false),
          "flex shrink-0 items-center justify-center text-destructive",
        )}
        onClick={() => setOpen(true)}
      >
        <StopFilledIcon className="size-4" aria-hidden />
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill every flow?</AlertDialogTitle>
            <AlertDialogDescription>
              Stops {running} {running === 1 ? "flow" : "flows"} and interrupts every running step.
              Plain chats keep running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" disabled={kill.isPending} onClick={() => kill.mutate()}>
              Kill all
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
