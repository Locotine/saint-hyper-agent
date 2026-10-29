// FILE: policy.ts
// Purpose: Cedar policy decisions for Aegis: gateway tool calls, egress hosts and writes to
//          protected zones. Policies are Cedar text kept in `PolicyV1`.
// Layer: Server Aegis domain (pure, WASM)

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { PolicyV1 } from "@saint/contracts";
import type * as CedarWasm from "@cedar-policy/cedar-wasm/nodejs";

// The WASM module (~4 MB) is compiled on first use, not when the server starts.
let cedarModule: typeof CedarWasm | null = null;
const cedar = (): typeof CedarWasm =>
  (cedarModule ??= createRequire(import.meta.url)(
    "@cedar-policy/cedar-wasm/nodejs",
  ) as typeof CedarWasm);

/** Who acts: a plain thread, or a flow step (a member of its flow). */
export type PolicyPrincipal =
  | { readonly kind: "thread"; readonly threadId: string }
  | {
      readonly kind: "node";
      readonly flowId: string;
      readonly nodeId: string;
      readonly threadId: string;
    };

export type PolicyRequest =
  | { readonly action: "tool"; readonly tool: string }
  | { readonly action: "egress"; readonly host: string }
  | { readonly action: "write"; readonly path: string };

/** `none`: no policy matched, so the caller's default applies. */
export type PolicyDecision = "permit" | "forbid" | "none";

export interface PolicyDecisionDetail {
  readonly decision: PolicyDecision;
  /** Ids of the policies that decided (`policy0`, …). */
  readonly policies: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

const uid = (type: string, id: string) => ({ type: `Saint::${type}`, id });

/** Validates Cedar text; returns readable errors, empty when it parses. */
export function validateCedarPolicies(text: string): ReadonlyArray<string> {
  if (text.trim() === "") return [];
  const answer = cedar().checkParsePolicySet({ staticPolicies: text });
  return answer.type === "success" ? [] : answer.errors.map((error) => error.message);
}

// The policy text changes only when settings are saved; parse it once per distinct text instead
// of on every tool call and egress connection.
const preparsed = new Map<string, string | null>();
const PREPARSED_LIMIT = 16;

function preparsedPolicySetId(text: string): string | null {
  const known = preparsed.get(text);
  if (known !== undefined) return known;
  const id = `p${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  const result = cedar().preparsePolicySet(id, { staticPolicies: text });
  // Unparseable text falls back to `isAuthorized`, which reports the errors (and denies).
  const value = result.type === "success" ? id : null;
  if (preparsed.size >= PREPARSED_LIMIT) preparsed.delete(preparsed.keys().next().value!);
  preparsed.set(text, value);
  return value;
}

export function principalEntityUid(principal: PolicyPrincipal) {
  return principal.kind === "node"
    ? uid("Node", `${principal.flowId}/${principal.nodeId}`)
    : uid("Thread", principal.threadId);
}

export function evaluateCedar(
  policyText: string,
  principal: PolicyPrincipal,
  request: PolicyRequest,
): PolicyDecisionDetail {
  if (policyText.trim() === "") return { decision: "none", policies: [], errors: [] };
  const principalUid = principalEntityUid(principal);
  const entities =
    principal.kind === "node"
      ? [
          {
            uid: principalUid,
            attrs: { threadId: principal.threadId, nodeId: principal.nodeId },
            parents: [uid("Flow", principal.flowId)],
          },
          { uid: uid("Flow", principal.flowId), attrs: {}, parents: [] },
        ]
      : [{ uid: principalUid, attrs: { threadId: principal.threadId }, parents: [] }];
  const [actionId, resource, context] =
    request.action === "tool"
      ? [request.tool, uid("Tool", request.tool), { tool: request.tool }]
      : request.action === "egress"
        ? ["egress", uid("Host", request.host.toLowerCase()), { host: request.host.toLowerCase() }]
        : ["write", uid("Path", request.path), { path: request.path }];
  const policySetId = preparsedPolicySetId(policyText);
  const answer = policySetId
    ? cedar().statefulIsAuthorized({
        principal: principalUid,
        action: uid("Action", actionId),
        resource,
        context,
        preparsedPolicySetId: policySetId,
        entities,
      })
    : cedar().isAuthorized({
        principal: principalUid,
        action: uid("Action", actionId),
        resource,
        context,
        policies: { staticPolicies: policyText },
        entities,
      });
  if (answer.type === "failure") {
    // Unparseable policy text never grants anything.
    return {
      decision: "forbid",
      policies: [],
      errors: answer.errors.map((error) => error.message),
    };
  }
  const { decision, diagnostics } = answer.response;
  const errors = diagnostics.errors.map((error) => error.error.message);
  if (decision === "allow") return { decision: "permit", policies: diagnostics.reason, errors };
  // Cedar denies by default; only a matching forbid is an explicit decision.
  return {
    decision: diagnostics.reason.length > 0 ? "forbid" : "none",
    policies: diagnostics.reason,
    errors,
  };
}

/** `*` matches any run of characters; matching ignores case. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

export type EgressVerdict = "allow" | "deny" | "unknown";

/** Denylist, then Cedar (forbid, then permit), then the allowlist; anything else is unknown. */
export function egressVerdict(
  policy: PolicyV1,
  host: string,
  principal: PolicyPrincipal | null,
): EgressVerdict {
  const hostname = host.toLowerCase();
  if (policy.egressDenylist.some((pattern) => globMatch(pattern, hostname))) return "deny";
  if (principal) {
    const decided = evaluateCedar(policy.cedar, principal, { action: "egress", host: hostname });
    if (decided.decision === "forbid") return "deny";
    if (decided.decision === "permit") return "allow";
  }
  return policy.egressAllowlist.some((pattern) => globMatch(pattern, hostname))
    ? "allow"
    : "unknown";
}

/** A protected-zone write needs an explicit Cedar permit; other paths are not protected. */
export function mayWritePath(
  policy: PolicyV1,
  principal: PolicyPrincipal,
  relativePath: string,
  isProtected: (relativePath: string) => boolean,
): boolean {
  if (!isProtected(relativePath)) return true;
  return (
    evaluateCedar(policy.cedar, principal, { action: "write", path: relativePath }).decision ===
    "permit"
  );
}
