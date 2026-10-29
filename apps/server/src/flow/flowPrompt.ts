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
  readonly failure?: string;
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
    ...(input.failure ? ["", "Your previous attempt failed the gate:", "", input.failure] : []),
    "",
    "When you are done, call `saint_flow_done` with a handoff for the next step (target, change, constraints, ownership, acceptance, refs, open questions).",
  ].join("\n");
}
