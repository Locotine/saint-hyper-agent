import type { CyberFinding, ProjectDiscoveredScriptTarget } from "@saint/contracts";
import { LOCAL_HOST_ID, type HostId } from "@saint/shared/hostId";
import { describe, expect, it } from "vitest";

import {
  attentionItems,
  cyberSecurityHostSupported,
  buildFixPrompt,
  fixAllTargets,
  groupFindings,
  pickDynamicScript,
  stepOptions,
  sourceLabel,
} from "./cyberSecurity.logic";

const finding = (overrides: Partial<CyberFinding>): CyberFinding =>
  ({
    id: "a:1",
    projectId: "p",
    assessmentId: "a",
    title: "SQL injection in report filter",
    severity: "high",
    category: "web",
    file: "api/reports.ts",
    line: 42,
    detail: "User input reaches the query.",
    fix: "Bind the value.",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as CyberFinding;

describe("groupFindings", () => {
  it("puts findings in their status column, most severe first", () => {
    const columns = groupFindings([
      finding({ id: "1", severity: "low" }),
      finding({ id: "2", severity: "critical" }),
      finding({ id: "3", status: "resolved" }),
    ]);
    expect(columns.open.map((entry) => entry.id)).toEqual(["2", "1"]);
    expect(columns.resolved.map((entry) => entry.id)).toEqual(["3"]);
  });

  it("narrows to one severity", () => {
    const columns = groupFindings(
      [finding({ id: "1", severity: "low" }), finding({ id: "2" })],
      "high",
    );
    expect(columns.open.map((entry) => entry.id)).toEqual(["2"]);
  });
});

describe("fixAllTargets", () => {
  it("takes open and triaging findings at or above the threshold", () => {
    const targets = fixAllTargets(
      [
        finding({ id: "1", severity: "medium" }),
        finding({ id: "2", severity: "critical" }),
        finding({ id: "3", status: "fixing" }),
        finding({ id: "4", status: "triaging" }),
      ],
      "high",
    );
    expect(targets.map((entry) => entry.id)).toEqual(["2", "4"]);
  });
});

describe("buildFixPrompt", () => {
  it("names the location and keeps the fix small and uncommitted", () => {
    const prompt = buildFixPrompt([finding({})]);
    expect(prompt).toContain("[HIGH] SQL injection in report filter");
    expect(prompt).toContain("api/reports.ts:42");
    expect(prompt).toContain("Do not commit or push");
  });

  it("asks for severity order when there are several", () => {
    expect(buildFixPrompt([finding({}), finding({ id: "b:2" })])).toContain("one at a time");
  });
});

describe("sourceLabel", () => {
  it("names the scanner, or review for the model's own read", () => {
    expect(sourceLabel("scanner:trivy")).toBe("trivy");
    expect(sourceLabel("review")).toBe("review");
  });
});

describe("pickDynamicScript", () => {
  const pkg = (relativePath: string, names: string[]) =>
    ({
      cwd: `/p/${relativePath}`,
      relativePath,
      packageJsonPath: `/p/${relativePath}/package.json`,
      scripts: names.map((name) => ({ name, command: `npm run ${name}` })),
    }) as unknown as ProjectDiscoveredScriptTarget;

  it("prefers dev, then start, from the single package that has it", () => {
    expect(pickDynamicScript([pkg("", ["build", "start", "dev"])])).toEqual({
      ok: true,
      request: { packagePath: "", script: "dev" },
      command: "npm run dev",
    });
    expect(pickDynamicScript([pkg("api", ["start"]), pkg("web", ["build"])])).toMatchObject({
      ok: true,
      request: { packagePath: "api", script: "start" },
    });
  });

  it("takes the root script when several packages have one", () => {
    expect(pickDynamicScript([pkg("apps/web", ["dev"]), pkg("", ["dev"])])).toMatchObject({
      ok: true,
      request: { packagePath: "", script: "dev" },
    });
  });

  it("guesses nothing when the script is missing or in several packages", () => {
    expect(pickDynamicScript([])).toMatchObject({ ok: false });
    expect(pickDynamicScript([pkg("", ["build", "test"])])).toMatchObject({ ok: false });
    expect(pickDynamicScript([pkg("api", ["dev"]), pkg("web", ["dev"])])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Several packages"),
    });
  });
});

describe("attentionItems", () => {
  it("lists each distinct message once, in scanner order, and skips scanners with none", () => {
    expect(
      attentionItems([
        { label: "gitleaks", attention: "Install bubblewrap." },
        { label: "trivy", attention: "Install bubblewrap." },
        { label: "osv-scanner", attention: null },
        { label: "nuclei", attention: "  Allow github.com.  " },
      ]),
    ).toEqual([
      { label: "gitleaks", text: "Install bubblewrap." },
      { label: "nuclei", text: "Allow github.com." },
    ]);
    expect(attentionItems([])).toEqual([]);
  });
});

describe("cyberSecurityHostSupported", () => {
  it("accepts this computer and no remote host", () => {
    expect(cyberSecurityHostSupported(LOCAL_HOST_ID)).toBe(true);
    expect(cyberSecurityHostSupported("ac-ubuntu-3" as HostId)).toBe(false);
  });
});

describe("stepOptions", () => {
  it("lists the audit areas, then the scanners, with the ids start takes", () => {
    expect(stepOptions(["web"], [{ id: "trivy", label: "trivy · config" }])).toEqual([
      { id: "audit:web", label: "Audit: web" },
      { id: "scanner:trivy", label: "trivy · config" },
    ]);
  });
});
