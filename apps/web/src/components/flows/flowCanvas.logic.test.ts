import type { FlowNodeRun, FlowSpec } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  blankFlowSpec,
  connectFlowNodes,
  flowEdgeState,
  layoutFlow,
  removeFlowNode,
  updateFlowNode,
} from "./flowCanvas.logic";

const node = (id: string) => ({ id, role: id, prompt: "p" });
const spec = (ids: string[], edges: [string, string][]): FlowSpec => ({
  version: "flow-v1",
  name: "t",
  nodes: ids.map(node),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe("layoutFlow", () => {
  it("lays a diamond out in three columns with the middle pair stacked", () => {
    const { positions } = layoutFlow(
      spec(
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["a", "c"],
          ["b", "d"],
          ["c", "d"],
        ],
      ),
    );
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => positions.get(id)!);
    expect(b!.x).toBe(c!.x);
    expect(b!.y).toBeLessThan(c!.y);
    expect(a!.x).toBeLessThan(b!.x);
    expect(d!.x).toBeGreaterThan(b!.x);
    // The single nodes sit level with the middle of the stacked pair.
    expect(a!.y).toBe((b!.y + c!.y) / 2);
    expect(d!.y).toBe(a!.y);
  });

  it("keeps parallel branches in their own rows and puts an orphan in the first column", () => {
    const { positions } = layoutFlow(
      spec(
        ["a", "b", "x", "y", "lone"],
        [
          ["a", "b"],
          ["x", "y"],
        ],
      ),
    );
    expect(positions.get("lone")!.x).toBe(positions.get("a")!.x);
    expect(new Set(["a", "x", "lone"].map((id) => positions.get(id)!.y)).size).toBe(3);
    expect(positions.get("b")!.y).not.toBe(positions.get("y")!.y);
  });

  it("uses dragged positions", () => {
    const { positions } = layoutFlow(spec(["a"], []), new Map([["a", { x: 300, y: 400 }]]));
    expect(positions.get("a")).toEqual({ x: 300, y: 400 });
  });
});

describe("flowEdgeState", () => {
  const run = (nodeId: string, status: FlowNodeRun["status"]) =>
    [nodeId, { nodeId, status } as FlowNodeRun] as const;
  it("is live while the downstream step works, hold until approved, done once it settles", () => {
    const edge = { from: "a", to: "b", policy: "hold" as const };
    expect(
      flowEdgeState(edge, new Map([run("a", "settled"), run("b", "running")]), new Set()),
    ).toBe("live");
    expect(
      flowEdgeState(edge, new Map([run("a", "settled"), run("b", "pending")]), new Set()),
    ).toBe("hold");
    expect(
      flowEdgeState(edge, new Map([run("a", "settled"), run("b", "pending")]), new Set(["a->b"])),
    ).toBe("idle");
    expect(
      flowEdgeState(edge, new Map([run("a", "settled"), run("b", "settled")]), new Set()),
    ).toBe("done");
  });
});

describe("spec edits", () => {
  it("refuses an edge that closes a cycle and a duplicate", () => {
    const base = spec(["a", "b"], [["a", "b"]]);
    expect(connectFlowNodes(base, "b", "a")).toBeNull();
    expect(connectFlowNodes(base, "a", "b")).toBeNull();
    expect(connectFlowNodes(spec(["a", "b"], []), "a", "b")?.edges).toEqual([
      { from: "a", to: "b" },
    ]);
  });

  it("renames a node through its edges and drops edges with a removed node", () => {
    const renamed = updateFlowNode(blankFlowSpec(), "plan", { id: "design" })!;
    expect(renamed.edges).toEqual([{ from: "design", to: "build" }]);
    expect(updateFlowNode(blankFlowSpec(), "plan", { id: "build" })).toBeNull();
    expect(removeFlowNode(renamed, "build").edges).toEqual([]);
  });
});
