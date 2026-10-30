import type { EconomySample } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { formatMb, pressureChartPaths, usedPercent } from "./hostEconomy.logic";

const sample = (usedMb: number, stallPct: number | null): EconomySample => ({
  at: "2026-10-29T00:00:00.000Z",
  totalMb: 1000,
  usedMb,
  stallPct,
  agentRssMb: 0,
  level: "ok",
});

describe("host economy logic", () => {
  it("formats memory and percentages", () => {
    expect(usedPercent(sample(250, null))).toBe(25);
    expect(usedPercent({ usedMb: 1, totalMb: 0 })).toBe(0);
    expect(formatMb(512)).toBe("512 MB");
    expect(formatMb(3072)).toBe("3.0 GB");
  });

  it("draws used memory top-down and stalls only when the host reports them", () => {
    expect(pressureChartPaths([], 100, 50)).toEqual({ used: "", stall: null });
    const noStall = pressureChartPaths([sample(0, null), sample(1000, null)], 100, 50);
    expect(noStall).toEqual({ used: "0.0,50.0 100.0,0.0", stall: null });
    const withStall = pressureChartPaths([sample(500, 10), sample(500, null)], 100, 50);
    expect(withStall.stall).toBe("0.0,45.0 100.0,50.0");
  });
});
