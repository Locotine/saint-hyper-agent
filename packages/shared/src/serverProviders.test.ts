import { describe, expect, it } from "vitest";

import { parseServerProviderAllowlist } from "./serverProviders";

describe("parseServerProviderAllowlist", () => {
  it("runs every provider when unset or blank", () => {
    expect(parseServerProviderAllowlist(undefined)).toBeNull();
    expect(parseServerProviderAllowlist(" , ")).toBeNull();
  });

  it("reads a comma-separated list", () => {
    expect([...(parseServerProviderAllowlist(" codex, claudeAgent ") ?? [])]).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });
});
