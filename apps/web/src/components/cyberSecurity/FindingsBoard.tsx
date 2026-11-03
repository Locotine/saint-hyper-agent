// FILE: FindingsBoard.tsx
// Purpose: The Cyber Security dashboard: findings on a four-column board (Open, Triaging, Fixing,
//          Resolved). Drag a card to change its status; open a card for the problem and a Fix
//          button that starts a chat.
// Layer: Web cyber security view
// Exports: FindingsBoard

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { CyberFinding, CyberFindingStatus, CyberSeverity } from "@saint/contracts";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SEVERITY_TONE } from "~/components/security/security.logic";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { StatusDot } from "~/components/ui/status-chip";
import { DISCLOSURE_TRANSITION_MS } from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "../chat/composerPickerStyles";
import { FINDING_COLUMNS, groupFindings, sourceLabel } from "./cyberSecurity.logic";

const DROP_PREFIX = "finding-column|";

const DOT_TONE: Record<CyberSeverity, string> = {
  critical: "bg-destructive",
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-muted-foreground/60",
};

// Cards that change column by themselves (Fix, Fix all, or a finished fix chat) glide there from
// where they were, like a drag. A drag already ends where the card was dropped, so it is skipped.
const FLIGHT_STAGGER_MS = 40;

function useCardFlight(findings: ReadonlyArray<CyberFinding>) {
  const elements = useRef(new Map<string, HTMLElement>());
  const previous = useRef(new Map<string, { rect: DOMRect; status: CyberFindingStatus }>());
  const skipFlight = useRef(new Set<string>());
  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else elements.current.delete(id);
  }, []);

  useLayoutEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, { rect: DOMRect; status: CyberFindingStatus }>();
    let flown = 0;
    for (const finding of findings) {
      const element = elements.current.get(finding.id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      next.set(finding.id, { rect, status: finding.status });
      const before = previous.current.get(finding.id);
      if (!before || before.status === finding.status) continue;
      if (skipFlight.current.delete(finding.id) || reduceMotion) continue;
      const dx = before.rect.left - rect.left;
      const dy = before.rect.top - rect.top;
      element.style.position = "relative";
      element.style.zIndex = "20";
      const flight = element.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        {
          duration: DISCLOSURE_TRANSITION_MS,
          delay: flown * FLIGHT_STAGGER_MS,
          easing: "ease-out",
          fill: "backwards",
        },
      );
      flown += 1;
      const settle = () => {
        element.style.position = "";
        element.style.zIndex = "";
      };
      flight.addEventListener("finish", settle);
      flight.addEventListener("cancel", settle);
    }
    previous.current = next;
  });

  return { register, skipFlight };
}

const location = (finding: CyberFinding) =>
  finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ""}` : null;

function FindingCardBody({
  finding,
  open,
  onToggle,
  onFix,
  fixing,
  overlay = false,
  dragSource = false,
}: {
  finding: CyberFinding;
  open: boolean;
  onToggle?: () => void;
  onFix?: () => void;
  fixing?: boolean;
  overlay?: boolean;
  dragSource?: boolean;
}) {
  const where = location(finding);
  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg bg-card/70 px-3 py-2.5 text-left transition-colors",
        RAISED_SURFACE_CHROME_CLASS_NAME,
        "dark:border dark:border-white/[0.05]",
        overlay ? "bg-card shadow-lg dark:shadow-lg" : GLASS_RAISED_SURFACE_CLASS_NAME,
        dragSource && "opacity-40",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex min-w-0 items-start gap-1.5 text-left focus-visible:outline-none"
        onClick={onToggle}
      >
        <StatusDot className={cn("mt-1.5", DOT_TONE[finding.severity])} aria-hidden />
        <span className="min-w-0 flex-1 text-ui leading-snug font-medium text-foreground/90">
          {finding.title}
        </span>
        <DisclosureChevron open={open} className="mt-1 shrink-0 text-muted-foreground" />
      </button>
      <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
        <span className={SEVERITY_TONE[finding.severity]}>{finding.severity}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{finding.category}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0 truncate" title={`Found by ${sourceLabel(finding.source)}`}>
          {sourceLabel(finding.source)}
        </span>
      </span>
      {where ? (
        <span className="truncate font-mono text-ui-xs text-muted-foreground/80" title={where}>
          {where}
        </span>
      ) : null}
      <DisclosureRegion open={open}>
        <div className="flex flex-col gap-2 pt-1">
          {finding.detail ? <p className="text-ui-sm text-foreground">{finding.detail}</p> : null}
          {finding.fix ? (
            <p className="text-ui-sm text-muted-foreground">Fix: {finding.fix}</p>
          ) : null}
          {onFix && finding.status !== "resolved" ? (
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={fixing}
              onClick={onFix}
            >
              Fix
            </Button>
          ) : null}
        </div>
      </DisclosureRegion>
    </div>
  );
}

function DraggableFinding({
  finding,
  onFix,
  fixing,
  register,
}: {
  finding: CyberFinding;
  onFix: (finding: CyberFinding) => void;
  fixing: boolean;
  register: (id: string, element: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: finding.id });
  return (
    <li
      ref={(element) => {
        setNodeRef(element);
        register(finding.id, element);
      }}
      className="list-none"
      {...attributes}
      {...listeners}
    >
      <FindingCardBody
        finding={finding}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        onFix={() => onFix(finding)}
        fixing={fixing}
        dragSource={isDragging}
      />
    </li>
  );
}

function BoardColumn({
  status,
  label,
  findings,
  onFix,
  fixing,
  register,
}: {
  status: CyberFindingStatus;
  label: string;
  findings: ReadonlyArray<CyberFinding>;
  onFix: (finding: CyberFinding) => void;
  fixing: boolean;
  register: (id: string, element: HTMLElement | null) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `${DROP_PREFIX}${status}` });
  return (
    <section className="flex min-h-0 min-w-64 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-1.5 pb-2">
        <h3 className="text-ui-lg font-medium text-foreground/90">{label}</h3>
        <span className="text-ui leading-snug text-muted-foreground/70">{findings.length}</span>
      </header>
      <ul
        ref={setNodeRef}
        className={cn(
          "flex min-h-24 flex-1 flex-col gap-2 rounded-xl p-1 transition-colors",
          isOver && "bg-info/8 ring-1 ring-info/30 ring-inset",
        )}
      >
        {findings.map((finding) => (
          <DraggableFinding
            key={finding.id}
            finding={finding}
            onFix={onFix}
            fixing={fixing}
            register={register}
          />
        ))}
        {findings.length === 0 ? (
          <li className="list-none rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-ui leading-snug text-muted-foreground/60">
            No findings
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function FindingsBoardComponent({
  findings,
  severityFilter,
  onMove,
  onFix,
  fixing,
}: {
  findings: ReadonlyArray<CyberFinding>;
  severityFilter: CyberSeverity | "all";
  onMove: (finding: CyberFinding, status: CyberFindingStatus) => void;
  onFix: (finding: CyberFinding) => void;
  fixing: boolean;
}) {
  const columns = useMemo(
    () => groupFindings(findings, severityFilter),
    [findings, severityFilter],
  );
  const [active, setActive] = useState<CyberFinding | null>(null);
  const { register, skipFlight } = useCardFlight(findings);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragStart = (event: DragStartEvent) =>
    setActive(findings.find((finding) => finding.id === event.active.id) ?? null);
  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    const overId = event.over ? String(event.over.id) : "";
    const finding = findings.find((entry) => entry.id === event.active.id);
    if (!finding || !overId.startsWith(DROP_PREFIX)) return;
    const status = overId.slice(DROP_PREFIX.length) as CyberFindingStatus;
    if (status !== finding.status) {
      skipFlight.current.add(finding.id);
      onMove(finding, status);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-2">
        {FINDING_COLUMNS.map((column) => (
          <BoardColumn
            key={column.status}
            status={column.status}
            label={column.label}
            findings={columns[column.status]}
            onFix={onFix}
            fixing={fixing}
            register={register}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {active ? <FindingCardBody finding={active} open={false} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

export const FindingsBoard = memo(FindingsBoardComponent);
