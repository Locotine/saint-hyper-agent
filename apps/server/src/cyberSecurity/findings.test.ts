import { describe, expect, it } from "vitest";

import { countUnresolved, parseFindingRefs, verdictFor } from "./findings.ts";

const ref = (value: object) => JSON.stringify(value);

describe("parseFindingRefs", () => {
  it("reads valid findings and skips pointers and malformed entries", () => {
    const findings = parseFindingRefs(
      [
        ref({ title: "Injection", severity: "HIGH", file: "api/a.ts", line: 12, fix: "bind it" }),
        "apps/web/src/a.ts",
        "{not json",
        ref({ title: "No severity" }),
        ref({ title: "Bad line", severity: "low", line: -3, category: "web" }),
      ],
      "api",
    );
    expect(findings).toEqual([
      expect.objectContaining({ title: "Injection", severity: "high", category: "api", line: 12 }),
      expect.objectContaining({ title: "Bad line", severity: "low", category: "web", line: null }),
    ]);
  });

  it("keeps at most 32 findings", () => {
    const refs = Array.from({ length: 40 }, (_, i) => ref({ title: `f${i}`, severity: "low" }));
    expect(parseFindingRefs(refs)).toHaveLength(32);
  });
});

const open = (severity: "critical" | "high" | "medium" | "low") => ({
  severity,
  status: "open" as const,
});

describe("verdictFor", () => {
  it("fails while an unresolved finding reaches the threshold", () => {
    expect(verdictFor([open("medium"), open("high")], "high")).toBe("fail");
    expect(verdictFor([open("medium"), open("low")], "high")).toBe("pass");
  });

  it("passes once every blocking finding is resolved", () => {
    expect(verdictFor([{ severity: "critical", status: "resolved" }, open("low")], "high")).toBe(
      "pass",
    );
  });

  it("counts only unresolved findings", () => {
    expect(
      countUnresolved([open("high"), { severity: "high", status: "resolved" }, open("low")]),
    ).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
  });
});
