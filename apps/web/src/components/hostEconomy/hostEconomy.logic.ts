// FILE: hostEconomy.logic.ts
// Purpose: Pure helpers for the Host Economy screen: memory figures, the pressure chart's lines
//          and the tone of each pressure level.
// Layer: Web host economy view
// Exports: usedPercent, formatMb, pressureChartPaths, LEVEL_TONE

import type { EconomyLevel, EconomySample } from "@saint/contracts";

export const LEVEL_TONE: Record<EconomyLevel, string> = {
  ok: "text-success",
  warn: "text-warning",
  critical: "text-destructive",
};

export function usedPercent(sample: Pick<EconomySample, "usedMb" | "totalMb">): number {
  return sample.totalMb > 0 ? Math.round((sample.usedMb / sample.totalMb) * 100) : 0;
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** SVG polyline points (0–width × 0–height, top = 100 %) for used memory and memory stalls. */
export function pressureChartPaths(
  samples: ReadonlyArray<EconomySample>,
  width: number,
  height: number,
): { used: string; stall: string | null } {
  if (samples.length === 0) return { used: "", stall: null };
  const step = samples.length > 1 ? width / (samples.length - 1) : 0;
  const y = (pct: number) => (height - (Math.min(100, Math.max(0, pct)) / 100) * height).toFixed(1);
  const x = (index: number) => (index * step).toFixed(1);
  const used = samples.map((sample, index) => `${x(index)},${y(usedPercent(sample))}`).join(" ");
  const hasStall = samples.some((sample) => sample.stallPct !== null);
  const stall = hasStall
    ? samples.map((sample, index) => `${x(index)},${y(sample.stallPct ?? 0)}`).join(" ")
    : null;
  return { used, stall };
}

/** The y of a percentage line on the chart. */
export const chartY = (pct: number, height: number) => height - (pct / 100) * height;
