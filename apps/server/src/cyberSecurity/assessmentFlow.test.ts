import { describe, expect, it } from "vitest";

import {
  buildAssessmentFlow,
  matchCategories,
  REPORT_NODE_ID,
  SURFACE_CATEGORY,
} from "./assessmentFlow.ts";
import { CHECKLISTS } from "./checklists.ts";

const inventory = (surfaces: string[]) => ({
  languages: ["TypeScript"],
  frameworks: [],
  surfaces,
  manifests: [],
});

describe("matchCategories", () => {
  it("maps repo surfaces to skill categories without duplicates", () => {
    expect(matchCategories(inventory(["web", "api", "container", "k8s", "supply-chain"]))).toEqual([
      "web",
      "api",
      "container",
      "supply-chain",
    ]);
  });

  it("matches nothing for a repo with no surface", () => {
    expect(matchCategories(inventory([]))).toEqual([]);
  });
});

describe("buildAssessmentFlow", () => {
  const spec = buildAssessmentFlow({
    name: "Cyber Security assessment",
    inventory: inventory(["web", "container"]),
    categories: ["web", "container"],
  });

  it("has one audit step per matched category feeding one report step", () => {
    expect(spec.nodes.map((node) => node.id)).toEqual([
      "audit-web",
      "audit-container",
      REPORT_NODE_ID,
    ]);
    expect(spec.edges).toEqual([
      { from: "audit-web", to: REPORT_NODE_ID },
      { from: "audit-container", to: REPORT_NODE_ID },
    ]);
  });

  it("puts the category's checklist in the prompt and attaches no skills", () => {
    expect(spec.nodes[1]?.prompt).toContain("Images and containers that run as root");
    for (const node of spec.nodes) expect(node.prompt).not.toMatch(/SKILL\.md/);
  });

  it("keeps every step report-only and ungated", () => {
    for (const node of spec.nodes) {
      expect(node.prompt).toMatch(/do not modify|Do not modify/);
      expect(node.gate).toBeUndefined();
    }
  });

  it("has a checklist for every category a surface can map to", () => {
    for (const category of new Set(Object.values(SURFACE_CATEGORY))) {
      expect(CHECKLISTS[category]?.length).toBeGreaterThan(0);
    }
  });
});
