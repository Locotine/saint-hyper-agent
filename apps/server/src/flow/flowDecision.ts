// FILE: flowDecision.ts
// Purpose: The deterministic scheduler — given a flow snapshot, decide which nodes become ready,
//          which start, which hold edges wait for approval, and whether the flow is finished.
//          Pure: the service persists state and carries the actions out.
// Layer: Server flow domain (pure)

import {
  FLOW_DEFAULT_BREAKER_FAILURES,
  FLOW_DEFAULT_MAX_PARALLEL,
  FLOW_DEFAULT_MAX_REFIX,
  type FlowNodeMode,
  type FlowNodeRun,
  type FlowRunStatus,
  type FlowSpec,
} from "@saint/contracts";

export interface FlowSnapshot {
  readonly spec: FlowSpec;
  readonly status: FlowRunStatus;
  readonly nodes: ReadonlyArray<Pick<FlowNodeRun, "nodeId" | "status">>;
  /** `from->to` keys of hold edges a person has approved. */
  readonly approvedEdges: ReadonlySet<string>;
  /** Node failures since the last node settled; trips the circuit breaker. */
  readonly consecutiveFailures: number;
  /** Time since the run started, checked against `budget.wallMs`. */
  readonly elapsedMs?: number;
  /** Spend so far, checked against the token, tool-call and sub-agent budgets. */
  readonly usage?: {
    readonly tokens: number;
    readonly toolCalls: number;
    readonly subAgents: number;
  };
}

/** Why the run is over its token, tool-call or sub-agent budget, or null. */
export function budgetOverrun(
  budget: FlowSpec["budget"],
  usage: FlowSnapshot["usage"],
): string | null {
  if (!budget || !usage) return null;
  if (budget.maxTokens !== undefined && usage.tokens > budget.maxTokens) {
    return `Token budget of ${budget.maxTokens.toLocaleString("en-US")} exceeded (${usage.tokens.toLocaleString("en-US")}).`;
  }
  if (budget.maxToolCalls !== undefined && usage.toolCalls > budget.maxToolCalls) {
    return `Tool-call budget of ${budget.maxToolCalls} exceeded (${usage.toolCalls}).`;
  }
  if (budget.maxSubAgents !== undefined && usage.subAgents > budget.maxSubAgents) {
    return `Sub-agent budget of ${budget.maxSubAgents} exceeded (${usage.subAgents}).`;
  }
  return null;
}

export type FlowAction =
  | { readonly type: "promote"; readonly nodeId: string }
  | { readonly type: "spawn"; readonly nodeId: string }
  | { readonly type: "await_edge"; readonly from: string; readonly to: string }
  | { readonly type: "complete" }
  | { readonly type: "fail"; readonly reason: string };

export const flowEdgeKey = (from: string, to: string) => `${from}->${to}`;

const ACTIVE = new Set(["running", "gating"]);
const WAITING_ON_PERSON = new Set(["needs_you", "blocked"]);

export function decideFlow(snapshot: FlowSnapshot): ReadonlyArray<FlowAction> {
  if (snapshot.status !== "running") return [];
  const breaker = snapshot.spec.budget?.breakerFailures ?? FLOW_DEFAULT_BREAKER_FAILURES;
  if (snapshot.consecutiveFailures >= breaker) {
    return [
      {
        type: "fail",
        reason: `Circuit breaker: ${snapshot.consecutiveFailures} failures in a row.`,
      },
    ];
  }

  const wallMs = snapshot.spec.budget?.wallMs;
  if (wallMs !== undefined && (snapshot.elapsedMs ?? 0) > wallMs) {
    return [
      { type: "fail", reason: `Time budget of ${Math.round(wallMs / 60_000)} min exceeded.` },
    ];
  }

  const overrun = budgetOverrun(snapshot.spec.budget, snapshot.usage);
  if (overrun) return [{ type: "fail", reason: overrun }];

  const status = new Map(snapshot.nodes.map((node) => [node.nodeId, node.status]));
  const statusOf = (id: string) => status.get(id) ?? "pending";
  if (snapshot.spec.nodes.every((node) => statusOf(node.id) === "settled")) {
    return [{ type: "complete" }];
  }

  const actions: FlowAction[] = [];
  const ready: string[] = [];
  for (const node of snapshot.spec.nodes) {
    const current = statusOf(node.id);
    if (current === "ready") {
      ready.push(node.id);
      continue;
    }
    if (current !== "pending") continue;
    const incoming = snapshot.spec.edges.filter((edge) => edge.to === node.id);
    if (!incoming.every((edge) => statusOf(edge.from) === "settled")) continue;
    const unapproved = incoming.filter(
      (edge) =>
        edge.policy === "hold" && !snapshot.approvedEdges.has(flowEdgeKey(edge.from, edge.to)),
    );
    if (unapproved.length > 0) {
      for (const edge of unapproved)
        actions.push({ type: "await_edge", from: edge.from, to: edge.to });
      continue;
    }
    actions.push({ type: "promote", nodeId: node.id });
    ready.push(node.id);
  }

  const maxParallel = snapshot.spec.budget?.maxParallel ?? FLOW_DEFAULT_MAX_PARALLEL;
  const active = snapshot.spec.nodes.filter((node) => ACTIVE.has(statusOf(node.id))).length;
  for (const nodeId of ready.slice(0, Math.max(0, maxParallel - active))) {
    actions.push({ type: "spawn", nodeId });
  }

  // Nothing running, startable or waiting on a person: the remaining nodes sit behind a failure.
  const stuck =
    actions.length === 0 &&
    active === 0 &&
    !snapshot.spec.nodes.some((node) => WAITING_ON_PERSON.has(statusOf(node.id)));
  if (stuck) return [{ type: "fail", reason: "No node can run: an upstream node failed." }];
  return actions;
}

// ── One node, after its turn ends ─────────────────────────────────────────

export type NodeTurnOutcome =
  | { readonly kind: "turn_failed"; readonly reason: string }
  | { readonly kind: "completed" }
  | {
      readonly kind: "gate";
      readonly passed: boolean;
      readonly protectedEdits: ReadonlyArray<string>;
      readonly summary: string;
    };

export type NodeDecision =
  | { readonly type: "settle" }
  | { readonly type: "refix"; readonly failure: string; readonly countsAsFailure: boolean }
  | { readonly type: "needs_you"; readonly reason: string; readonly countsAsFailure: boolean }
  | { readonly type: "fail"; readonly reason: string };

/**
 * manual: a failure goes to the person · gate_hold: every result waits for review ·
 * auto_refix / autopilot: the failure goes back to the agent until `maxRefix` refixes are used.
 * Editing a protected path always holds the node, whatever the mode.
 */
export function decideNodeAfterTurn(input: {
  readonly mode: FlowNodeMode | undefined;
  /** Turns the node has had so far, including the first. */
  readonly attempts: number;
  readonly maxRefix: number | undefined;
  readonly outcome: NodeTurnOutcome;
}): NodeDecision {
  const mode = input.mode ?? "manual";
  const automatic = mode === "auto_refix" || mode === "autopilot";
  const canRefix = automatic && input.attempts <= (input.maxRefix ?? FLOW_DEFAULT_MAX_REFIX);
  const { outcome } = input;

  if (outcome.kind === "turn_failed") {
    if (canRefix) return { type: "refix", failure: outcome.reason, countsAsFailure: true };
    if (mode === "manual") return { type: "fail", reason: outcome.reason };
    return { type: "needs_you", reason: outcome.reason, countsAsFailure: true };
  }
  if (outcome.kind === "gate" && outcome.protectedEdits.length > 0) {
    return {
      type: "needs_you",
      reason: `Edited protected files: ${outcome.protectedEdits.join(", ")}. Review the test diff.`,
      countsAsFailure: false,
    };
  }
  if (outcome.kind === "completed" || outcome.passed) {
    return mode === "gate_hold"
      ? {
          type: "needs_you",
          reason:
            outcome.kind === "gate" ? "Gate passed; waiting for review." : "Waiting for review.",
          countsAsFailure: false,
        }
      : { type: "settle" };
  }
  if (canRefix) return { type: "refix", failure: outcome.summary, countsAsFailure: true };
  return {
    type: "needs_you",
    reason: automatic ? `Gate still failing after ${input.attempts} attempts.` : "Gate failed.",
    countsAsFailure: true,
  };
}

/**
 * Threads the agents in `roots` created through the gateway, at any depth. Their capability
 * ceilings live in memory, so a restart re-applies the flow's ceiling to them as well.
 */
export function gatewayDescendants(
  threads: ReadonlyArray<{
    readonly id: string;
    readonly sourceThreadId?: string | null | undefined;
  }>,
  roots: Iterable<string>,
): ReadonlyArray<string> {
  const childrenOf = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.sourceThreadId) continue;
    childrenOf.set(thread.sourceThreadId, [
      ...(childrenOf.get(thread.sourceThreadId) ?? []),
      thread.id,
    ]);
  }
  const seen = new Set<string>(roots);
  const queue = [...seen];
  const found: string[] = [];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}
