// FILE: OfficeView.tsx
// Purpose: The virtual office page: desk roster and live preview on the left, the office on the right.
// Layer: Web office view (route component for /office-3d)
// Exports: OfficeView

import type { ThreadId } from "@saint/contracts";
import { useNavigate } from "@tanstack/react-router";
import { WindowIcon } from "~/lib/icons";
import { useCallback, useMemo, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { cn } from "~/lib/utils";
import { useStore, type AppState } from "~/store";

import { OfficeCanvas } from "./OfficeCanvas";
import { useOfficeState, type OfficeDeskView } from "./useOfficeState";

const RECENT_ACTIVITY_COUNT = 8;

/** Newest first. Joined into one string so the store selector stays stable between updates. */
function useRecentActivity(
  threadId: ThreadId | null,
): readonly { readonly id: string; readonly summary: string }[] {
  const joined = useStore(
    useCallback(
      (state: AppState) => {
        if (!threadId) return "";
        const ids = state.activityIdsByThreadId?.[threadId] ?? [];
        const byId = state.activityByThreadId?.[threadId];
        return ids
          .slice(-RECENT_ACTIVITY_COUNT)
          .filter((id) => byId?.[id]?.summary)
          .map((id) => `${id}\u0001${byId?.[id]?.summary ?? ""}`)
          .toReversed()
          .join("\u0000");
      },
      [threadId],
    ),
  );
  return useMemo(
    () =>
      joined
        ? joined.split("\u0000").map((entry) => {
            const [id = "", summary = ""] = entry.split("\u0001");
            return { id, summary };
          })
        : [],
    [joined],
  );
}

function DeskRow(props: {
  readonly desk: OfficeDeskView;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { desk } = props;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui hover:bg-accent/60",
        props.selected && "bg-accent",
      )}
    >
      <span className="w-20 shrink-0 truncate text-ui-sm text-muted-foreground">{desk.role}</span>
      {desk.thread ? (
        <>
          <ProviderIcon provider={desk.provider} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-foreground">{desk.thread.title}</span>
          {desk.status ? (
            <span
              className={cn("flex shrink-0 items-center gap-1 text-ui-xs", desk.status.colorClass)}
            >
              <span className={cn("size-1.5 rounded-full", desk.status.dotClass)} />
              {desk.status.label}
            </span>
          ) : null}
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">Free desk</span>
      )}
    </button>
  );
}

export function OfficeView() {
  const navigate = useNavigate();
  const office = useOfficeState();
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const selected = office.desks.find((desk) => desk.thread?.id === selectedThreadId) ?? null;
  const activity = useRecentActivity(selectedThreadId);
  const workingCount = office.desks.filter((desk) => desk.thread && desk.duty !== "idle").length;
  const officeWidget =
    typeof window === "undefined" ? undefined : window.desktopBridge?.officeWidget;

  const engineState = useMemo(
    () => ({ agents: office.agents, selectedThreadId: selected?.thread?.id ?? null }),
    [office.agents, selected],
  );
  const openThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  return (
    <RouteSurface>
      <RouteSurfaceHeader>
        <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
          <h2 className="truncate text-ui-lg font-medium text-foreground">Văn phòng ảo</h2>
          <span className="shrink-0 text-ui leading-snug text-muted-foreground/70">
            {workingCount} busy
          </span>
          <div className="flex-1" />
          {officeWidget ? (
            <Button size="xs" variant="ghost" onClick={() => void officeWidget.toggle()}>
              <WindowIcon />
              Floating office
            </Button>
          ) : null}
        </div>
      </RouteSurfaceHeader>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border/60 p-3">
          <div className="flex flex-col gap-0.5">
            {office.desks.map((desk) => (
              <DeskRow
                key={desk.desk}
                desk={desk}
                selected={desk === selected}
                onSelect={() =>
                  setSelectedThreadId(desk === selected ? null : (desk.thread?.id ?? null))
                }
              />
            ))}
          </div>
          <DisclosureRegion open={selected?.thread != null}>
            {selected?.thread ? (
              <section className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-2">
                  <ProviderIcon provider={selected.provider} className="size-4 shrink-0" />
                  <h3 className="min-w-0 flex-1 truncate text-ui-lg font-medium text-foreground">
                    {selected.thread.title}
                  </h3>
                </div>
                {selected.status ? (
                  <p className={cn("text-ui-sm", selected.status.colorClass)}>
                    {selected.status.label}
                  </p>
                ) : null}
                {activity.length > 0 ? (
                  <ol className="flex flex-col gap-1 text-ui-sm text-muted-foreground">
                    {activity.map((entry) => (
                      <li key={entry.id} className="truncate">
                        {entry.summary}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-ui-sm text-muted-foreground/70">
                    Open the thread to load its activity.
                  </p>
                )}
                <Button size="sm" variant="outline" onClick={() => openThread(selected.thread!.id)}>
                  {selected.duty === "approval" ? "Review approval" : "Open thread"}
                </Button>
              </section>
            ) : null}
          </DisclosureRegion>
        </aside>
        <OfficeCanvas
          className="flex-1 bg-[#f7f7f7] dark:bg-[#1c1c1c]"
          state={engineState}
          onSelect={setSelectedThreadId}
        />
      </div>
    </RouteSurface>
  );
}
