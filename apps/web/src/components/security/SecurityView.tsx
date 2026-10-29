// FILE: SecurityView.tsx
// Purpose: S7 Security: the alert feed with batch decisions and the "why" chain of each alert,
//          the L0–L4 autonomy ladder, live protection layers, the Cedar policy with protected
//          zones and egress lists, frozen worktrees with Unfreeze, chats running without the
//          sandbox, and the ledger audit chain.
// Layer: Web security view
// Exports: SecurityView

import type { AegisAlert, AegisStatus, AutonomyLevel, ThreadId } from "@saint/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { Button } from "~/components/ui/button";
import { BUTTON_GROUP_ACTIVE_CLASS_NAME, ButtonGroup } from "~/components/ui/button-group";
import { Checkbox } from "~/components/ui/checkbox";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { StatusChip, StatusDot } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { downloadBlob } from "~/lib/browserDownload";
import {
  aegisAlertsQueryOptions,
  aegisStatusQueryOptions,
  flowQueryKeys,
  ledgerVerifyQueryOptions,
} from "~/lib/flowQueryOptions";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { ensureLocalNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { AUTONOMY_LEVELS, SEVERITY_TONE, sortAlertsByRisk } from "./security.logic";

const LAYER_LABEL: Record<AegisStatus["layers"][number]["id"], string> = {
  sandbox: "OS sandbox",
  egress: "Egress proxy",
  policy: "Policy",
  tripwire: "Tripwires",
  ledger: "Ledger",
  capabilities: "Capability ceilings",
};

const failure = (title: string) => (error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Try again.",
  });

type AegisUpdate = Parameters<ReturnType<typeof ensureLocalNativeApi>["aegis"]["update"]>[0];

function useAegisUpdate(errorTitle: string, onSaved?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AegisUpdate) => ensureLocalNativeApi().aegis.update(input),
    onSuccess: (next) => {
      queryClient.setQueryData(flowQueryKeys.aegisStatus, next);
      onSaved?.();
    },
    onError: failure(errorTitle),
  });
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function RunWithoutSandboxButton({ threadId }: { threadId: ThreadId }) {
  const update = useAegisUpdate("Could not change the sandbox");
  return (
    <div className="flex flex-col gap-1 rounded-md border border-warning/40 p-2">
      <p className="text-ui-sm text-warning">
        Without the sandbox this chat's agent can read your credentials and reach any host. Use it
        only when the sandbox stops work you trust.
      </p>
      <Button
        size="xs"
        variant="destructive-outline"
        className="self-start"
        disabled={update.isPending}
        onClick={() => update.mutate({ runWithoutSandbox: { threadId, enabled: true } })}
      >
        Run this chat without sandbox
      </Button>
    </div>
  );
}

function AlertRow({
  alert,
  selected,
  onSelect,
}: {
  alert: AegisAlert;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div role="listitem" className="rounded-md px-2 py-1.5 hover:bg-accent/60">
      <div className="flex min-w-0 items-center gap-3">
        <Checkbox
          checked={selected}
          disabled={alert.state !== "open"}
          aria-label={`Select ${alert.title}`}
          onCheckedChange={(checked) => onSelect(Boolean(checked))}
        />
        <StatusChip className={cn("w-20", SEVERITY_TONE[alert.severity])}>
          {alert.severity}
        </StatusChip>
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="min-w-0 truncate text-ui">{alert.title}</span>
          <DisclosureChevron open={open} className="shrink-0 text-muted-foreground" />
        </button>
        <span className="shrink-0 text-ui-sm text-muted-foreground">
          {alert.state === "open" ? "" : `${alert.state} · `}
          {formatRelativeTime(alert.createdAt)}
        </span>
      </div>
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-1 pt-1.5 pl-9">
          <p className="text-ui-sm text-foreground">{alert.detail}</p>
          <ol aria-label="Why" className="flex flex-col gap-0.5 text-ui-sm text-muted-foreground">
            {alert.why.map((step, index) => (
              <li key={`${index}:${step}`} className="font-mono">
                {index === 0 ? "" : "→ "}
                {step}
              </li>
            ))}
          </ol>
          {open && alert.threadId && alert.state === "open" ? (
            <RunWithoutSandboxButton threadId={alert.threadId} />
          ) : null}
        </div>
      </DisclosureRegion>
    </div>
  );
}

function AlertFeed() {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const alerts = useQuery(aegisAlertsQueryOptions(showResolved));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const sorted = sortAlertsByRisk(alerts.data?.alerts ?? []);
  const openIds = sorted.filter((alert) => alert.state === "open").map((alert) => alert.id);
  const resolve = useMutation({
    mutationFn: (decision: "allow" | "deny" | "note") =>
      ensureLocalNativeApi().aegis.resolve({ ids: [...selected], decision }),
    onSuccess: () => {
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: flowQueryKeys.all });
    },
    onError: failure("Could not resolve the alerts"),
  });
  return (
    <section aria-label="Alerts" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg font-medium">Alerts</h2>
        <Button
          size="xs"
          variant="ghost"
          disabled={openIds.length === 0}
          onClick={() =>
            setSelected(selected.size === openIds.length ? new Set() : new Set(openIds))
          }
        >
          {selected.size > 0 && selected.size === openIds.length ? "Clear" : "Select all open"}
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {(["allow", "deny", "note"] as const).map((decision) => (
            <Button
              key={decision}
              size="xs"
              variant={decision === "allow" ? "default" : "ghost"}
              disabled={selected.size === 0 || resolve.isPending}
              onClick={() => resolve.mutate(decision)}
            >
              {decision === "allow" ? "Approve" : decision === "deny" ? "Deny" : "Dismiss"}
              {selected.size > 0 ? ` ${selected.size}` : ""}
            </Button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <Switch
          checked={showResolved}
          onCheckedChange={(checked) => setShowResolved(Boolean(checked))}
        />
        Show resolved
      </label>
      {sorted.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No alerts</EmptyTitle>
            <EmptyDescription>Saint raises one when an agent crosses a hard rule.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div role="list" aria-label="Alert feed" className="flex flex-col gap-0.5">
          {sorted.map((alert) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              selected={selected.has(alert.id)}
              onSelect={(value) => {
                const next = new Set(selected);
                if (value) next.add(alert.id);
                else next.delete(alert.id);
                setSelected(next);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AutonomyLadder({ status }: { status: AegisStatus }) {
  const update = useAegisUpdate("Could not change the autonomy level");
  const current = status.settings.autonomy;
  const currentDetail = AUTONOMY_LEVELS.find((entry) => entry.level === current)?.detail;
  return (
    <section aria-label="Autonomy" className="flex flex-col gap-2">
      <h2 className="text-ui-lg font-medium">Autonomy</h2>
      <ButtonGroup label="Autonomy level" className="flex-wrap [&_button]:!w-auto [&_button]:px-3">
        {AUTONOMY_LEVELS.map((entry) => {
          const lock = status.locked[entry.level];
          return (
            <Button
              key={entry.level}
              size="xs"
              variant="ghost"
              aria-pressed={entry.level === current}
              disabled={Boolean(lock) || update.isPending}
              title={lock ?? entry.detail}
              className={cn(entry.level === current && BUTTON_GROUP_ACTIVE_CLASS_NAME)}
              onClick={() => update.mutate({ autonomy: entry.level })}
            >
              {entry.level} {entry.label}
            </Button>
          );
        })}
      </ButtonGroup>
      <p className="text-ui-sm text-muted-foreground">{currentDetail}</p>
      <label className="flex items-center gap-2 text-ui-sm text-muted-foreground">
        <Switch
          checked={status.settings.unattendedSignedOffBy !== null}
          onCheckedChange={(checked) => update.mutate({ signOffUnattended: Boolean(checked) })}
        />
        Tech lead sign-off for unattended runs (L3)
      </label>
    </section>
  );
}

function ProtectionLayers({ status }: { status: AegisStatus }) {
  return (
    <section aria-label="Protection layers" className="flex flex-col gap-1">
      <h2 className="text-ui-lg font-medium">Protection layers</h2>
      <div role="list" className="flex flex-col gap-0.5">
        {status.layers.map((layer) => (
          <div key={layer.id} role="listitem" className="flex min-w-0 items-center gap-3 px-2 py-1">
            <StatusDot
              className={
                layer.enabled
                  ? "bg-success"
                  : layer.available
                    ? "bg-muted-foreground"
                    : "bg-destructive"
              }
              aria-hidden
            />
            <span className="w-40 shrink-0 text-ui">{LAYER_LABEL[layer.id]}</span>
            <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground">
              {layer.enabled ? "On · " : layer.available ? "Off · " : "Unavailable · "}
              {layer.detail}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PolicyEditor({ status }: { status: AegisStatus }) {
  const { policy } = status.settings;
  const initial = {
    cedar: policy.cedar,
    protectedZones: policy.protectedZones.join("\n"),
    egressAllowlist: policy.egressAllowlist.join("\n"),
    egressDenylist: policy.egressDenylist.join("\n"),
  };
  const [draft, setDraft] = useState<typeof initial | null>(null);
  const shown = draft ?? initial;
  const save = useAegisUpdate("Could not save the policy", () => setDraft(null));
  const field = (key: keyof typeof initial, label: string, rows: number, hint: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-ui-sm text-muted-foreground">{label}</span>
      <Textarea
        aria-label={label}
        value={shown[key]}
        spellCheck={false}
        rows={rows}
        placeholder={hint}
        onChange={(event) => setDraft({ ...shown, [key]: event.target.value })}
        className="font-mono text-ui-sm"
      />
    </label>
  );
  return (
    <section aria-label="Policy" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-ui-lg font-medium">Policy</h2>
        {draft ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <Button
              size="xs"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({
                  policy: {
                    cedar: draft.cedar,
                    protectedZones: lines(draft.protectedZones),
                    egressAllowlist: lines(draft.egressAllowlist),
                    egressDenylist: lines(draft.egressDenylist),
                  },
                })
              }
            >
              Save policy
            </Button>
          </>
        ) : null}
      </div>
      {field(
        "cedar",
        "Cedar policies",
        8,
        'forbid (principal, action == Saint::Action::"egress", resource == Saint::Host::"example.com");',
      )}
      {field("protectedZones", "Protected zones (one glob per line)", 3, "tests/**")}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field("egressAllowlist", "Allowed hosts (one per line)", 3, "api.github.com")}
        {field("egressDenylist", "Denied hosts (one per line)", 3, "*.pastebin.com")}
      </div>
    </section>
  );
}

function FrozenWorktrees({ status }: { status: AegisStatus }) {
  const queryClient = useQueryClient();
  const unfreeze = useMutation({
    mutationFn: (id: string) => ensureLocalNativeApi().aegis.unfreeze({ id }),
    onSuccess: (next) => queryClient.setQueryData(flowQueryKeys.aegisStatus, next),
    onError: failure("Could not unfreeze the worktree"),
  });
  if (status.frozen.length === 0) return null;
  return (
    <section aria-label="Frozen worktrees" className="flex flex-col gap-1">
      <h2 className="text-ui-lg font-medium">Frozen worktrees</h2>
      <p className="text-ui-sm text-muted-foreground">
        The kill switch made these read-only. Unfreeze once you have checked what the agent did.
      </p>
      <div role="list" className="flex flex-col gap-0.5">
        {status.frozen.map((worktree) => (
          <div
            key={worktree.id}
            role="listitem"
            className="flex min-w-0 items-center gap-3 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-ui-sm" title={worktree.path}>
              {worktree.path}
            </span>
            <span className="shrink-0 text-ui-sm text-muted-foreground">
              {worktree.files} files · {formatRelativeTime(worktree.frozenAt)}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={unfreeze.isPending}
              onClick={() => unfreeze.mutate(worktree.id)}
            >
              Unfreeze
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function UnsandboxedChats({ status }: { status: AegisStatus }) {
  const titles = useStore((state) => state.sidebarThreadSummaryById);
  const update = useAegisUpdate("Could not change the sandbox");
  if (status.settings.unsandboxedThreads.length === 0) return null;
  return (
    <section aria-label="Chats without sandbox" className="flex flex-col gap-1">
      <h2 className="text-ui-lg font-medium text-warning">Running without sandbox</h2>
      <div role="list" className="flex flex-col gap-0.5">
        {status.settings.unsandboxedThreads.map((threadId) => (
          <label
            key={threadId}
            role="listitem"
            className="flex min-w-0 items-center gap-3 px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-ui">
              {titles[threadId]?.title ?? threadId}
            </span>
            <span className="text-ui-sm text-muted-foreground">Sandbox</span>
            <Switch
              checked={false}
              disabled={update.isPending}
              aria-label="Turn the sandbox back on"
              onCheckedChange={() =>
                update.mutate({ runWithoutSandbox: { threadId, enabled: false } })
              }
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function AuditChain() {
  const verify = useQuery(ledgerVerifyQueryOptions());
  const exportLedger = useMutation({
    mutationFn: () => ensureLocalNativeApi().ledger.export({}),
    onSuccess: ({ jsonl }) =>
      downloadBlob(
        new Blob([jsonl], { type: "application/x-ndjson" }),
        `saint-ledger-${new Date().toISOString().slice(0, 10)}.jsonl`,
      ),
    onError: failure("Could not export the ledger"),
  });
  const result = verify.data;
  return (
    <section aria-label="Audit chain" className="flex items-center gap-3">
      <h2 className="text-ui-lg font-medium">Audit chain</h2>
      {result ? (
        <StatusChip className={result.intact ? "text-success" : "text-destructive"}>
          {result.intact
            ? `intact · ${result.count} events`
            : `broken at #${result.brokenAtSeq} · ${result.count} events`}
        </StatusChip>
      ) : (
        <span className="text-ui-sm text-muted-foreground">Checking…</span>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="ml-auto"
        disabled={exportLedger.isPending}
        onClick={() => exportLedger.mutate()}
      >
        Export
      </Button>
    </section>
  );
}

export function SecurityView() {
  const status = useQuery(aegisStatusQueryOptions());
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          {status.data ? (
            <StatusChip
              className={cn(
                "ml-auto",
                status.data.openAlerts > 0 ? "text-warning" : "text-success",
              )}
            >
              {status.data.openAlerts} open
            </StatusChip>
          ) : null}
        </RouteSurfaceHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-7 px-6 pt-10 pb-20">
            <header className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Security</h1>
              <p className="text-ui text-muted-foreground">
                What agents may do on their own, what stopped them, and the signed record of it.
              </p>
            </header>
            <AlertFeed />
            {status.data ? (
              <>
                <AutonomyLadder status={status.data} />
                <ProtectionLayers status={status.data} />
                <FrozenWorktrees status={status.data} />
                <UnsandboxedChats status={status.data} />
                <PolicyEditor status={status.data} />
              </>
            ) : null}
            <AuditChain />
          </div>
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
