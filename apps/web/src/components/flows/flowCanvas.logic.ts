// FILE: flowCanvas.logic.ts
// Purpose: Pure pieces of the flow Canvas: the layered DAG layout, each edge's live/done/hold
//          state from a run, and the spec edits the Canvas makes (add/remove nodes and edges).
// Layer: Web flow view logic
// Exports: layoutFlow, flowEdgeState, edgeKey, spec edit helpers

import {
  FLOW_NODE_ID_PATTERN,
  type FlowEdgeSpec,
  type FlowNodeRun,
  type FlowNodeSpec,
  type FlowSpec,
} from "@saint/contracts";
import { flowNodeDepths } from "@saint/shared/flowSpec";

export const FLOW_NODE_WIDTH = 200;
export const FLOW_NODE_HEIGHT = 64;
const COLUMN_GAP = 72;
const ROW_GAP = 28;
const PADDING = 24;

export interface FlowPoint {
  readonly x: number;
  readonly y: number;
}

export interface FlowLayout {
  readonly positions: ReadonlyMap<string, FlowPoint>;
  readonly width: number;
  readonly height: number;
}

export const edgeKey = (edge: Pick<FlowEdgeSpec, "from" | "to">) => `${edge.from}->${edge.to}`;

/** Columns by longest-path depth, rows in spec order, each column centred on the tallest one.
 *  A cycle (only possible in an invalid draft) lays every node out in the first column. */
export function layoutFlow(
  spec: Pick<FlowSpec, "nodes" | "edges">,
  overrides: ReadonlyMap<string, FlowPoint> = new Map(),
): FlowLayout {
  const depths = flowNodeDepths(spec as FlowSpec) ?? new Map<string, number>();
  const columns = new Map<number, string[]>();
  for (const node of spec.nodes) {
    const depth = depths.get(node.id) ?? 0;
    columns.set(depth, [...(columns.get(depth) ?? []), node.id]);
  }
  const tallest = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
  const columnHeight = tallest * FLOW_NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const positions = new Map<string, FlowPoint>();
  for (const [depth, ids] of columns) {
    const height = ids.length * FLOW_NODE_HEIGHT + (ids.length - 1) * ROW_GAP;
    const top = PADDING + (columnHeight - height) / 2;
    ids.forEach((id, row) => {
      positions.set(
        id,
        overrides.get(id) ?? {
          x: PADDING + depth * (FLOW_NODE_WIDTH + COLUMN_GAP),
          y: top + row * (FLOW_NODE_HEIGHT + ROW_GAP),
        },
      );
    });
  }
  let width = 0;
  let height = 0;
  for (const point of positions.values()) {
    width = Math.max(width, point.x + FLOW_NODE_WIDTH + PADDING);
    height = Math.max(height, point.y + FLOW_NODE_HEIGHT + PADDING);
  }
  return { positions, width, height };
}

export type FlowEdgeState = "idle" | "live" | "done" | "hold";

/** live: the upstream step settled and the downstream one is working · hold: waits for approval ·
 *  done: the downstream step settled. */
export function flowEdgeState(
  edge: FlowEdgeSpec,
  nodes: ReadonlyMap<string, FlowNodeRun>,
  approvedEdges: ReadonlySet<string>,
): FlowEdgeState {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  if (!from || !to || from.status !== "settled") return "idle";
  if (to.status === "settled") return "done";
  if (to.status === "running" || to.status === "gating") return "live";
  if (edge.policy === "hold" && !approvedEdges.has(edgeKey(edge))) return "hold";
  return "idle";
}

/** The next free `step-N` id. */
export function nextNodeId(spec: Pick<FlowSpec, "nodes">): string {
  const ids = new Set(spec.nodes.map((node) => node.id));
  let index = spec.nodes.length + 1;
  while (ids.has(`step-${index}`)) index += 1;
  return `step-${index}`;
}

export function addFlowNode(spec: FlowSpec): { spec: FlowSpec; nodeId: string } {
  const nodeId = nextNodeId(spec);
  const node: FlowNodeSpec = { id: nodeId, role: "Agent", prompt: "Describe this step." };
  return { spec: { ...spec, nodes: [...spec.nodes, node] }, nodeId };
}

export function removeFlowNode(spec: FlowSpec, nodeId: string): FlowSpec {
  return {
    ...spec,
    nodes: spec.nodes.filter((node) => node.id !== nodeId),
    edges: spec.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  };
}

/** Adds `from → to` unless it is a self edge, a duplicate, or would close a cycle. */
export function connectFlowNodes(spec: FlowSpec, from: string, to: string): FlowSpec | null {
  if (from === to || spec.edges.some((edge) => edge.from === from && edge.to === to)) return null;
  const next = { ...spec, edges: [...spec.edges, { from, to }] };
  return flowNodeDepths(next) === null ? null : next;
}

export function removeFlowEdge(spec: FlowSpec, key: string): FlowSpec {
  return { ...spec, edges: spec.edges.filter((edge) => edgeKey(edge) !== key) };
}

export function updateFlowEdge(
  spec: FlowSpec,
  key: string,
  patch: Partial<FlowEdgeSpec>,
): FlowSpec {
  return {
    ...spec,
    edges: spec.edges.map((edge) => (edgeKey(edge) === key ? { ...edge, ...patch } : edge)),
  };
}

/** Renaming a node also rewrites its edges; an invalid or taken id is refused. */
export function updateFlowNode(
  spec: FlowSpec,
  nodeId: string,
  patch: Partial<FlowNodeSpec>,
): FlowSpec | null {
  const nextId = patch.id ?? nodeId;
  if (nextId !== nodeId) {
    if (!FLOW_NODE_ID_PATTERN.test(nextId) || spec.nodes.some((node) => node.id === nextId)) {
      return null;
    }
  }
  const rename = (id: string) => (id === nodeId ? nextId : id);
  return {
    ...spec,
    nodes: spec.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    edges: spec.edges.map((edge) => ({ ...edge, from: rename(edge.from), to: rename(edge.to) })),
  };
}

/** A two-step starter for a blank Canvas. */
export function blankFlowSpec(): FlowSpec {
  return {
    version: "flow-v1",
    name: "New flow",
    nodes: [
      { id: "plan", role: "Planner", prompt: "Plan the change and hand off the steps." },
      { id: "build", role: "Builder", prompt: "Implement the plan from the handoff." },
    ],
    edges: [{ from: "plan", to: "build" }],
  };
}
