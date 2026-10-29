import type { FlowNodeSpec, FlowSpec } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { decideQuota, isQuotaError, nextAllowedProvider } from "./quotaFailover";

const spec = (extra: Partial<FlowSpec> = {}): FlowSpec => ({
  version: "flow-v1",
  name: "f",
  nodes: [],
  edges: [],
  allowedProviders: ["codex", "claudeAgent", "opencode"],
  ...extra,
});
const node = (extra: Partial<FlowNodeSpec> = {}): FlowNodeSpec => ({
  id: "a",
  role: "A",
  prompt: "p",
  ...extra,
});

describe("decideQuota", () => {
  it("asks by default, switches on autopilot", () => {
    expect(decideQuota({ spec: spec(), node: node(), current: "codex", exhausted: [] }).type).toBe(
      "ask",
    );
    expect(
      decideQuota({
        spec: spec(),
        node: node({ mode: "autopilot" }),
        current: "codex",
        exhausted: [],
      }),
    ).toEqual({ type: "switch", provider: "claudeAgent" });
  });

  it("never moves to weaker data terms and skips exhausted providers", () => {
    const terms = spec({ dataTerms: { codex: "no_training", opencode: "zero_retention" } });
    expect(
      decideQuota({
        spec: terms,
        node: node({ onQuota: "switch" }),
        current: "codex",
        exhausted: ["codex"],
      }),
    ).toEqual({ type: "switch", provider: "opencode" });
    expect(
      decideQuota({
        spec: terms,
        node: node({ onQuota: "switch" }),
        current: "codex",
        exhausted: ["codex", "opencode"],
      }).type,
    ).toBe("wait");
  });

  it("waits when told to", () => {
    expect(
      decideQuota({
        spec: spec(),
        node: node({ onQuota: "wait" }),
        current: "codex",
        exhausted: [],
      }).type,
    ).toBe("wait");
  });
});

it.each([
  ["You've hit your usage limit. Try again at 3pm.", true],
  ["429 Too Many Requests", true],
  ["insufficient_quota", true],
  ["TypeError: x is undefined", false],
  [null, false],
])("isQuotaError(%j) = %s", (text, expected) => {
  expect(isQuotaError(text)).toBe(expected);
});

describe("nextAllowedProvider", () => {
  it("skips tried providers and never weakens data terms", () => {
    const terms = spec({
      dataTerms: { codex: "zero_retention", claudeAgent: "standard", opencode: "zero_retention" },
    } as Partial<FlowSpec>);
    expect(nextAllowedProvider(terms, "codex", [])).toBe("opencode");
    expect(nextAllowedProvider(terms, "codex", ["opencode"])).toBeNull();
    expect(nextAllowedProvider(spec(), "codex", ["claudeAgent"])).toBe("opencode");
  });
});
