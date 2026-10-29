// FILE: flowDecision.ts
// Purpose: The deterministic scheduler — given a flow snapshot, decide which nodes become ready,
//          which start, which hold edges wait for approval, and whether the flow is finished.
//          Pure: the service persists state and carries the actions out.
// Layer: Server flow domain (pure)

import {
  FLOW_DEFAULT_BREAKER_FAILURES,
  FLOW_DEFAULT_MAX_PARALLEL,
  type FlowNodeRun,
  type FlowRunStatus,
  type FlowSpec,
} from "@saint/contracts";

export interface FlowSnapshot {
  readonly spec: FlowSpec;
  readonly status: FlowRunStatus;
  readonly nodes: ReadonlyArray<Pick<FlowNodeRun, "nodeId" | "status">>;
  /** `from->to` keys of hold edges a person has approved. */
  readonly approvedEdges: ReadonlySet<string>;
  /** Node failures since the last node settled; trips the circuit breaker. */
  readonly consecutiveFailures: number;
}

export type FlowAction =
  | { readonly type: "promote"; readonly nodeId: string }
  | { readonly type: "spawn"; readonly nodeId: string }
  | { readonly type: "await_edge"; readonly from: string; readonly to: string }
  | { readonly type: "complete" }
  | { readonly type: "fail"; readonly reason: string };

export const flowEdgeKey = (from: string, to: string) => `${from}->${to}`;

const ACTIVE = new Set(["running", "gating"]);
const WAITING_ON_PERSON = new Set(["needs_you", "blocked"]);

export function decideFlow(snapshot: FlowSnapshot): ReadonlyArray<FlowAction> {
  if (snapshot.status !== "running") return [];
  const breaker = snapshot.spec.budget?.breakerFailures ?? FLOW_DEFAULT_BREAKER_FAILURES;
  if (snapshot.consecutiveFailures >= breaker) {
    return [
      {
        type: "fail",
        reason: `Circuit breaker: ${snapshot.consecutiveFailures} failures in a row.`,
      },
    ];
  }

  const status = new Map(snapshot.nodes.map((node) => [node.nodeId, node.status]));
  const statusOf = (id: string) => status.get(id) ?? "pending";
  if (snapshot.spec.nodes.every((node) => statusOf(node.id) === "settled")) {
    return [{ type: "complete" }];
  }

  const actions: FlowAction[] = [];
  const ready: string[] = [];
  for (const node of snapshot.spec.nodes) {
    const current = statusOf(node.id);
    if (current === "ready") {
      ready.push(node.id);
      continue;
    }
    if (current !== "pending") continue;
    const incoming = snapshot.spec.edges.filter((edge) => edge.to === node.id);
    if (!incoming.every((edge) => statusOf(edge.from) === "settled")) continue;
    const unapproved = incoming.filter(
      (edge) =>
        edge.policy === "hold" && !snapshot.approvedEdges.has(flowEdgeKey(edge.from, edge.to)),
    );
    if (unapproved.length > 0) {
      for (const edge of unapproved)
        actions.push({ type: "await_edge", from: edge.from, to: edge.to });
      continue;
    }
    actions.push({ type: "promote", nodeId: node.id });
    ready.push(node.id);
  }

  const maxParallel = snapshot.spec.budget?.maxParallel ?? FLOW_DEFAULT_MAX_PARALLEL;
  const active = snapshot.spec.nodes.filter((node) => ACTIVE.has(statusOf(node.id))).length;
  for (const nodeId of ready.slice(0, Math.max(0, maxParallel - active))) {
    actions.push({ type: "spawn", nodeId });
  }

  // Nothing running, startable or waiting on a person: the remaining nodes sit behind a failure.
  const stuck =
    actions.length === 0 &&
    active === 0 &&
    !snapshot.spec.nodes.some((node) => WAITING_ON_PERSON.has(statusOf(node.id)));
  if (stuck) return [{ type: "fail", reason: "No node can run: an upstream node failed." }];
  return actions;
}
