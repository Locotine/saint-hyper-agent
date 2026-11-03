import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGitleaks, parseHadolint, parseNuclei, parseOsv, parseSarif } from "./parsers.ts";

// Reports captured from the real binaries (gitleaks 8.30.1, hadolint 2.15.1, osv-scanner 2.7.0,
// trivy 0.76.1, nuclei 3.11.1 with nuclei-templates 10.5.1) scanning a deliberately vulnerable demo
// project, with the machine's paths replaced by /work/app. They pin the parsers to what the tools
// really print, not to a guess at their format.
const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const ROOT = "/work/app";

describe("real scanner output", () => {
  it("gitleaks: one finding per secret, none carrying its value", () => {
    const findings = parseGitleaks(fixture("gitleaks.json"), ROOT);
    expect(
      findings.map((finding) => [finding.title, finding.file, finding.line]).toSorted(),
    ).toEqual([
      ["Secret in source: aws-access-token", "src/leak.js", 2],
      ["Secret in source: generic-api-key", "src/leak.js", 3],
      ["Secret in source: github-pat", "src/leak.js", 4],
    ]);
    expect(JSON.stringify(findings)).not.toMatch(/AKIA|ghp_[A-Za-z0-9]{10}/u);
  });

  it("hadolint: rule codes with the Dockerfile line", () => {
    const findings = parseHadolint(fixture("hadolint.json"), ROOT);
    expect(findings.map((finding) => finding.title.slice(0, 6)).toSorted()).toEqual([
      "DL3007",
      "DL3008",
      "DL3009",
      "DL3015",
    ]);
    expect(findings.every((finding) => finding.file === "Dockerfile")).toBe(true);
    expect(findings.find((finding) => finding.title.startsWith("DL3007"))?.severity).toBe("medium");
  });

  it("osv-scanner: advisories for the vulnerable lockfile entries, worst first by severity", () => {
    const findings = parseOsv(fixture("osv-scanner.json"), ROOT);
    expect(findings).toHaveLength(8);
    expect(findings.every((finding) => finding.file === "package-lock.json")).toBe(true);
    expect(findings.every((finding) => finding.category === "supply-chain")).toBe(true);
    const packages = new Set(findings.map((finding) => finding.title.split(": ")[1]));
    expect(packages).toEqual(new Set(["lodash@4.17.15", "minimist@1.2.0"]));
    expect(findings.some((finding) => finding.severity === "critical")).toBe(true);
    expect(findings.find((finding) => finding.title.includes("lodash"))?.fix).toMatch(/Upgrade/u);
  });

  it("trivy (misconfig only): Dockerfile rules from the built-in checks", () => {
    const findings = parseSarif(fixture("trivy-misconfig.sarif"), ROOT);
    expect(findings.map((finding) => finding.title.split(":")[0]).toSorted()).toEqual([
      "DS-0001",
      "DS-0002",
      "DS-0026",
      "DS-0029",
    ]);
    expect(findings.every((finding) => finding.category === "container")).toBe(true);
    expect(findings.every((finding) => finding.file === "Dockerfile")).toBe(true);
  });

  it("nuclei: exposed .env and missing headers, path only, no response body", () => {
    const findings = parseNuclei(fixture("nuclei.jsonl"));
    const ids = findings.map((finding) => finding.title.split(":")[0]).toSorted();
    expect(ids).toEqual([
      "codeigniter-env",
      "http-missing-security-headers",
      "laravel-env",
      "tech-detect",
    ]);
    expect(findings.find((finding) => finding.title.startsWith("laravel-env"))?.severity).toBe(
      "high",
    );
    expect(JSON.stringify(findings)).not.toContain("hunter2");
  });
});
