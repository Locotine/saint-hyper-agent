import { describe, expect, it } from "vitest";

import {
  decodeFlowSpec,
  flowNodeDepths,
  parseFlowSpecYaml,
  stringifyFlowSpecYaml,
} from "./flowSpec";
import { FLOW_TEMPLATES } from "./flowTemplates";

const diamond = `
version: flow-v1
name: Rate limit /login
nodes:
  - { id: architect, role: Architect, prompt: Plan the change }
  - { id: coder, role: Coder, prompt: Implement it, mode: auto_refix, gate: { id: g7, cmd: bun run test } }
  - { id: docs, role: Docs, prompt: Document it }
  - { id: qa, role: QA, prompt: Verify it, mode: gate_hold }
edges:
  - { from: architect, to: coder }
  - { from: architect, to: docs }
  - { from: coder, to: qa, policy: hold }
  - { from: docs, to: qa }
`;

describe("parseFlowSpecYaml", () => {
  it("accepts a DAG and computes longest-path depths", () => {
    const result = parseFlowSpecYaml(diamond);
    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") return;
    expect(Object.fromEntries(flowNodeDepths(result.spec)!)).toEqual({
      architect: 0,
      coder: 1,
      docs: 1,
      qa: 2,
    });
    expect(parseFlowSpecYaml(stringifyFlowSpecYaml(result.spec))).toEqual(result);
  });

  it.each([
    ["a cycle", "edges: [{ from: a, to: b }, { from: b, to: a }]", "cycle"],
    ["an unknown endpoint", "edges: [{ from: a, to: z }]", "unknown node"],
    ["a self edge", "edges: [{ from: a, to: a }]", "itself"],
    ["a duplicate edge", "edges: [{ from: a, to: b }, { from: a, to: b }]", "Duplicate edge"],
    ["too much depth", "budget: { maxDepth: 1 }\nedges: [{ from: a, to: b }]", "levels deep"],
  ])("rejects %s", (_label, tail, message) => {
    const result = parseFlowSpecYaml(
      `version: flow-v1\nname: x\nnodes:\n  - { id: a, role: A, prompt: p }\n  - { id: b, role: B, prompt: p }\n${tail}`,
    );
    expect(result._tag).toBe("invalid");
    if (result._tag === "invalid") expect(result.errors.join("\n")).toContain(message);
  });

  it("reports schema and YAML errors without throwing", () => {
    expect(parseFlowSpecYaml("version: flow-v2\nname: x\nnodes: []\nedges: []")._tag).toBe(
      "invalid",
    );
    expect(parseFlowSpecYaml("nodes: [")._tag).toBe("invalid");
  });
});

describe("flow templates", () => {
  it.each(FLOW_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s builds a valid flow with and without a gate",
    (_id, template) => {
      for (const gateCmd of [undefined, "bun run test"]) {
        const result = decodeFlowSpec(
          template.build({ goal: "Add a rate limit", ...(gateCmd ? { gateCmd } : {}) }),
        );
        expect(result._tag).toBe("ok");
      }
    },
  );
});
