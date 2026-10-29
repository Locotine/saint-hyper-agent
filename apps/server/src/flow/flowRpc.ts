// FILE: flowRpc.ts
// Purpose: The flow.* and ledger.* WebSocket RPCs the Canvas, Dashboard and Security views use.
//          Every action from the UI is recorded as the user.
// Layer: Server RPC adapter

import type {
  FlowActionInput,
  FlowRunId,
  FlowStartRpcInput,
  LedgerHandle,
  ProjectId,
} from "@saint/contracts";
import { Effect } from "effect";

import type { LedgerShape } from "../ledger/Services/Ledger.ts";
import { FLOW_TEMPLATES, findFlowTemplate } from "./flowTemplates.ts";
import { FlowServiceError, type FlowServiceShape } from "./Services/FlowService.ts";

const USER = "user";

export function handleFlowRpc(input: {
  readonly flows: FlowServiceShape;
  readonly ledger: LedgerShape;
}) {
  const { flows, ledger } = input;
  const fail = (message: string) => Effect.fail(new FlowServiceError({ message }));
  const view = (flowId: FlowRunId) =>
    flows.get(flowId).pipe(Effect.map((found) => ({ view: found })));

  const requireArg = (value: string | undefined, name: string) =>
    value === undefined ? fail(`${name} is required for this action.`) : Effect.succeed(value);

  const action = (request: FlowActionInput) =>
    Effect.gen(function* () {
      const { flowId } = request;
      switch (request.action) {
        case "pause":
          yield* flows.pause(flowId, USER);
          break;
        case "resume":
          yield* flows.resume(flowId, USER);
          break;
        case "cancel":
          yield* flows.cancel(flowId, USER);
          break;
        case "approveEdge":
          yield* flows.approveEdge({
            flowId,
            from: yield* requireArg(request.from, "from"),
            to: yield* requireArg(request.to, "to"),
            by: USER,
          });
          break;
        case "approveNode":
        case "retryNode":
        case "rerunGate": {
          const nodeId = yield* requireArg(request.nodeId, "nodeId");
          const target = { flowId, nodeId, by: USER };
          if (request.action === "approveNode") yield* flows.approveNode(target);
          else if (request.action === "retryNode") yield* flows.retryNode(target);
          else yield* flows.rerunGate(target);
          break;
        }
        case "continueNode":
          yield* flows.continueNode({
            flowId,
            nodeId: yield* requireArg(request.nodeId, "nodeId"),
            by: USER,
            reason: "asked by the user",
          });
          break;
      }
      return yield* view(flowId);
    });

  const start = (request: FlowStartRpcInput) =>
    Effect.gen(function* () {
      let spec;
      if (request.spec !== undefined) {
        spec = request.spec;
      } else {
        const template = request.template ? findFlowTemplate(request.template) : undefined;
        if (!template || !request.goal)
          return yield* fail("Pick a template and describe the goal.");
        spec = template.build({
          goal: request.goal,
          ...(request.gateCmd ? { gateCmd: request.gateCmd } : {}),
        });
      }
      return yield* flows.start({
        projectId: request.projectId,
        spec,
        modelSelection: request.modelSelection,
        runtimeMode: request.runtimeMode,
        startedBy: USER,
      });
    });

  return {
    list: (request: { readonly projectId?: ProjectId | undefined }) =>
      flows
        .list(request.projectId ? { projectId: request.projectId } : {})
        .pipe(Effect.map((runs) => ({ runs }))),
    get: (request: { readonly flowId: FlowRunId }) => view(request.flowId),
    start,
    action,
    killAll: () => flows.killAll(USER).pipe(Effect.map((cancelled) => ({ cancelled }))),
    templates: () =>
      Effect.succeed({
        templates: FLOW_TEMPLATES.map(({ id, title, description }) => ({ id, title, description })),
      }),
    ledgerList: (request: { readonly flowId: FlowRunId; readonly afterSeq?: number | undefined }) =>
      ledger
        .listByFlow(request.flowId, request.afterSeq)
        .pipe(Effect.map((events) => ({ events }))),
    ledgerVerify: () => ledger.verify(),
    ledgerExport: () => ledger.exportJsonl().pipe(Effect.map((jsonl) => ({ jsonl }))),
    ledgerHandle: (request: {
      readonly handle: LedgerHandle;
      readonly fromLine?: number | undefined;
      readonly toLine?: number | undefined;
    }) =>
      ledger
        .getHandle(
          request.handle,
          request.fromLine !== undefined
            ? { from: request.fromLine, to: request.toLine ?? Number.MAX_SAFE_INTEGER }
            : undefined,
        )
        .pipe(
          Effect.map((found) =>
            found
              ? {
                  handle: {
                    handle: found.handle,
                    mime: found.mime,
                    provenance: found.provenance,
                    taint: found.taint,
                    createdAt: found.createdAt,
                    size: found.size,
                    content: found.content,
                    totalLines: found.totalLines,
                  },
                }
              : { handle: null },
          ),
        ),
  };
}
