// FILE: flowAttention.logic.ts
// Purpose: What in the running flows waits for a person — held steps and held hand-offs —
//          ranked riskiest first so a batch approval starts with what matters most.
// Layer: Web flow view logic
// Exports: collectFlowAttention, FlowAttentionItem

import type { FlowActionInput, FlowRunView } from "@saint/contracts";

import { edgeKey } from "./flowCanvas.logic";

export interface FlowAttentionItem {
  readonly key: string;
  readonly flowId: FlowRunView["run"]["id"];
  readonly projectId: FlowRunView["run"]["projectId"];
  readonly flowName: string;
  readonly title: string;
  readonly detail: string | null;
  /** 0 is the riskiest. */
  readonly risk: number;
  /** The flow.action that approves it. */
  readonly approve: Omit<FlowActionInput, "flowId">;
}

/** Protected-file edits, then failed gates, then other held steps, then held hand-offs. */
export function collectFlowAttention(views: ReadonlyArray<FlowRunView>): FlowAttentionItem[] {
  const items: FlowAttentionItem[] = [];
  for (const { run, nodes, approvedEdges } of views) {
    if (run.status !== "running" && run.status !== "paused") continue;
    const base = { flowId: run.id, projectId: run.projectId, flowName: run.spec.name };
    for (const node of nodes) {
      if (node.status !== "needs_you") continue;
      const gate = node.lastGate ?? null;
      const risk = gate?.protectedEdits.length ? 0 : gate && !gate.passed ? 1 : 2;
      items.push({
        ...base,
        key: `${run.id}:${node.nodeId}`,
        title: `${node.nodeId} needs you`,
        detail: gate?.protectedEdits.length
          ? `Edited protected files: ${gate.protectedEdits.join(", ")}`
          : node.statusReason,
        risk,
        approve: { action: "approveNode", nodeId: node.nodeId },
      });
    }
    const status = new Map(nodes.map((node) => [node.nodeId, node.status]));
    for (const edge of run.spec.edges) {
      const key = edgeKey(edge);
      if (edge.policy !== "hold" || approvedEdges.includes(key)) continue;
      if (status.get(edge.from) !== "settled" || status.get(edge.to) !== "pending") continue;
      items.push({
        ...base,
        key: `${run.id}:${key}`,
        title: `Hand-off ${edge.from} → ${edge.to}`,
        detail: "Waits for your approval.",
        risk: 3,
        approve: { action: "approveEdge", from: edge.from, to: edge.to },
      });
    }
  }
  return items.toSorted((a, b) => a.risk - b.risk || a.key.localeCompare(b.key));
}
