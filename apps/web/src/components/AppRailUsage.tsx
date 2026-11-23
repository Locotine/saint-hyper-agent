// FILE: AppRailUsage.tsx
// Purpose: Provider usage rings at the bottom of the app rail, above Help: the provider glyph inside a
//          remaining-quota ring, a hover card with every limit, click opens Settings → Usage.
// Layer: App shell component
// Depends on: the shared provider-usage menu model and panel content, so the rail reads the
//             same numbers as the chat header chip, the Environment panel, and Settings.

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@saint/contracts";
import { deriveProviderInstances } from "@saint/shared/providerInstances";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type MouseEvent } from "react";

import { useAppSettings, type RailUsageWindow } from "~/appSettings";
import { useViewedHostId } from "~/hosts/viewedHost";
import { CustomizeIcon } from "~/lib/icons";
import { isHostUsageHidden } from "~/lib/providerUsageSnapshot";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
} from "~/sidebarRowStyles";

import { appRailButtonClassName } from "./AppRail";
import {
  RAIL_USAGE_WINDOW_OPTIONS,
  areAllRailUsageAccountsSelected,
  railUsageRingTone,
  getRailUsageAccounts,
  resolveRailUsageAccounts,
  selectRailUsageRows,
  toggleRailUsageAccount,
  type RailUsageAccount,
  type RailUsageRingTone,
} from "./AppRailUsage.logic";
import { resolveEnvironmentProviderUsageSummary } from "./chat/environment/EnvironmentUsageSection.logic";
import { ProviderAccountAvatar, ProviderAccountDot } from "./ProviderAccountMark";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderUsageMenuModel } from "./ProviderUsageMenuControl";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import { SettingsSegmentedControl } from "./settings/SettingControls";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { StatusChip } from "./ui/status-chip";
import { Switch } from "./ui/switch";

// Every ring uses the same scale, so its colour alone says how much is left.
const RING_TONE_CLASS_NAME: Record<RailUsageRingTone, { stroke: string; dot: string }> = {
  healthy: { stroke: "stroke-emerald-500", dot: "bg-emerald-500" },
  fair: { stroke: "stroke-yellow-500", dot: "bg-yellow-500" },
  low: { stroke: "stroke-orange-500", dot: "bg-orange-500" },
  critical: { stroke: "stroke-red-500", dot: "bg-red-500" },
};

// Geometry in px inside the rail's 36px button. Two tracks take a larger box, thinner
// strokes and a smaller glyph, so the tracks keep a 2.25px gap and the glyph clears the
// inner one.
const SINGLE_RING = { size: 28, stroke: 2.5, svgClassName: "size-7", iconClassName: "size-3.5" };
const DOUBLE_RING = { size: 34, stroke: 2.25, svgClassName: "size-8.5", iconClassName: "size-3" };
const RING_SPACING = 4.5;

function AppRailUsageRing({
  account,
  snapshot,
  window,
  onOpenUsageSettings,
  onOpenCustomize,
}: {
  account: RailUsageAccount;
  snapshot: ServerProviderUsageSnapshot | undefined;
  window: RailUsageWindow;
  onOpenUsageSettings: () => void;
  onOpenCustomize?: () => void;
}) {
  const { instance, label } = account;
  const provider = instance.driver;
  const model = useProviderUsageMenuModel(provider, {
    instanceId: instance.instanceId,
    providerSnapshot: snapshot ?? null,
  });

  // A failed fetch keeps a dimmed, empty ring (its card says why) so a chosen provider does
  // not vanish on a network blip. Otherwise nothing displayable (still loading, signed out,
  // or no usage source) means no ring.
  const unavailable = snapshot?.status === "error";
  if (!unavailable && model.rows.length === 0 && model.usageLines.length === 0) {
    return null;
  }

  const summary = resolveEnvironmentProviderUsageSummary({
    providerName: label,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });
  const rings = selectRailUsageRows(model.rows, model.primaryRow, window).map((row) => ({
    row,
    tone: RING_TONE_CLASS_NAME[railUsageRingTone(row.remainingPercent)],
  }));
  const ring = rings.length > 1 ? DOUBLE_RING : SINGLE_RING;
  const outerRadius = (ring.size - ring.stroke) / 2;

  return (
    <PreviewCard>
      <PreviewCardTrigger
        {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
        render={
          <button
            type="button"
            aria-label={`${summary.ariaLabel}. Open usage settings`}
            className={cn(
              appRailButtonClassName(false),
              "relative flex shrink-0 items-center justify-center",
            )}
            onClick={onOpenUsageSettings}
            onContextMenu={
              onOpenCustomize
                ? (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenCustomize();
                  }
                : undefined
            }
          />
        }
      >
        <svg
          viewBox={`0 0 ${ring.size} ${ring.size}`}
          className={cn("-rotate-90", ring.svgClassName)}
          fill="none"
          aria-hidden
        >
          {rings.length === 0 ? (
            <circle
              cx={ring.size / 2}
              cy={ring.size / 2}
              r={outerRadius}
              strokeWidth={ring.stroke}
              className="stroke-current opacity-15"
            />
          ) : null}
          {rings.map(({ row, tone }, index) => (
            <g key={row.id}>
              <circle
                cx={ring.size / 2}
                cy={ring.size / 2}
                r={outerRadius - index * RING_SPACING}
                strokeWidth={ring.stroke}
                className="stroke-current opacity-15"
              />
              {row.remainingPercent > 0 ? (
                <circle
                  cx={ring.size / 2}
                  cy={ring.size / 2}
                  r={outerRadius - index * RING_SPACING}
                  strokeWidth={ring.stroke}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={`${row.remainingPercent} 100`}
                  className={cn(
                    "transition-[stroke-dasharray] duration-500 motion-reduce:transition-none",
                    tone.stroke,
                  )}
                />
              ) : null}
            </g>
          ))}
        </svg>
        <span className={cn("absolute flex", ring.iconClassName)}>
          <ProviderIcon
            provider={provider}
            className={cn("size-full", unavailable && "opacity-50")}
          />
          <ProviderAccountDot
            accentColor={instance.raw.accentColor}
            always={account.dotted}
            className="absolute -top-0.5 -right-1 size-1.5 ring-0"
          />
        </span>
      </PreviewCardTrigger>
      <PreviewCardPopup
        {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
        // The rings sit at the rail's foot, so the card grows upward from them.
        align="end"
        sideOffset={6}
        className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
      >
        <div className="space-y-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-ui font-medium text-foreground">{label}</span>
            {snapshot?.planName ? (
              <span className="shrink-0 text-ui-sm text-muted-foreground">{snapshot.planName}</span>
            ) : null}
          </div>
          {rings.length > 1 ? (
            <div className="flex items-center gap-3 text-muted-foreground">
              {rings.map(({ row, tone }, index) => (
                <StatusChip key={row.id} dotClassName={tone.dot}>
                  {row.label} · {index === 0 ? "outer" : "inner"}
                </StatusChip>
              ))}
            </div>
          ) : null}
          <ProviderUsagePanelContent
            provider={provider}
            rateLimits={model.rateLimits}
            usageLines={model.usageLines}
            notice={model.notice}
            emptyMessage={model.emptyMessage}
            isLoading={model.isLoading}
            resetCredits={model.resetCredits}
            resetCreditsSurface="popover"
            showTitle={false}
          />
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function snapshotHasLiveUsage(snapshot: ServerProviderUsageSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.status === "error") return true;
  if ((snapshot.status ?? "ok") !== "ok") return false;
  return snapshot.limits.length > 0 || snapshot.usageLines.length > 0;
}

function accountStatusSublabel(snapshot: ServerProviderUsageSnapshot | undefined): string | null {
  if (!snapshot) return null;
  if (snapshot.status === "needs-auth") return "Not signed in";
  if (snapshot.status === "error") return "Unavailable";
  if (snapshot.status === "unsupported") return "Unsupported";
  if (snapshot.limits.length === 0 && snapshot.usageLines.length === 0) return "No usage data";
  return snapshot.planName ?? null;
}

/** Sits above Help: rings for selected connected accounts plus a quick customize popover. */
export function AppRailUsage({ onOpenUsageSettings }: { onOpenUsageSettings: () => void }) {
  const { settings, updateSettings } = useAppSettings();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const providerInstances = useMemo(
    () =>
      new Map(
        deriveProviderInstances(settingsQuery.data ?? DEFAULT_SERVER_SETTINGS_VIEW).map(
          (instance) => [instance.instanceId, instance],
        ),
      ),
    [settingsQuery.data],
  );
  const availableAccounts = useMemo(
    () => getRailUsageAccounts([...providerInstances.values()], settings.disabledProviders),
    [providerInstances, settings.disabledProviders],
  );
  const effectiveSelection = settings.railUsageInstanceIds ?? settings.railUsageProviders ?? null;
  // Preserve saved disabled-account ids while dropping removed accounts.
  const savedSelection =
    effectiveSelection === null
      ? null
      : effectiveSelection.filter((instanceId) => providerInstances.has(instanceId));
  const accounts = useMemo(
    () => resolveRailUsageAccounts(effectiveSelection, availableAccounts),
    [effectiveSelection, availableAccounts],
  );
  const selectedInstanceIds = useMemo(
    () => new Set(accounts.map((account) => account.instance.instanceId)),
    [accounts],
  );
  const allSelected = areAllRailUsageAccountsSelected(effectiveSelection, availableAccounts);
  const hostId = useViewedHostId();
  const usageQuery = useQuery(
    serverAllProviderUsageQueryOptions({ enabled: availableAccounts.length > 0, hostId }),
  );
  const snapshotByAccountId = useMemo(() => {
    const map = new Map<string, ServerProviderUsageSnapshot>();
    for (const entry of usageQuery.data ?? []) {
      map.set(`${entry.provider}:${entry.instanceId ?? entry.provider}`, entry);
    }
    return map;
  }, [usageQuery.data]);
  const sortedCustomizeAccounts = useMemo(() => {
    const active: RailUsageAccount[] = [];
    const inactive: RailUsageAccount[] = [];
    for (const account of availableAccounts) {
      const snapshot = snapshotByAccountId.get(
        `${account.instance.driver}:${account.instance.instanceId}`,
      );
      if (snapshotHasLiveUsage(snapshot)) {
        active.push(account);
      } else {
        inactive.push(account);
      }
    }
    return [...active, ...inactive];
  }, [availableAccounts, snapshotByAccountId]);

  if (availableAccounts.length === 0) {
    return null;
  }

  const ringNodes = accounts.map((account) => {
    const snapshot = snapshotByAccountId.get(
      `${account.instance.driver}:${account.instance.instanceId}`,
    );
    // Another host's ring appears only once that host answered with this account's usage.
    if (isHostUsageHidden({ hostId, isError: usageQuery.isError, snapshot })) return null;
    return (
      <AppRailUsageRing
        key={account.instance.instanceId}
        account={account}
        snapshot={snapshot}
        window={settings.railUsageWindow}
        onOpenUsageSettings={onOpenUsageSettings}
        onOpenCustomize={() => setCustomizeOpen(true)}
      />
    );
  });
  const hasMultipleRings = accounts.length > 2;

  return (
    <>
      {hasMultipleRings ? (
        <div className="flex max-h-48 flex-col items-center gap-1.5 overflow-y-auto [scrollbar-width:none]">
          {ringNodes}
        </div>
      ) : (
        ringNodes
      )}
      {typeof updateSettings === "function" ? (
        <Popover open={customizeOpen} onOpenChange={setCustomizeOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Customize usage rings"
                title="Customize usage rings"
                className={cn(
                  "inline-flex h-5 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                  customizeOpen
                    ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                    : cn(SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
                )}
              >
                <CustomizeIcon className="size-3.5" aria-hidden="true" />
              </button>
            }
          />
          <PopoverPopup
            side="right"
            align="end"
            sideOffset={8}
            className="w-72 [&_[data-slot=popover-viewport]]:p-2.5"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>Usage rings</span>
                <div className="flex items-center gap-0.5">
                  {!allSelected ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-1.5 text-ui-xs text-primary hover:text-primary"
                      onClick={() =>
                        updateSettings({
                          railUsageInstanceIds: null,
                          railUsageProviders: null,
                        })
                      }
                    >
                      Show all
                    </Button>
                  ) : null}
                  {selectedInstanceIds.size > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-1.5 text-ui-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        updateSettings({
                          railUsageInstanceIds: [],
                          railUsageProviders: null,
                        })
                      }
                    >
                      Hide all
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-1.5 text-ui-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setCustomizeOpen(false);
                      onOpenUsageSettings();
                    }}
                  >
                    Settings
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 border-y border-[color:var(--color-border)] py-2">
                <span className="text-ui-sm text-muted-foreground">Ring</span>
                <SettingsSegmentedControl
                  value={settings.railUsageWindow}
                  onValueChange={(value) => updateSettings({ railUsageWindow: value })}
                  ariaLabel="Sidebar usage ring"
                  options={RAIL_USAGE_WINDOW_OPTIONS}
                />
              </div>
              <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
                {sortedCustomizeAccounts.map((account) => {
                  const snapshot = snapshotByAccountId.get(
                    `${account.instance.driver}:${account.instance.instanceId}`,
                  );
                  const checked = selectedInstanceIds.has(account.instance.instanceId);
                  const statusLabel = accountStatusSublabel(snapshot);
                  return (
                    <div
                      key={account.instance.instanceId}
                      className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderAccountAvatar
                          provider={account.instance.driver}
                          accentColor={account.instance.raw.accentColor}
                          className="size-5 shrink-0"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-ui text-foreground">
                            {account.label}
                          </span>
                          {statusLabel ? (
                            <span className="block truncate text-ui-xs text-muted-foreground">
                              {statusLabel}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <Switch
                        checked={checked}
                        disabled={settingsQuery.isPending}
                        onCheckedChange={(next) =>
                          updateSettings({
                            railUsageInstanceIds: toggleRailUsageAccount(
                              savedSelection,
                              account.instance.instanceId,
                              Boolean(next),
                              availableAccounts,
                            ),
                            railUsageProviders: null,
                          })
                        }
                        aria-label={`Toggle ${account.label} ring in sidebar`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </>
  );
}
