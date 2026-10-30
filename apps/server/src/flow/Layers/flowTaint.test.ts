import type { FlowSpec } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { taintedNodes } from "./FlowService";

const spec = {
  version: "flow-v1",
  name: "f",
  nodes: [
    { id: "research", role: "R", prompt: "p" },
    { id: "code", role: "C", prompt: "p" },
    { id: "docs", role: "D", prompt: "p" },
  ],
  edges: [{ from: "research", to: "code" }],
} as unknown as FlowSpec;

describe("taintedNodes", () => {
  it("spreads a step seen reading untrusted input to everything downstream", () => {
    expect([...taintedNodes(spec)]).toEqual([]);
    expect(
      [...taintedNodes(spec, [{ nodeId: "research", taint: "untrusted" }])].toSorted(),
    ).toEqual(["code", "research"]);
  });
});
