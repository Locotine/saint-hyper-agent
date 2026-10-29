// FILE: FlowCanvas.tsx
// Purpose: The flow DAG drawn as cards over SVG edges. In edit mode a node drags to move, its
//          right handle drags onto another node to connect them, and a click selects a node or
//          an edge for the inspector. Run state colours nodes and marks live/done/hold edges.
// Layer: Web flow view
// Exports: FlowCanvas, FLOW_NODE_STATUS_LABEL, flowNodeStatusClassName

import type { FlowNodeRun, FlowNodeStatus, FlowSpec } from "@saint/contracts";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { StatusChip } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "../chat/composerPickerStyles";
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  edgeKey,
  flowEdgeState,
  layoutFlow,
  type FlowEdgeState,
  type FlowPoint,
} from "./flowCanvas.logic";

export const FLOW_NODE_STATUS_LABEL: Record<FlowNodeStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  gating: "Checking",
  settled: "Done",
  failed: "Failed",
  blocked: "Blocked",
  needs_you: "Needs you",
};

export function flowNodeStatusClassName(status: FlowNodeStatus | undefined): string {
  switch (status) {
    case "running":
    case "gating":
      return "text-info-foreground";
    case "settled":
      return "text-success";
    case "failed":
      return "text-destructive";
    case "needs_you":
    case "blocked":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

const EDGE_CLASS_NAME: Record<FlowEdgeState, string> = {
  idle: "stroke-border",
  live: "stroke-info motion-safe:animate-pulse",
  done: "stroke-success",
  hold: "stroke-warning [stroke-dasharray:6_4]",
};

export type FlowCanvasSelection =
  | { readonly kind: "node"; readonly id: string }
  | { readonly kind: "edge"; readonly id: string }
  | null;

type Drag =
  | { kind: "move"; nodeId: string; origin: FlowPoint; start: FlowPoint }
  | { kind: "connect"; from: string; pointer: FlowPoint };

export function FlowCanvas({
  spec,
  nodeRuns,
  approvedEdges,
  editable,
  selection,
  onSelect,
  onConnect,
}: {
  spec: FlowSpec;
  nodeRuns: ReadonlyMap<string, FlowNodeRun>;
  approvedEdges: ReadonlySet<string>;
  editable: boolean;
  selection: FlowCanvasSelection;
  onSelect: (selection: FlowCanvasSelection) => void;
  onConnect: (from: string, to: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  // ponytail: dragged positions live only in this view; persist them in the spec if people ask.
  const [moved, setMoved] = useState<ReadonlyMap<string, FlowPoint>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const layout = useMemo(() => layoutFlow(spec, moved), [spec, moved]);

  const toCanvas = (event: ReactPointerEvent): FlowPoint => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!drag) return;
    const point = toCanvas(event);
    if (drag.kind === "connect") {
      setDrag({ ...drag, pointer: point });
      return;
    }
    const next = {
      x: Math.max(0, drag.origin.x + point.x - drag.start.x),
      y: Math.max(0, drag.origin.y + point.y - drag.start.y),
    };
    setMoved((current) => new Map(current).set(drag.nodeId, next));
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (drag?.kind === "connect") {
      const target = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-flow-node-id]"))
        .find((element) => element !== null);
      const to = target?.dataset.flowNodeId;
      if (to && to !== drag.from) onConnect(drag.from, to);
    }
    setDrag(null);
  };

  const anchor = (id: string, side: "in" | "out") => {
    const point = layout.positions.get(id) ?? { x: 0, y: 0 };
    return {
      x: point.x + (side === "out" ? FLOW_NODE_WIDTH : 0),
      y: point.y + FLOW_NODE_HEIGHT / 2,
    };
  };
  const curve = (from: FlowPoint, to: FlowPoint) => {
    const bend = Math.max(32, Math.abs(to.x - from.x) / 2);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="flow-canvas">
      <div
        ref={surfaceRef}
        className="relative touch-none select-none"
        style={{ width: layout.width + FLOW_NODE_WIDTH, height: layout.height + FLOW_NODE_HEIGHT }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setDrag(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) onSelect(null);
        }}
      >
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          {spec.edges.map((edge) => {
            const key = edgeKey(edge);
            const state = flowEdgeState(edge, nodeRuns, approvedEdges);
            const selected = selection?.kind === "edge" && selection.id === key;
            const path = curve(anchor(edge.from, "out"), anchor(edge.to, "in"));
            return (
              <g key={key} data-edge-state={state}>
                <path
                  d={path}
                  fill="none"
                  strokeWidth={selected ? 3 : 2}
                  className={cn(
                    EDGE_CLASS_NAME[state],
                    edge.policy === "hold" && "[stroke-dasharray:6_4]",
                  )}
                />
                {/* Wide transparent twin so the thin edge is easy to click. */}
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  className="pointer-events-auto cursor-pointer"
                  aria-label={`Edge ${edge.from} to ${edge.to}`}
                  onClick={() => onSelect({ kind: "edge", id: key })}
                />
              </g>
            );
          })}
          {drag?.kind === "connect" ? (
            <path
              d={curve(anchor(drag.from, "out"), drag.pointer)}
              fill="none"
              strokeWidth={2}
              className="stroke-info [stroke-dasharray:4_4]"
            />
          ) : null}
        </svg>
        {spec.nodes.map((node) => {
          const point = layout.positions.get(node.id) ?? { x: 0, y: 0 };
          const run = nodeRuns.get(node.id);
          const selected = selection?.kind === "node" && selection.id === node.id;
          const live = run?.status === "running" || run?.status === "gating";
          return (
            <div
              key={node.id}
              data-flow-node-id={node.id}
              className="absolute"
              style={{
                left: point.x,
                top: point.y,
                width: FLOW_NODE_WIDTH,
                height: FLOW_NODE_HEIGHT,
              }}
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect({ kind: "node", id: node.id })}
                onPointerDown={(event) => {
                  if (!editable || event.button !== 0) return;
                  setDrag({ kind: "move", nodeId: node.id, origin: point, start: toCanvas(event) });
                }}
                className={cn(
                  "flex size-full cursor-pointer flex-col justify-center gap-1 rounded-lg bg-card/70 px-3 text-left transition-colors",
                  RAISED_SURFACE_CHROME_CLASS_NAME,
                  GLASS_RAISED_SURFACE_CLASS_NAME,
                  "dark:border dark:border-white/[0.05] hover:bg-card focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                  selected && "ring-2 ring-ring",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
                    {node.role}
                  </span>
                  {node.gate ? (
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full border",
                        run?.lastGate
                          ? run.lastGate.passed
                            ? "border-success bg-success"
                            : "border-destructive bg-destructive"
                          : "border-muted-foreground",
                      )}
                      title={`Gate: ${node.gate.cmd}`}
                    />
                  ) : null}
                </span>
                <StatusChip
                  pulse={live}
                  className={cn("text-ui-xs", flowNodeStatusClassName(run?.status))}
                >
                  <span className="truncate">
                    {node.id}
                    {run ? ` · ${FLOW_NODE_STATUS_LABEL[run.status]}` : ""}
                  </span>
                </StatusChip>
              </button>
              {editable ? (
                <span
                  role="presentation"
                  title="Drag onto another step to connect"
                  className="absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 cursor-crosshair rounded-full border border-border bg-background hover:bg-info"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    setDrag({ kind: "connect", from: node.id, pointer: toCanvas(event) });
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
