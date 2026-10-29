import {
  FLOW_MAX_NESTING_DEPTH,
  FlowRunId,
  ProjectId,
  type FlowNodeRun,
  type FlowRun,
  type OrchestrationThreadShell,
} from "@saint/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { FlowServiceShape, FlowStartInput } from "../flow/Services/FlowService.ts";
import { makeAgentGatewayFlowTools } from "./flowTools.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";
import type { ToolContext } from "./toolRuntime.ts";

const run = (nestingDepth: number): FlowRun => ({
  id: FlowRunId.makeUnsafe("flow-parent"),
  projectId: ProjectId.makeUnsafe("project-1"),
  spec: { version: "flow-v1", name: "p", nodes: [{ id: "a", role: "A", prompt: "p" }], edges: [] },
  status: "running",
  statusReason: null,
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  consecutiveFailures: 0,
  startedBy: "user",
  nestingDepth,
  revision: 0,
  createdAt: "2026-10-29T10:00:00.000Z",
  updatedAt: "2026-10-29T10:00:00.000Z",
});
const node = { flowId: run(0).id, nodeId: "a", status: "running" } as FlowNodeRun;

function harness(parentDepth: number | null) {
  const starts: FlowStartInput[] = [];
  const handoffs: unknown[] = [];
  const flows = {
    nodeForThread: () =>
      Effect.succeed(parentDepth === null ? null : { run: run(parentDepth), node }),
    start: (input: FlowStartInput) =>
      Effect.sync(() => {
        starts.push(input);
        return { run: run(input.nestingDepth ?? 0), nodes: [node], approvedEdges: [] };
      }),
    submitHandoff: (input: { handoff: unknown }) =>
      Effect.sync(() => {
        handoffs.push(input.handoff);
        return node;
      }),
  } as unknown as FlowServiceShape;
  const tools = makeAgentGatewayFlowTools({
    flows,
    requireThreadShell: () =>
      Effect.succeed({
        projectId: ProjectId.makeUnsafe("project-1"),
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5-5" },
        runtimeMode: "approval-required",
      } as OrchestrationThreadShell),
  });
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.runPromise(
      tools
        .find((tool) => tool.definition.name === name)!
        .handler(args, {
          callerThreadId: "caller",
          callerCapabilities: new Set<AgentGatewayCapability>([
            "thread:read",
            "thread:write",
            "flow:write",
          ]),
        } as unknown as ToolContext),
    );
  return { starts, handoffs, call };
}

const text = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((entry) => entry.text ?? "").join("");

describe("flow gateway tools", () => {
  it("starts a template flow with the caller's project, model, mode and capabilities", async () => {
    const { starts, call } = harness(null);
    const result = await call("saint_flow_start", {
      template: "bugfix",
      goal: "Login 500s",
      gateCmd: "bun run test",
    });
    expect(result.isError).toBeFalsy();
    expect(starts[0]).toMatchObject({
      projectId: "project-1",
      runtimeMode: "approval-required",
      modelSelection: { provider: "claudeAgent" },
      nestingDepth: 0,
    });
    expect([...starts[0]!.capabilityCeiling!].toSorted()).toEqual([
      "flow:write",
      "thread:read",
      "thread:write",
    ]);
  });

  it("drops flow:write at the deepest level and refuses to nest further", async () => {
    const deep = harness(FLOW_MAX_NESTING_DEPTH - 1);
    await deep.call("saint_flow_start", { template: "bugfix", goal: "x" });
    expect(deep.starts[0]!.nestingDepth).toBe(FLOW_MAX_NESTING_DEPTH);
    expect(deep.starts[0]!.capabilityCeiling).not.toContain("flow:write");

    const tooDeep = harness(FLOW_MAX_NESTING_DEPTH);
    const refused = await tooDeep.call("saint_flow_start", { template: "bugfix", goal: "x" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("nest at most");
    expect(tooDeep.starts).toHaveLength(0);
  });

  it("rejects an incomplete handoff and stores a complete one", async () => {
    const { handoffs, call } = harness(0);
    const incomplete = await call("saint_flow_done", { target: "t", change: "c" });
    expect(incomplete.isError).toBe(true);
    expect(text(incomplete)).toContain("incomplete");
    expect(handoffs).toHaveLength(0);

    const ok = await call("saint_flow_done", {
      target: "rate limit POST /login",
      change: "token bucket",
      constraints: "no public API change",
      ownership: ["src/auth/**"],
      acceptance: "gate g7 passes",
    });
    expect(ok.isError).toBeFalsy();
    expect(handoffs[0]).toMatchObject({ refs: [], openQuestions: [] });
  });
});
