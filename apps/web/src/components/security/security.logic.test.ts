import type { AegisAlert } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { sortAlertsByRisk } from "./security.logic";

const alert = (
  id: string,
  severity: AegisAlert["severity"],
  state: AegisAlert["state"],
  at: string,
) => ({ id, severity, state, createdAt: at }) as AegisAlert;

describe("security logic", () => {
  it("puts open alerts first, riskiest first, newest first", () => {
    const sorted = sortAlertsByRisk([
      alert("low-open", "low", "open", "2026-10-29T03:00:00Z"),
      alert("crit-done", "critical", "denied", "2026-10-29T04:00:00Z"),
      alert("high-old", "high", "open", "2026-10-29T01:00:00Z"),
      alert("high-new", "high", "open", "2026-10-29T02:00:00Z"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "high-new",
      "high-old",
      "low-open",
      "crit-done",
    ]);
  });
});
