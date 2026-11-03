import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  finalizeFindings,
  parseGitleaks,
  parseHadolint,
  parseNuclei,
  parseOsv,
  parseSarif,
  relativePath,
  SCANNER_FINDING_CAP,
} from "./parsers.ts";

const ROOT = "/work/app";

describe("parseGitleaks", () => {
  const report = JSON.stringify([
    {
      RuleID: "aws-access-token",
      Description: "AWS access token",
      File: "/work/app/src/config.js",
      StartLine: 7,
      Secret: "AKIAIOSFODNN7EXAMPLE",
      Match: "key = AKIAIOSFODNN7EXAMPLE",
    },
  ]);

  it("reports the rule, the project-relative file and line", () => {
    expect(parseGitleaks(report, ROOT)).toEqual([
      expect.objectContaining({
        title: "Secret in source: aws-access-token",
        severity: "high",
        category: "secrets",
        file: "src/config.js",
        line: 7,
      }),
    ]);
  });

  it("never keeps the secret's value", () => {
    expect(JSON.stringify(parseGitleaks(report, ROOT))).not.toContain("AKIA");
  });

  it("returns nothing for output that is not a report", () => {
    expect(parseGitleaks("not json", ROOT)).toEqual([]);
    expect(parseGitleaks("[]", ROOT)).toEqual([]);
  });
});

describe("parseOsv", () => {
  const report = JSON.stringify({
    results: [
      {
        source: { path: "/work/app/package.json", type: "lockfile" },
        packages: [
          {
            package: { name: "lodash", version: "4.17.4", ecosystem: "npm" },
            vulnerabilities: [
              {
                id: "GHSA-p6mc-m468-83gw",
                summary: "Prototype pollution in lodash",
                database_specific: { severity: "HIGH" },
                affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
              },
            ],
            groups: [{ ids: ["GHSA-p6mc-m468-83gw"], max_severity: "7.4" }],
          },
        ],
      },
    ],
  });

  it("makes one finding per package and advisory with the fixed version", () => {
    expect(parseOsv(report, ROOT)).toEqual([
      expect.objectContaining({
        title: "GHSA-p6mc-m468-83gw: lodash@4.17.4",
        severity: "high",
        category: "supply-chain",
        file: "package.json",
        fix: "Upgrade lodash to 4.17.21 or later.",
      }),
    ]);
  });

  it("falls back to the group's CVSS score when the advisory names no severity", () => {
    const withoutName = report.replace('"database_specific":{"severity":"HIGH"},', "");
    expect(parseOsv(withoutName, ROOT)[0]?.severity).toBe("high");
  });
});

describe("parseHadolint", () => {
  it("maps levels to severities and keeps the rule code", () => {
    const report = JSON.stringify([
      {
        code: "DL3002",
        message: "Last USER should not be root",
        file: "/work/app/Dockerfile",
        line: 9,
        level: "error",
      },
      {
        code: "DL3008",
        message: "Pin versions in apt-get install",
        file: "/work/app/Dockerfile",
        line: 4,
        level: "warning",
      },
    ]);
    expect(
      parseHadolint(report, ROOT).map((finding) => [
        finding.title.slice(0, 6),
        finding.severity,
        finding.file,
      ]),
    ).toEqual([
      ["DL3002", "high", "Dockerfile"],
      ["DL3008", "medium", "Dockerfile"],
    ]);
  });
});

describe("parseSarif", () => {
  const report = JSON.stringify({
    runs: [
      {
        tool: {
          driver: {
            rules: [
              {
                id: "CVE-2024-0001",
                shortDescription: { text: "Remote flaw in libfoo" },
                help: { text: "Upgrade libfoo to 2.0." },
                properties: { "security-severity": "9.8" },
              },
              { id: "AVD-DS-0002", shortDescription: { text: "Image user should not be root" } },
            ],
          },
        },
        results: [
          {
            ruleId: "CVE-2024-0001",
            level: "error",
            message: { text: "libfoo 1.2 is vulnerable" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "package-lock.json" },
                  region: { startLine: 12 },
                },
              },
            ],
          },
          {
            ruleId: "AVD-DS-0002",
            level: "warning",
            message: { text: "Specify a USER" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "Dockerfile" },
                  region: { startLine: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
  });

  it("uses the CVSS score for severity and the rule id for the area", () => {
    const [vuln, config] = parseSarif(report, ROOT);
    expect(vuln).toEqual(
      expect.objectContaining({
        severity: "critical",
        category: "supply-chain",
        file: "package-lock.json",
        line: 12,
        fix: "Upgrade libfoo to 2.0.",
      }),
    );
    expect(config).toEqual(
      expect.objectContaining({ severity: "medium", category: "container", file: "Dockerfile" }),
    );
  });
});

describe("finalizeFindings", () => {
  it("keeps the most severe findings up to the cap and counts the rest", () => {
    const many = Array.from({ length: SCANNER_FINDING_CAP + 5 }, (_, index) => ({
      title: `f${index}`,
      severity: index === 0 ? ("critical" as const) : ("low" as const),
      category: "supply-chain",
      file: null,
      line: null,
      detail: "",
      fix: "",
    }));
    const { kept, dropped } = finalizeFindings(many.toReversed());
    expect(kept).toHaveLength(SCANNER_FINDING_CAP);
    expect(kept[0]?.severity).toBe("critical");
    expect(dropped).toBe(5);
  });
});

describe("parseNuclei", () => {
  const line = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      "template-id": "exposed-env",
      info: {
        name: "Exposed .env file",
        severity: "high",
        description: "The .env file is served.",
        tags: ["exposure", "config"],
        remediation: "Do not serve dotfiles.",
      },
      "matched-at": "http://127.0.0.1:3000/.env",
      "matcher-name": "env",
      request: "GET /.env HTTP/1.1",
      response: "HTTP/1.1 200 OK\n\nDB_PASSWORD=hunter2-top-secret",
      "extracted-results": ["hunter2-top-secret"],
      "curl-command": "curl http://127.0.0.1:3000/.env",
      ...overrides,
    });

  it("reads the template's own words and reduces the URL to its path", () => {
    const [finding] = parseNuclei(`${line()}\n`);
    expect(finding).toEqual({
      title: "exposed-env: Exposed .env file",
      severity: "high",
      category: "info-exposure",
      file: "/.env",
      line: null,
      detail: "The .env file is served. Seen on the running app at /.env (env).",
      fix: "Do not serve dotfiles.",
    });
  });

  it("never keeps a request, a response body or an extracted value", () => {
    const text = JSON.stringify(parseNuclei(line()));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("DB_PASSWORD");
    expect(text).not.toContain("curl");
  });

  it("skips malformed lines, merges repeats and maps severities and areas", () => {
    const findings = parseNuclei(
      [
        "not json",
        "{}",
        line(),
        line(),
        line({
          "template-id": "cve-x",
          info: { name: "A CVE", severity: "critical", tags: ["cve"] },
        }),
        line({ "template-id": "tech", info: { name: "Detect", severity: "info", tags: ["tech"] } }),
        line({
          "template-id": "cfg",
          info: { name: "Bad header", severity: "unknown", tags: ["misconfig"] },
        }),
      ].join("\n"),
    );
    expect(findings.map((finding) => [finding.title, finding.severity, finding.category])).toEqual([
      ["exposed-env: Exposed .env file", "high", "info-exposure"],
      ["cve-x: A CVE", "critical", "supply-chain"],
      ["tech: Detect", "low", "info-exposure"],
      ["cfg: Bad header", "low", "misconfiguration"],
    ]);
  });
});

describe("file paths on every platform", () => {
  it.each([
    ["posix path", path.posix, "/proj", "/proj/src/a.js", "src/a.js"],
    ["posix file URI", path.posix, "/proj", "file:///proj/Dockerfile", "Dockerfile"],
    ["posix path outside the folder", path.posix, "/proj", "/etc/passwd", "/etc/passwd"],
    ["already relative", path.posix, "/proj", "src/a.js", "src/a.js"],
    ["windows path", path.win32, "C:\\proj", "C:\\proj\\src\\a.js", "src/a.js"],
    ["windows drive letter case", path.win32, "C:\\Proj", "c:\\proj\\src\\a.js", "src/a.js"],
    ["windows forward slashes", path.win32, "C:\\proj", "C:/proj/src/a.js", "src/a.js"],
    ["windows file URI", path.win32, "C:\\proj", "file:///C:/proj/Dockerfile", "Dockerfile"],
    ["windows relative path", path.win32, "C:\\proj", "src\\a.js", "src/a.js"],
    ["windows other drive", path.win32, "C:\\proj", "D:\\other\\a.js", "D:/other/a.js"],
    ["windows parent folder", path.win32, "C:\\proj", "..\\a.js", "../a.js"],
  ])("%s", (_name, pathApi, root, file, expected) => {
    expect(relativePath(root, file, pathApi)).toBe(expected);
  });

  it("keeps a file name that merely starts with two dots", () => {
    expect(relativePath("/proj", "/proj/..hidden", path.posix)).toBe("..hidden");
  });

  it("reads Windows paths in every scanner's report", () => {
    const root = "C:\\proj";
    expect(
      parseGitleaks(
        JSON.stringify([{ RuleID: "k", File: "C:\\proj\\src\\leak.js", StartLine: 2 }]),
        root,
        path.win32,
      )[0],
    ).toMatchObject({ file: "src/leak.js", line: 2 });
    expect(
      parseHadolint(
        JSON.stringify([
          { code: "DL3007", file: "C:\\proj\\Dockerfile", line: 1, level: "warning" },
        ]),
        root,
        path.win32,
      )[0],
    ).toMatchObject({ file: "Dockerfile" });
    expect(
      parseOsv(
        JSON.stringify({
          results: [
            {
              source: { path: "C:\\proj\\package-lock.json" },
              packages: [
                {
                  package: { name: "left-pad", version: "1.0.0" },
                  vulnerabilities: [{ id: "GHSA-1", summary: "bad" }],
                },
              ],
            },
          ],
        }),
        root,
        path.win32,
      )[0],
    ).toMatchObject({ file: "package-lock.json" });
    expect(
      parseSarif(
        JSON.stringify({
          runs: [
            {
              results: [
                {
                  ruleId: "DS002",
                  message: { text: "root" },
                  locations: [
                    {
                      physicalLocation: {
                        artifactLocation: { uri: "file:///C:/proj/Dockerfile" },
                        region: { startLine: 3 },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        root,
        undefined,
        path.win32,
      )[0],
    ).toMatchObject({ file: "Dockerfile", line: 3, category: "container" });
  });
});
