// FILE: flowPrompt.ts
// Purpose: The first message a node's agent receives: its role and task, the handoffs from the
//          nodes it depends on (as compact Glyph blocks with pointers), and how to finish.
// Layer: Server flow domain (pure)

import type { FlowHandoffV1, FlowNodeSpec, FlowSpec } from "@saint/contracts";

export function renderHandoffGlyph(input: {
  readonly from: string;
  readonly to: string;
  readonly handoff: FlowHandoffV1;
}): string {
  const { handoff } = input;
  return [
    `⟦saint handoff⟧ from=${input.from} to=${input.to}`,
    `target: ${handoff.target}`,
    `change: ${handoff.change}`,
    `constraints: ${handoff.constraints}`,
    `ownership: ${handoff.ownership.join(" ")}`,
    `acceptance: ${handoff.acceptance}`,
    ...(handoff.refs.length > 0 ? [`refs: ${handoff.refs.join(" ")}`] : []),
    ...(handoff.openQuestions.length > 0 ? [`open: ${handoff.openQuestions.join(" · ")}`] : []),
  ].join("\n");
}

export function renderFlowNodePrompt(input: {
  readonly spec: FlowSpec;
  readonly node: FlowNodeSpec;
  readonly incoming: ReadonlyArray<{
    readonly from: string;
    readonly handoff: FlowHandoffV1 | null;
  }>;
  /** Fork & Continue snapshot of this step's earlier session. */
  readonly continuation?: string;
}): string {
  const { spec, node } = input;
  const handoffs = input.incoming.map(({ from, handoff }) =>
    handoff
      ? renderHandoffGlyph({ from, to: node.id, handoff })
      : `⟦saint handoff⟧ from=${from} to=${node.id}\n(no structured handoff; read ${from}'s thread if you need its result)`,
  );
  return [
    `You are the "${node.role}" step (${node.id}) of the Saint flow "${spec.name}".`,
    "",
    node.prompt,
    ...(handoffs.length > 0 ? ["", "Handoffs from the steps before you:", "", ...handoffs] : []),
    ...(node.gate
      ? [
          "",
          `Saint runs the gate \`${node.gate.cmd}\` itself after you finish; do not report it as passed.`,
        ]
      : []),
    ...(input.continuation
      ? ["", "You continue an earlier session of this step:", "", input.continuation]
      : []),
    "",
    "When you are done, call `saint_flow_done` with a handoff for the next step (target, change, constraints, ownership, acceptance, refs, open questions).",
  ].join("\n");
}

/** Sent on the node's own thread when its gate fails and the mode allows another attempt. */
export function renderFlowRefixMessage(input: {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly failure: string;
}): string {
  return [
    `⟦saint refix ${input.attempt}/${input.maxAttempts}⟧ Your step did not pass. Fix the cause, not the check.`,
    "",
    input.failure,
    "",
    "Do not edit the gate or its tests to make it pass; Saint flags edits to protected paths.",
  ].join("\n");
}

/** The tail of a gate log plus a pointer to the full evidence. */
export function summarizeGateFailure(input: {
  readonly cmd: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly evidence: string;
}): string {
  const lines = input.output.trimEnd().split("\n");
  const tail = lines.slice(-60).join("\n");
  const status = input.timedOut ? "timed out" : `exited ${input.exitCode ?? "without a code"}`;
  return [
    `Gate \`${input.cmd}\` ${status}. Last ${Math.min(60, lines.length)} of ${lines.length} lines (full log: ${input.evidence}):`,
    "```",
    tail,
    "```",
  ].join("\n");
}
