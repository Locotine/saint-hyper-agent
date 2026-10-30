// FILE: flowTools.ts
// Purpose: Agent-as-user tools for flows — an agent starts a flow DAG (from a template or a spec),
//          reads a flow's state, and submits the schema'd handoff for the steps after its node.
//          Children run with at most the caller's capabilities, and nesting is bounded.
// Layer: Agent gateway tools

import {
  FLOW_MAX_NESTING_DEPTH,
  FlowHandoffV1,
  FlowRunId,
  ThreadId,
  type FlowRun,
  type FlowNodeRun,
  type OrchestrationThreadShell,
} from "@saint/contracts";
import { Cause, Effect, Schema } from "effect";

import { FLOW_TEMPLATES, findFlowTemplate } from "../flow/flowTemplates.ts";
import type { FlowServiceShape } from "../flow/Services/FlowService.ts";
import type { ForkContinueShape } from "../orchestration/Services/ForkContinue.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readStringArg } from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

export interface FlowToolsInput {
  readonly flows: FlowServiceShape;
  readonly forkContinue?: ForkContinueShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
}

const toToolError = (error: unknown) =>
  error instanceof ToolInputError ? error : new ToolInputError(errorText(error));

const readArgs = <A>(read: () => A): Effect.Effect<A, ToolInputError> =>
  Effect.try({ try: read, catch: toToolError });

const asToolResult = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.map(mcpToolResultJson),
    Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
  );

/** Compact flow state for an agent: what runs, what waits, why, and the gate evidence handle. */
export function flowStatusForAgent(run: FlowRun, nodes: ReadonlyArray<FlowNodeRun>) {
  return {
    flowId: run.id,
    name: run.spec.name,
    status: run.status,
    ...(run.statusReason ? { reason: run.statusReason } : {}),
    nodes: nodes.map((node) => ({
      id: node.nodeId,
      role: run.spec.nodes.find((spec) => spec.id === node.nodeId)?.role,
      status: node.status,
      attempts: node.attempts,
      ...(node.statusReason ? { reason: node.statusReason } : {}),
      ...(node.threadId ? { threadId: node.threadId } : {}),
      ...(node.lastGate
        ? {
            gate: {
              id: node.lastGate.gateId,
              passed: node.lastGate.passed,
              exitCode: node.lastGate.exitCode,
              evidence: node.lastGate.evidence,
            },
          }
        : {}),
      hasHandoff: node.handoff !== null,
    })),
  };
}

export function makeAgentGatewayFlowTools(input: FlowToolsInput): ReadonlyArray<ToolEntry> {
  const { flows, requireThreadShell, forkContinue } = input;

  const listTemplates: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "saint_flow_templates",
      description:
        "List Saint's built-in flow templates. Start one with saint_flow_start { template, goal }.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List flow templates", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      Effect.succeed(
        mcpToolResultJson({
          templates: FLOW_TEMPLATES.map(({ id, title, description }) => ({
            id,
            title,
            description,
          })),
        }),
      ),
  };

  const startFlow: ToolEntry = {
    requiredCapability: "flow:write",
    requiresActiveTurn: true,
    definition: {
      name: "saint_flow_start",
      description: `Start a Saint flow: a DAG of agent steps that Saint schedules, gates and hands off between. Pass either template + goal (see saint_flow_templates) or spec (flow-v1 YAML). Steps run in this thread's project with this thread's model and approval mode, and never with more permissions than you have. Flows nest at most ${FLOW_MAX_NESTING_DEPTH} levels below one a person started. Returns the flowId; follow it with saint_flow_status.`,
      inputSchema: {
        type: "object",
        properties: {
          template: { type: "string", enum: FLOW_TEMPLATES.map((template) => template.id) },
          goal: { type: "string", maxLength: 4_000, description: "What the template flow is for." },
          gateCmd: {
            type: "string",
            maxLength: 2_000,
            description:
              "The project's check command for gated steps, e.g. `bun run test`. Saint runs it itself.",
          },
          spec: {
            type: "string",
            maxLength: 100_000,
            description: "A flow-v1 YAML spec, instead of template.",
          },
        },
        additionalProperties: false,
      },
      annotations: { title: "Start a flow", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      asToolResult(
        Effect.gen(function* () {
          const choice = yield* readArgs(() => ({
            template: readStringArg(args, "template"),
            goal: readStringArg(args, "goal"),
            gateCmd: readStringArg(args, "gateCmd"),
            spec: readStringArg(args, "spec"),
          }));
          let spec: string | ReturnType<NonNullable<ReturnType<typeof findFlowTemplate>>["build"]>;
          if (choice.spec !== undefined) {
            if (choice.template !== undefined) {
              return yield* Effect.fail(
                new ToolInputError("Pass either template or spec, not both."),
              );
            }
            spec = choice.spec;
          } else {
            const template = choice.template ? findFlowTemplate(choice.template) : undefined;
            if (!template || !choice.goal) {
              return yield* Effect.fail(new ToolInputError("Pass template and goal, or a spec."));
            }
            spec = template.build({
              goal: choice.goal,
              ...(choice.gateCmd ? { gateCmd: choice.gateCmd } : {}),
            });
          }

          const caller = yield* requireThreadShell(context.callerThreadId).pipe(
            Effect.mapError(toToolError),
          );
          // A thread a step created through the gateway belongs to that step's flow, so nesting
          // through child threads counts toward the depth limit too.
          let parent = null as Effect.Success<ReturnType<FlowServiceShape["nodeForThread"]>>;
          let shell: OrchestrationThreadShell | null = caller;
          const visited = new Set<string>();
          while (shell && !visited.has(shell.id)) {
            visited.add(shell.id);
            parent = yield* flows.nodeForThread(shell.id).pipe(Effect.mapError(toToolError));
            if (parent || !shell.sourceThreadId) break;
            shell = yield* requireThreadShell(shell.sourceThreadId).pipe(
              Effect.orElseSucceed(() => null),
            );
          }
          const nestingDepth = parent ? (parent.run.nestingDepth ?? 0) + 1 : 0;
          if (nestingDepth > FLOW_MAX_NESTING_DEPTH) {
            return yield* Effect.fail(
              new ToolInputError(
                `Flows nest at most ${FLOW_MAX_NESTING_DEPTH} levels; this step cannot start another flow.`,
              ),
            );
          }
          // The children of the deepest allowed flow cannot start flows themselves.
          const ceiling = [...context.callerCapabilities].filter(
            (capability) => capability !== "flow:write" || nestingDepth < FLOW_MAX_NESTING_DEPTH,
          );
          const started = yield* flows
            .start({
              projectId: caller.projectId,
              spec,
              modelSelection: caller.modelSelection,
              runtimeMode: caller.runtimeMode,
              startedBy: `thread:${context.callerThreadId}`,
              capabilityCeiling: ceiling,
              nestingDepth,
            })
            .pipe(Effect.mapError(toToolError));
          return flowStatusForAgent(started.run, started.nodes);
        }),
      ),
  };

  const flowStatus: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "saint_flow_status",
      description:
        "Read a flow's state: each step's status, attempts, why it waits, and its gate result with an evidence handle. Without flowId, reads the flow this thread is a step of.",
      inputSchema: {
        type: "object",
        properties: { flowId: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { title: "Read flow status", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      asToolResult(
        Effect.gen(function* () {
          const requested = yield* readArgs(() => readStringArg(args, "flowId"));
          const flowId =
            requested !== undefined
              ? FlowRunId.makeUnsafe(requested)
              : (yield* flows
                  .nodeForThread(ThreadId.makeUnsafe(context.callerThreadId))
                  .pipe(Effect.mapError(toToolError)))?.run.id;
          if (!flowId) {
            return yield* Effect.fail(
              new ToolInputError("Pass flowId; this thread is not a flow step."),
            );
          }
          const view = yield* flows.get(flowId).pipe(Effect.mapError(toToolError));
          if (!view)
            return yield* Effect.fail(new ToolInputError(`Flow "${flowId}" was not found.`));
          return flowStatusForAgent(view.run, view.nodes);
        }),
      ),
  };

  const flowDone: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "saint_flow_done",
      description:
        "As a flow step, hand off to the steps after you. All five fields are required; refs point at files, diffs or Saint handles instead of pasting them. Saint still runs your step's gate itself when your turn ends — do not claim it passed. Submitting again replaces the handoff.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            maxLength: 500,
            description: "What the next step must achieve.",
          },
          change: { type: "string", maxLength: 2_000, description: "What you changed." },
          constraints: { type: "string", maxLength: 2_000 },
          ownership: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string" },
            description: "Path globs the next step may change.",
          },
          acceptance: { type: "string", maxLength: 2_000, description: "How to know it is done." },
          refs: { type: "array", maxItems: 32, items: { type: "string" } },
          openQuestions: { type: "array", maxItems: 16, items: { type: "string" } },
        },
        required: ["target", "change", "constraints", "ownership", "acceptance"],
        additionalProperties: false,
      },
      annotations: { title: "Hand off to the next step", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      asToolResult(
        Effect.gen(function* () {
          const decoded = Schema.decodeUnknownExit(FlowHandoffV1)({
            refs: [],
            openQuestions: [],
            ...args,
          });
          if (decoded._tag === "Failure") {
            return yield* Effect.fail(
              new ToolInputError(
                `The handoff is incomplete; fix it and call saint_flow_done again:\n${Cause.pretty(decoded.cause)}`,
              ),
            );
          }
          const node = yield* flows
            .submitHandoff({
              threadId: ThreadId.makeUnsafe(context.callerThreadId),
              handoff: decoded.value,
            })
            .pipe(Effect.mapError(toToolError));
          return { accepted: true, node: node.nodeId };
        }),
      ),
  };

  const forkContinueTool: ToolEntry = {
    requiredCapability: "thread:write",
    definition: {
      name: "saint_fork_continue",
      description:
        "Move this work into a clean session when your context is crowded or you are going in circles. Saint snapshots the goal, latest request, where you stand, changed files and handles, and starts a fresh thread from it (for a flow step, the step's next attempt). Stop after calling it; the new session carries on.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string", maxLength: 300 } },
        additionalProperties: false,
      },
      annotations: { title: "Fork & Continue", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      asToolResult(
        Effect.gen(function* () {
          const reason =
            (yield* readArgs(() => readStringArg(args, "reason"))) ?? "asked by the agent";
          const threadId = ThreadId.makeUnsafe(context.callerThreadId);
          const step = yield* flows.nodeForThread(threadId).pipe(Effect.mapError(toToolError));
          if (step) {
            yield* flows
              .continueNode({
                flowId: step.run.id,
                nodeId: step.node.nodeId,
                by: `thread:${threadId}`,
                reason,
              })
              .pipe(Effect.mapError(toToolError));
            return { continued: true, flowId: step.run.id, node: step.node.nodeId };
          }
          if (!forkContinue) {
            return yield* Effect.fail(new ToolInputError("Fork & Continue is not available."));
          }
          const next = yield* forkContinue
            .forkContinue({ threadId, reason })
            .pipe(Effect.mapError(toToolError));
          return { continued: true, threadId: next };
        }),
      ),
  };

  return [listTemplates, startFlow, flowStatus, flowDone, forkContinueTool];
}
