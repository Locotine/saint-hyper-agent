import type { FlowNodeStatus, FlowSpec } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { decideFlow, decideNodeAfterTurn, flowEdgeKey, type FlowSnapshot } from "./flowDecision";

const node = (id: string) => ({ id, role: id, prompt: `do ${id}` });
const spec: FlowSpec = {
  version: "flow-v1",
  name: "diamond",
  nodes: [node("a"), node("b"), node("c"), node("d")],
  edges: [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d", policy: "hold" },
    { from: "c", to: "d" },
  ],
  budget: { maxParallel: 1 },
};

function snapshot(
  statuses: Record<string, FlowNodeStatus>,
  overrides: Partial<FlowSnapshot> = {},
): FlowSnapshot {
  return {
    spec,
    status: "running",
    nodes: Object.entries(statuses).map(([nodeId, status]) => ({ nodeId, status })),
    approvedEdges: new Set(),
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe("decideFlow", () => {
  it("promotes and starts the root first", () => {
    expect(decideFlow(snapshot({}))).toEqual([
      { type: "promote", nodeId: "a" },
      { type: "spawn", nodeId: "a" },
    ]);
  });

  it("promotes siblings together but starts only up to maxParallel", () => {
    expect(decideFlow(snapshot({ a: "settled" }))).toEqual([
      { type: "promote", nodeId: "b" },
      { type: "promote", nodeId: "c" },
      { type: "spawn", nodeId: "b" },
    ]);
    expect(decideFlow(snapshot({ a: "settled", b: "running", c: "ready" }))).toEqual([]);
  });

  it("waits on a hold edge until a person approves it", () => {
    const settled = { a: "settled", b: "settled", c: "settled" } as const;
    expect(decideFlow(snapshot(settled))).toEqual([{ type: "await_edge", from: "b", to: "d" }]);
    expect(
      decideFlow(snapshot(settled, { approvedEdges: new Set([flowEdgeKey("b", "d")]) })),
    ).toEqual([
      { type: "promote", nodeId: "d" },
      { type: "spawn", nodeId: "d" },
    ]);
  });

  it("completes, trips the breaker, and fails when blocked behind a failure", () => {
    expect(
      decideFlow(snapshot({ a: "settled", b: "settled", c: "settled", d: "settled" })),
    ).toEqual([{ type: "complete" }]);
    expect(decideFlow(snapshot({ a: "running" }, { consecutiveFailures: 3 }))[0]?.type).toBe(
      "fail",
    );
    expect(decideFlow(snapshot({ a: "failed" }))[0]?.type).toBe("fail");
    expect(decideFlow(snapshot({ a: "needs_you" }))).toEqual([]);
  });

  it("does nothing unless the flow is running", () => {
    expect(decideFlow(snapshot({}, { status: "paused" }))).toEqual([]);
  });
});

describe("decideNodeAfterTurn", () => {
  const gate = (passed: boolean, protectedEdits: string[] = []) =>
    ({ kind: "gate", passed, protectedEdits, summary: "1 failing" }) as const;
  const decide = (
    mode: "manual" | "gate_hold" | "auto_refix" | "autopilot",
    attempts: number,
    outcome: Parameters<typeof decideNodeAfterTurn>[0]["outcome"],
  ) => decideNodeAfterTurn({ mode, attempts, maxRefix: 2, outcome }).type;

  it.each([
    ["manual", 1, gate(true), "settle"],
    ["manual", 1, gate(false), "needs_you"],
    ["manual", 1, { kind: "turn_failed", reason: "x" }, "fail"],
    ["manual", 1, { kind: "completed" }, "settle"],
    ["gate_hold", 1, gate(true), "needs_you"],
    ["gate_hold", 1, { kind: "completed" }, "needs_you"],
    ["auto_refix", 1, gate(false), "refix"],
    ["auto_refix", 3, gate(false), "needs_you"],
    ["auto_refix", 2, { kind: "turn_failed", reason: "x" }, "refix"],
    ["autopilot", 3, { kind: "turn_failed", reason: "x" }, "needs_you"],
    ["auto_refix", 1, gate(true, ["test/a.ts"]), "needs_you"],
    ["manual", 1, gate(false, ["flows/a.yaml"]), "needs_you"],
  ] as const)("%s attempt %i → %s", (mode, attempts, outcome, expected) => {
    expect(decide(mode, attempts, outcome)).toBe(expected);
  });

  it("does not count a protected edit or a review hold as a failure", () => {
    expect(
      decideNodeAfterTurn({
        mode: "auto_refix",
        attempts: 1,
        maxRefix: 2,
        outcome: gate(true, ["t"]),
      }),
    ).toMatchObject({ countsAsFailure: false });
  });
});

describe("decideFlow time budget", () => {
  it("fails once the wall-clock budget is spent", () => {
    const timed = { ...spec, budget: { wallMs: 60_000 } };
    expect(decideFlow({ ...snapshot({}), spec: timed, elapsedMs: 61_000 })[0]?.type).toBe("fail");
    expect(decideFlow({ ...snapshot({}), spec: timed, elapsedMs: 1_000 })[0]?.type).toBe("promote");
  });
});
