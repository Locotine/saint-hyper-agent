// FILE: registry.ts
// Purpose: The scanners an assessment can run: what each one covers, how to call it, and how to
//          read its output. Each is a separate program started as a subprocess, so none of them
//          goes through a model prompt.
// Layer: Server cyber security scanners
// Exports: SCANNERS, applicableScanners, resolveScannerBinary, ScannerDef

import path from "node:path";

import type { CyberRepoInventory } from "@saint/contracts";
import { resolveExecutable } from "@saint/shared/executable";

import type { ParsedFinding } from "../findings.ts";
import { installedToolDir } from "./install.ts";
import type { LocalTarget } from "./dynamicTarget.ts";
import { parseGitleaks, parseHadolint, parseNuclei, parseOsv, parseSarif } from "./parsers.ts";

export interface ScannerContext {
  /** The project folder being scanned (read-only). */
  readonly root: string;
  /** A scratch folder the scanner may write its report into. */
  readonly scratch: string;
  readonly inventory: CyberRepoInventory;
  /** Dynamic scanners only: the localhost address of the running app and the templates to use. */
  readonly target?: LocalTarget;
  readonly templates?: string;
}

export interface ScannerInvocation {
  readonly args: ReadonlyArray<string>;
  /** Set when the scanner writes its report to a file instead of stdout. */
  readonly outputFile?: string;
}

export interface ScannerDef {
  readonly id: string;
  readonly label: string;
  /** The executable name; looked up in the shipped scanner folder, then on PATH. */
  readonly bin: string;
  /** Inventory surfaces that make it worth running; `*` means every project. */
  readonly surfaces: ReadonlyArray<string>;
  /** Needs the network (vulnerability databases), so it runs only in online mode. */
  readonly network: boolean;
  /** The only hosts a network scanner may reach (its vulnerability and rules databases). */
  readonly egress: ReadonlyArray<string>;
  /**
   * Attacks the running app instead of reading files: runs only for a confirmed, gated run, against
   * a localhost address, and never touches the network beyond that one port.
   */
  readonly dynamic?: boolean;
  /** Exit codes, besides 0, that mean "ran fine, nothing to report" when it writes no report. */
  readonly emptyExitCodes?: ReadonlyArray<number>;
  /** Null when there is nothing for it to scan in this project. */
  readonly invocation: (context: ScannerContext) => ScannerInvocation | null;
  readonly parse: (output: string, context: ScannerContext) => ParsedFinding[];
}

const dockerfiles = (context: ScannerContext) =>
  context.inventory.manifests
    .filter((entry) => /(^|\/)(dockerfile[^/]*|[^/]+\.dockerfile)$/i.test(entry))
    .map((entry) => path.join(context.root, entry));

export const SCANNERS: ReadonlyArray<ScannerDef> = [
  {
    id: "gitleaks",
    label: "gitleaks · secrets",
    bin: "gitleaks",
    surfaces: ["*"],
    network: false,
    egress: [],
    invocation: (context) => {
      const outputFile = path.join(context.scratch, "gitleaks.json");
      return {
        args: [
          "detect",
          "--source",
          context.root,
          "--no-git",
          "--no-banner",
          "--redact",
          "--exit-code",
          "0",
          "--report-format",
          "json",
          "--report-path",
          outputFile,
        ],
        outputFile,
      };
    },
    parse: (output, context) => parseGitleaks(output, context.root),
  },
  {
    id: "hadolint",
    label: "hadolint · Dockerfile",
    bin: "hadolint",
    surfaces: ["container"],
    network: false,
    egress: [],
    invocation: (context) => {
      const files = dockerfiles(context);
      return files.length > 0 ? { args: ["--format", "json", "--no-fail", ...files] } : null;
    },
    parse: (output, context) => parseHadolint(output, context.root),
  },
  {
    id: "osv-scanner",
    label: "osv-scanner · dependencies",
    bin: "osv-scanner",
    surfaces: ["supply-chain"],
    network: true,
    egress: ["api.osv.dev", "osv.dev"],
    invocation: (context) => ({
      args: ["scan", "source", "--recursive", "--format", "json", context.root],
    }),
    parse: (output, context) => parseOsv(output, context.root),
    // 128: no package sources found in the project, which is a clean result.
    emptyExitCodes: [128],
  },
  {
    id: "trivy",
    label: "trivy · Dockerfile, IaC, Kubernetes",
    bin: "trivy",
    surfaces: ["*"],
    // Misconfiguration only. Its rules are built into the binary, so it needs no vulnerability
    // database (1.6 GB) and no network; dependency CVEs are osv-scanner's job.
    network: false,
    egress: [],
    invocation: (context) => {
      const outputFile = path.join(context.scratch, "trivy.sarif");
      return {
        args: [
          "fs",
          "--quiet",
          "--no-progress",
          "--skip-version-check",
          "--skip-check-update",
          "--scanners",
          "misconfig",
          "--format",
          "sarif",
          "--output",
          outputFile,
          context.root,
        ],
        outputFile,
      };
    },
    parse: (output, context) => parseSarif(output, context.root),
  },
  {
    id: "nuclei",
    label: "nuclei · running app",
    bin: "nuclei",
    surfaces: ["web", "api"],
    network: false,
    egress: [],
    dynamic: true,
    invocation: (context) => {
      if (!context.target || !context.templates) return null;
      const outputFile = path.join(context.scratch, "nuclei.jsonl");
      return {
        args: [
          "-u",
          context.target.url,
          "-jsonl",
          "-o",
          outputFile,
          "-silent",
          "-nc",
          // No update check, no template download (they come from the shipped folder), no
          // out-of-band callbacks, and redirects are not followed.
          "-duc",
          "-ni",
          "-t",
          context.templates,
          // The safe profile: read-only HTTP checks, never the intrusive, fuzzing or brute-force ones.
          "-pt",
          "http",
          // No `cve`: v10.5.1 has ~4,400 checks for specific CVEs of other products (WordPress
          // plugins, routers...) that almost never apply to the app under test. Measured against
          // a localhost demo with real templates: with them 6,902 templates took 69 s, without them
          // 3,153 took 25 s and still found the exposed .env and the missing security headers.
          "-tags",
          "tech,exposure,misconfig",
          "-etags",
          "dos,fuzz,intrusive,bruteforce,brute-force",
          // The target is the person's own app on localhost, so a higher rate is fine; 25/s was
          // too slow to finish within the five-minute limit on the full filter.
          "-rl",
          "150",
          "-c",
          "30",
          "-timeout",
          "5",
          "-retries",
          "0",
          "-mhe",
          "10",
        ],
        outputFile,
      };
    },
    parse: (output) => parseNuclei(output),
  },
];

/** The scanners worth running for this project. */
export function applicableScanners(inventory: CyberRepoInventory): ReadonlyArray<ScannerDef> {
  return SCANNERS.filter(
    (scanner) =>
      scanner.surfaces.includes("*") ||
      scanner.surfaces.some((surface) => inventory.surfaces.includes(surface)),
  );
}

/**
 * The executable to run: the copy shipped with the app (`SAINT_SCANNER_DIR`), then the one this
 * machine fetched on first use (`toolsDir`), then PATH. Null when none has it.
 */
export function resolveScannerBinary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  toolsDir?: string,
): string | null {
  const shipped = env.SAINT_SCANNER_DIR?.trim();
  if (shipped) {
    const found = resolveExecutable(bin, { env: { ...env, PATH: shipped } });
    if (found) return found;
  }
  if (toolsDir) {
    const fetched = resolveExecutable(bin, {
      env: { ...env, PATH: installedToolDir(toolsDir, bin) },
    });
    if (fetched) return fetched;
  }
  return resolveExecutable(bin, { env });
}
