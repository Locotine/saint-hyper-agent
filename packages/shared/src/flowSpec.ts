// FILE: flowSpec.ts
// Purpose: Parse `flows/*.yaml` into a `flow-v1` spec and reject graphs the scheduler cannot run
//          (unknown endpoints, duplicates, cycles, depth over budget). Also serializes a spec
//          back to YAML for the Canvas ↔ YAML round trip.
// Layer: Shared flow domain (pure), used by the server scheduler and the web Canvas

import {
  FLOW_DEFAULT_MAX_DEPTH,
  FlowSpec,
  type FlowEdgeSpec,
  type FlowSpec as FlowSpecType,
} from "@saint/contracts";
import { Cause, Schema } from "effect";
import YAML from "yaml";

export type FlowSpecResult =
  | { readonly _tag: "ok"; readonly spec: FlowSpecType }
  | { readonly _tag: "invalid"; readonly errors: ReadonlyArray<string> };

const edgeKey = (edge: Pick<FlowEdgeSpec, "from" | "to">) => `${edge.from}->${edge.to}`;

/** Longest-path depth of every node from the roots (0 for nodes without incoming edges). */
export function flowNodeDepths(spec: FlowSpecType): ReadonlyMap<string, number> | null {
  const incoming = new Map(spec.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of spec.edges) incoming.get(edge.to)?.push(edge.from);
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number | null => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return null;
    visiting.add(id);
    let depth = 0;
    for (const parent of incoming.get(id) ?? []) {
      const parentDepth = depthOf(parent);
      if (parentDepth === null) return null;
      depth = Math.max(depth, parentDepth + 1);
    }
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const node of spec.nodes) if (depthOf(node.id) === null) return null;
  return depths;
}

export function validateFlowGraph(spec: FlowSpecType): ReadonlyArray<string> {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of spec.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id "${node.id}".`);
    ids.add(node.id);
  }
  const seenEdges = new Set<string>();
  for (const edge of spec.edges) {
    if (!ids.has(edge.from)) errors.push(`Edge ${edgeKey(edge)} starts at an unknown node.`);
    if (!ids.has(edge.to)) errors.push(`Edge ${edgeKey(edge)} ends at an unknown node.`);
    if (edge.from === edge.to) errors.push(`Edge ${edgeKey(edge)} points at itself.`);
    if (seenEdges.has(edgeKey(edge))) errors.push(`Duplicate edge ${edgeKey(edge)}.`);
    seenEdges.add(edgeKey(edge));
  }
  if (errors.length > 0) return errors;
  const depths = flowNodeDepths(spec);
  if (depths === null) return ["The flow has a cycle; a flow must be a DAG."];
  const maxDepth = spec.budget?.maxDepth ?? FLOW_DEFAULT_MAX_DEPTH;
  const deepest = Math.max(...depths.values());
  if (deepest >= maxDepth) {
    errors.push(`The flow is ${deepest + 1} levels deep; the budget allows ${maxDepth}.`);
  }
  return errors;
}

export function decodeFlowSpec(input: unknown): FlowSpecResult {
  const decoded = Schema.decodeUnknownExit(FlowSpec)(input);
  if (decoded._tag === "Failure") {
    return { _tag: "invalid", errors: [Cause.pretty(decoded.cause)] };
  }
  const errors = validateFlowGraph(decoded.value);
  return errors.length > 0 ? { _tag: "invalid", errors } : { _tag: "ok", spec: decoded.value };
}

export function parseFlowSpecYaml(text: string): FlowSpecResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text, { logLevel: "error" });
  } catch (cause) {
    return { _tag: "invalid", errors: [cause instanceof Error ? cause.message : String(cause)] };
  }
  return decodeFlowSpec(parsed);
}

export function stringifyFlowSpecYaml(spec: FlowSpecType): string {
  return YAML.stringify(spec, { lineWidth: 0 });
}
