// FILE: HostEconomyView.tsx
// Purpose: S8 Host Economy: memory and seat figures, the eight-hour memory pressure chart, every
//          agent with hibernate / wake / stop, and the opt-in MCP Hub.
// Layer: Web host economy view
// Exports: HostEconomyView

import type { EconomyAgent, EconomyStatus, ThreadId } from "@saint/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { UsageProgressTrack } from "~/components/UsageProgressTrack";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { StatusChip } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { economyStatusQueryOptions, flowQueryKeys } from "~/lib/flowQueryOptions";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn, newCommandId } from "~/lib/utils";
import { ensureLocalNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { LEVEL_TONE, chartY, formatMb, pressureChartPaths, usedPercent } from "./hostEconomy.logic";

const CHART_WIDTH = 640;
const CHART_HEIGHT = 120;

const AGENT_TONE: Record<EconomyAgent["state"], string> = {
  active: "text-info-foreground",
  idle: "text-muted-foreground",
  hibernated: "text-warning",
};

function useEconomyMutation<I>(run: (input: I) => Promise<EconomyStatus>, failure: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (status) => queryClient.setQueryData(flowQueryKeys.economy, status),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: failure,
        description: error instanceof Error ? error.message : "Try again.",
      }),
  });
}

function MetricCard({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 px-3 py-2.5">
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      <span className="text-ui-lg font-medium tabular-nums text-foreground">{value}</span>
      {children}
    </div>
  );
}

function MemoryPressureChart({ status }: { status: EconomyStatus }) {
  const { used, stall } = pressureChartPaths(status.samples, CHART_WIDTH, CHART_HEIGHT);
  const { warnUsedPct, criticalUsedPct } = status.settings;
  return (
    <section aria-label="Memory pressure" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="text-ui-lg font-medium">Memory pressure</h2>
        <span className="text-ui-sm text-muted-foreground">
          last {Math.round(status.samples.length / 60)} h · used{" "}
          <span className="text-info-foreground">—</span>
          {stall ? (
            <>
              {" "}
              · stalls <span className="text-warning">—</span>
            </>
          ) : null}
        </span>
      </div>
      {status.samples.length < 2 ? (
        <p className="text-ui-sm text-muted-foreground">
          Saint samples the host once a minute; the chart fills in as samples arrive.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Used memory over the last ${status.samples.length} minutes`}
          className="h-32 w-full rounded-md bg-muted/40"
        >
          {[
            { pct: warnUsedPct, tone: "text-warning" },
            { pct: criticalUsedPct, tone: "text-destructive" },
          ].map((line) => (
            <line
              key={line.pct}
              x1={0}
              x2={CHART_WIDTH}
              y1={chartY(line.pct, CHART_HEIGHT)}
              y2={chartY(line.pct, CHART_HEIGHT)}
              className={cn("stroke-current opacity-40", line.tone)}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polyline
            points={used}
            fill="none"
            className="stroke-current text-info-foreground"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
          {stall ? (
            <polyline
              points={stall}
              fill="none"
              className="stroke-current text-warning"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
      )}
    </section>
  );
}

function AgentRows({ status }: { status: EconomyStatus }) {
  const navigate = useNavigate();
  const threads = useStore((state) => state.threadShellById);
  const agentAction = useEconomyMutation(
    (input: { threadId: ThreadId; action: "hibernate" | "wake" }) =>
      ensureLocalNativeApi().economy.agent(input),
    "Could not change the agent",
  );
  const stop = useMutation({
    mutationFn: (threadId: ThreadId) =>
      ensureLocalNativeApi().orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        requestedBy: "user",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not stop the agent",
        description: error instanceof Error ? error.message : "Try again.",
      }),
  });
  if (status.agents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No agents running</EmptyTitle>
          <EmptyDescription>
            Agents appear here while their provider session is live.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div role="list" aria-label="Agents" className="flex flex-col gap-0.5">
      {status.agents.map((agent) => (
        <div
          key={agent.threadId}
          role="listitem"
          className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
        >
          <StatusChip
            className={cn("w-24", AGENT_TONE[agent.state])}
            pulse={agent.state === "active"}
          >
            {agent.state}
          </StatusChip>
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-ui"
            onClick={() =>
              void navigate({ to: "/$threadId", params: { threadId: agent.threadId } })
            }
          >
            {threads?.[agent.threadId]?.title ?? agent.threadId}
          </button>
          <span className="shrink-0 text-ui-sm tabular-nums text-muted-foreground">
            {agent.provider}
            {agent.rssMb !== null ? ` · ${formatMb(agent.rssMb)} · ${agent.cpuPct ?? 0}% CPU` : ""}
            {agent.hibernatedAt
              ? ` · slept ${formatRelativeTime(agent.hibernatedAt)}`
              : agent.lastSeenAt
                ? ` · ${formatRelativeTime(agent.lastSeenAt)}`
                : ""}
          </span>
          {agent.state === "hibernated" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => agentAction.mutate({ threadId: agent.threadId, action: "wake" })}
            >
              Wake
            </Button>
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={!agent.resumable}
                title={
                  agent.resumable ? undefined : "This provider cannot resume a stopped session."
                }
                onClick={() =>
                  agentAction.mutate({ threadId: agent.threadId, action: "hibernate" })
                }
              >
                Hibernate
              </Button>
              <Button size="xs" variant="ghost" onClick={() => stop.mutate(agent.threadId)}>
                Stop
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function McpHubRows({ status }: { status: EconomyStatus }) {
  const update = useEconomyMutation(
    (hubShared: string[]) => ensureLocalNativeApi().economy.update({ hubShared }),
    "Could not change the MCP Hub",
  );
  if (status.hub.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        No MCP servers are running under agents right now.
      </p>
    );
  }
  return (
    <div role="list" aria-label="MCP servers" className="flex flex-col gap-0.5">
      {status.hub.map((server) => (
        <div
          key={server.command}
          role="listitem"
          className="flex min-w-0 items-center gap-3 px-2 py-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-mono text-ui-sm">{server.command}</span>
            <span className="text-ui-xs text-muted-foreground tabular-nums">
              {server.instances} running · {formatMb(server.rssMb)}
              {server.shared ? ` · shared as ${server.name} · ${server.sessions} sessions` : ""}
            </span>
          </div>
          <Switch
            checked={server.shared}
            aria-label={`Share ${server.command} across agents`}
            onCheckedChange={(checked) =>
              update.mutate(
                checked
                  ? [...status.settings.hubShared, server.command]
                  : status.settings.hubShared.filter((command) => command !== server.command),
              )
            }
          />
        </div>
      ))}
    </div>
  );
}

export function HostEconomyView() {
  const economy = useQuery(economyStatusQueryOptions());
  const status = economy.data;
  const latest = status?.latest ?? null;
  const used = latest ? usedPercent(latest) : 0;

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          {latest ? (
            <StatusChip className={cn("ml-auto", LEVEL_TONE[latest.level])}>
              {latest.level}
            </StatusChip>
          ) : null}
        </RouteSurfaceHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-7 px-6 pt-10 pb-20">
            <header className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Host Economy
              </h1>
              <p className="text-ui text-muted-foreground">
                Memory and agents on this host. Idle agents hibernate and wake on their next
                message.
              </p>
            </header>

            {!status ? (
              <p className="text-ui-sm text-muted-foreground">
                {economy.isError ? "Host economy is not available on this server." : "Loading…"}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard
                    label="Memory used"
                    value={
                      latest ? `${formatMb(latest.usedMb)} / ${formatMb(latest.totalMb)}` : "—"
                    }
                  >
                    <UsageProgressTrack
                      label="Memory used"
                      remainingPercent={used}
                      fillClassName={
                        latest?.level === "ok"
                          ? "bg-info"
                          : latest?.level === "warn"
                            ? "bg-warning"
                            : "bg-destructive"
                      }
                      markerPercent={status.settings.warnUsedPct}
                      markerClassName="bg-warning"
                      className="h-1.5"
                    />
                  </MetricCard>
                  <MetricCard
                    label="Memory stalls"
                    value={latest?.stallPct != null ? `${latest.stallPct}%` : "n/a"}
                  />
                  <MetricCard
                    label="Agent seats"
                    value={`${status.seatsUsed}${status.settings.seatCap !== null ? ` / ${status.settings.seatCap}` : ""}`}
                  />
                  <MetricCard
                    label="Agents' memory"
                    value={latest ? formatMb(latest.agentRssMb) : "—"}
                  />
                </div>
                {status.admission ? (
                  <p className="text-ui-sm text-warning">{status.admission}</p>
                ) : null}

                <MemoryPressureChart status={status} />

                <section className="flex flex-col gap-1">
                  <h2 className="text-ui-lg font-medium">Agents</h2>
                  <AgentRows status={status} />
                </section>

                <section className="flex flex-col gap-1">
                  <h2 className="text-ui-lg font-medium">MCP Hub</h2>
                  <p className="text-ui-sm text-muted-foreground">
                    A shared server runs once for every agent and appears to them as{" "}
                    <span className="font-mono">name_hub</span>. Remove the per-agent copy from your
                    provider's MCP config to free its memory.
                  </p>
                  <McpHubRows status={status} />
                </section>
              </>
            )}
          </div>
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
