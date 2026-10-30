import { describe, expect, it } from "vitest";

import { DEFAULT_EGRESS_ALLOWLIST } from "./rules";
import {
  egressVerdict,
  evaluateCedar,
  mayWritePath,
  validateCedarPolicies,
  type PolicyPrincipal,
} from "./policy";

const cedar = `
forbid(principal in Saint::Flow::"f1", action == Saint::Action::"saint_create_threads", resource);
permit(principal == Saint::Thread::"t1", action == Saint::Action::"egress", resource == Saint::Host::"git.corp.test");
forbid(principal, action == Saint::Action::"egress", resource == Saint::Host::"api.openai.com")
  when { principal is Saint::Node && principal.nodeId == "qa" };
permit(principal == Saint::Node::"f1/coder", action == Saint::Action::"write", resource == Saint::Path::"tests/a.test.ts");
`;
const policy = {
  version: 1 as const,
  cedar,
  egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
  egressDenylist: ["evil.example"],
  protectedZones: ["tests/**"],
};
const thread: PolicyPrincipal = { kind: "thread", threadId: "t1" };
const qa: PolicyPrincipal = { kind: "node", flowId: "f1", nodeId: "qa", threadId: "flow-x" };
const coder: PolicyPrincipal = { kind: "node", flowId: "f1", nodeId: "coder", threadId: "flow-y" };

describe("Cedar", () => {
  it("validates on save", () => {
    expect(validateCedarPolicies(cedar)).toEqual([]);
    expect(validateCedarPolicies("")).toEqual([]);
    expect(validateCedarPolicies("permit(principal,")[0]).toContain("parse");
  });

  it("forbids a tool for every step of a flow, leaves other tools and threads alone", () => {
    expect(
      evaluateCedar(cedar, qa, { action: "tool", tool: "saint_create_threads" }).decision,
    ).toBe("forbid");
    expect(evaluateCedar(cedar, qa, { action: "tool", tool: "saint_ask" }).decision).toBe("none");
    expect(
      evaluateCedar(cedar, thread, { action: "tool", tool: "saint_create_threads" }).decision,
    ).toBe("none");
  });

  it("unparseable text never grants", () => {
    expect(evaluateCedar("permit(", thread, { action: "tool", tool: "x" }).decision).toBe("forbid");
  });

  it.each([
    ["api.anthropic.com", thread, "allow"],
    ["evil.example", thread, "deny"],
    ["git.corp.test", thread, "allow"],
    ["git.corp.test", qa, "unknown"],
    ["api.openai.com", qa, "deny"],
    ["api.openai.com", thread, "allow"],
    ["unknown.example", thread, "unknown"],
  ] as const)("egress %s for %o → %s", (host, principal, verdict) => {
    expect(egressVerdict(policy, host, principal)).toBe(verdict);
  });

  it("a protected-zone write needs an explicit permit", () => {
    const isProtected = (file: string) => file.startsWith("tests/");
    expect(mayWritePath(policy, coder, "tests/a.test.ts", isProtected)).toBe(true);
    expect(mayWritePath(policy, qa, "tests/a.test.ts", isProtected)).toBe(false);
    expect(mayWritePath(policy, qa, "src/a.ts", isProtected)).toBe(true);
  });
});
