import type { FlowNodeRun, FlowRunView } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { collectFlowAttention } from "./flowAttention.logic";

const node = (nodeId: string, status: FlowNodeRun["status"], extra: Partial<FlowNodeRun> = {}) =>
  ({ nodeId, status, statusReason: null, ...extra }) as FlowNodeRun;

const view = (status: FlowRunView["run"]["status"], nodes: FlowNodeRun[]): FlowRunView =>
  ({
    run: {
      id: "f1",
      projectId: "p1",
      status,
      spec: {
        version: "flow-v1",
        name: "Flow",
        nodes: [],
        edges: [
          { from: "a", to: "b", policy: "hold" },
          { from: "a", to: "c" },
        ],
      },
    },
    nodes,
    approvedEdges: [],
  }) as unknown as FlowRunView;

const gate = (passed: boolean, protectedEdits: string[] = []) =>
  ({ passed, protectedEdits }) as unknown as FlowNodeRun["lastGate"];

describe("collectFlowAttention", () => {
  it("ranks protected edits, failed gates, held steps, then held hand-offs", () => {
    const items = collectFlowAttention([
      view("running", [
        node("a", "settled"),
        node("b", "pending"),
        node("c", "needs_you"),
        node("d", "needs_you", { lastGate: gate(false) }),
        node("e", "needs_you", { lastGate: gate(true, ["src/x.test.ts"]) }),
      ]),
    ]);
    expect(items.map((item) => item.title)).toEqual([
      "e needs you",
      "d needs you",
      "c needs you",
      "Hand-off a → b",
    ]);
    expect(items[0]!.approve).toEqual({ action: "approveNode", nodeId: "e" });
    expect(items[3]!.approve).toEqual({ action: "approveEdge", from: "a", to: "b" });
  });

  it("ignores finished flows and hand-offs whose source has not settled", () => {
    expect(collectFlowAttention([view("completed", [node("c", "needs_you")])])).toEqual([]);
    expect(
      collectFlowAttention([view("running", [node("a", "running"), node("b", "pending")])]),
    ).toEqual([]);
  });
});
