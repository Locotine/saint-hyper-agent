// FILE: repoInventory.ts
// Purpose: Detect phase of a Cyber Security assessment — fingerprints a repo from its file names
//          and dependency manifests (no model involved) so the audit runs only for the surfaces
//          the repo really has.
// Layer: Server cyber security (pure classifier + bounded filesystem scan)
// Exports: classifyRepo, detectRepoInventory, REPO_SURFACES

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CyberRepoInventory } from "@saint/contracts";

const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "coverage",
  ".turbo",
]);
const MAX_FILES = 6_000;
const MAX_DEPTH = 7;
const MAX_MANIFEST_BYTES = 200_000;

const MANIFEST_NAMES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "pipfile",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "composer.json",
  "pubspec.yaml",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
  c: "C/C++",
  cc: "C/C++",
  cpp: "C/C++",
  h: "C/C++",
  ex: "Elixir",
  exs: "Elixir",
};

/**
 * A dependency name in any manifest → the framework it names and the surfaces it implies. A needle
 * matches a whole package name; `loose` also accepts it as part of a longer name (`@scope/x-y`).
 */
const DEPENDENCY_SIGNALS: ReadonlyArray<{
  readonly needle: string;
  readonly framework: string | null;
  readonly surfaces: ReadonlyArray<string>;
  readonly loose?: boolean;
}> = [
  { needle: "express", framework: "Express", surfaces: ["web", "api"] },
  { needle: "fastify", framework: "Fastify", surfaces: ["api"] },
  { needle: "koa", framework: "Koa", surfaces: ["api"] },
  { needle: "hono", framework: "Hono", surfaces: ["api"] },
  { needle: "@nestjs/", framework: "NestJS", surfaces: ["api"], loose: true },
  { needle: "next", framework: "Next.js", surfaces: ["web"] },
  { needle: "react-dom", framework: "React", surfaces: ["web"] },
  { needle: "vue", framework: "Vue", surfaces: ["web"] },
  { needle: "svelte", framework: "Svelte", surfaces: ["web"], loose: true },
  { needle: "@angular/core", framework: "Angular", surfaces: ["web"] },
  { needle: "django", framework: "Django", surfaces: ["web"] },
  { needle: "djangorestframework", framework: null, surfaces: ["api"] },
  { needle: "flask", framework: "Flask", surfaces: ["web", "api"] },
  { needle: "fastapi", framework: "FastAPI", surfaces: ["api"] },
  { needle: "rails", framework: "Rails", surfaces: ["web"] },
  { needle: "laravel", framework: "Laravel", surfaces: ["web"], loose: true },
  { needle: "spring-boot", framework: "Spring Boot", surfaces: ["web", "api"], loose: true },
  { needle: "gin-gonic", framework: "Gin", surfaces: ["api"], loose: true },
  { needle: "axum", framework: "Axum", surfaces: ["api"] },
  { needle: "actix-web", framework: "Actix", surfaces: ["api"] },
  { needle: "graphql", framework: "GraphQL", surfaces: ["api"], loose: true },
  { needle: "jsonwebtoken", framework: null, surfaces: ["auth"] },
  { needle: "jose", framework: null, surfaces: ["auth"] },
  { needle: "passport", framework: "Passport", surfaces: ["auth"], loose: true },
  { needle: "next-auth", framework: "NextAuth", surfaces: ["auth"] },
  { needle: "oauth", framework: null, surfaces: ["auth"], loose: true },
  { needle: "pyjwt", framework: null, surfaces: ["auth"] },
  { needle: "authlib", framework: null, surfaces: ["auth"] },
  { needle: "bcrypt", framework: null, surfaces: ["crypto"], loose: true },
  { needle: "argon2", framework: null, surfaces: ["crypto"], loose: true },
  { needle: "node-forge", framework: null, surfaces: ["crypto"] },
  { needle: "crypto-js", framework: null, surfaces: ["crypto"] },
  { needle: "cryptography", framework: null, surfaces: ["crypto"] },
  { needle: "pycryptodome", framework: null, surfaces: ["crypto"], loose: true },
  { needle: "tweetnacl", framework: null, surfaces: ["crypto"] },
  { needle: "libsodium", framework: null, surfaces: ["crypto"], loose: true },
  { needle: "aws-sdk", framework: null, surfaces: ["cloud"], loose: true },
  { needle: "boto3", framework: null, surfaces: ["cloud"] },
  { needle: "google-cloud", framework: null, surfaces: ["cloud"], loose: true },
  { needle: "azure", framework: null, surfaces: ["cloud"], loose: true },
  { needle: "openai", framework: null, surfaces: ["ai"], loose: true },
  { needle: "anthropic", framework: null, surfaces: ["ai"], loose: true },
  { needle: "langchain", framework: "LangChain", surfaces: ["ai"], loose: true },
  { needle: "llama-index", framework: null, surfaces: ["ai"], loose: true },
  { needle: "llamaindex", framework: null, surfaces: ["ai"], loose: true },
  { needle: "transformers", framework: null, surfaces: ["ai"], loose: true },
  { needle: "@ai-sdk/", framework: null, surfaces: ["ai"], loose: true },
  { needle: "react-native", framework: "React Native", surfaces: ["mobile"] },
  { needle: "ldap", framework: null, surfaces: ["directory"], loose: true },
  { needle: "kerberos", framework: null, surfaces: ["directory"], loose: true },
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SIGNAL_PATTERNS = DEPENDENCY_SIGNALS.map((signal) => ({
  signal,
  pattern: new RegExp(
    signal.loose
      ? escapeRegExp(signal.needle)
      : `(?<![a-z0-9_-])${escapeRegExp(signal.needle)}(?![a-z0-9_-])`,
  ),
}));

export const REPO_SURFACES = [
  "web",
  "api",
  "auth",
  "crypto",
  "container",
  "k8s",
  "cloud",
  "cicd",
  "supply-chain",
  "ai",
  "mobile",
  "iot",
  "native",
  "scripts",
  "exposure",
  "network",
  "directory",
] as const;

const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1).toLowerCase();
const extensionOf = (file: string) => {
  const name = baseName(file);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
};

/**
 * Pure classifier. `files` are repo-relative POSIX paths; `manifestTexts` maps a manifest's path to
 * its text. The result is deterministic, so the same repo always matches the same skills.
 */
export function classifyRepo(
  files: ReadonlyArray<string>,
  manifestTexts: ReadonlyMap<string, string>,
): CyberRepoInventory {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const surfaces = new Set<string>();
  const markers = new Set<string>();

  for (const file of files) {
    const name = baseName(file);
    const language = LANGUAGE_BY_EXTENSION[extensionOf(file)];
    if (language) languages.add(language);

    const mark = (surface: string) => {
      surfaces.add(surface);
      if (markers.size < 30) markers.add(file);
    };
    if (
      name === "dockerfile" ||
      name.startsWith("dockerfile.") ||
      /^(docker-)?compose\.ya?ml$/.test(name) ||
      /^docker-compose.*\.ya?ml$/.test(name)
    ) {
      mark("container");
    }
    if (
      name === "chart.yaml" ||
      name === "kustomization.yaml" ||
      /(^|\/)(k8s|kubernetes|helm|charts)\//.test(file.toLowerCase())
    ) {
      mark("k8s");
    }
    if (
      name.endsWith(".tf") ||
      name.endsWith(".tfvars") ||
      name === "serverless.yml" ||
      name === "serverless.yaml" ||
      name === "cdk.json" ||
      name === "pulumi.yaml"
    ) {
      mark("cloud");
    }
    if (
      /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file) ||
      name === ".gitlab-ci.yml" ||
      name === "jenkinsfile" ||
      name === "azure-pipelines.yml" ||
      name === "bitbucket-pipelines.yml" ||
      /(^|\/)\.circleci\/config\.yml$/.test(file)
    ) {
      mark("cicd");
    }
    if (
      name === "androidmanifest.xml" ||
      name === "info.plist" ||
      name === "pubspec.yaml" ||
      /\.xcodeproj\//.test(file)
    ) {
      mark("mobile");
    }
    if (name === "platformio.ini" || name.endsWith(".ino") || name === "sdkconfig") mark("iot");
    const extension = extensionOf(file);
    if (["c", "cc", "cpp", "cxx", "h", "hpp", "rs", "zig"].includes(extension)) {
      surfaces.add("native");
    }
    if (
      ["sh", "bash", "service", "timer"].includes(extension) ||
      name === "sudoers" ||
      name === "crontab"
    ) {
      mark("scripts");
    }
    if (
      (name.startsWith(".env") && !/\.(example|sample|template)$/.test(name)) ||
      ["map", "bak", "old", "pem", "key", "p12", "pfx", "dump"].includes(extension) ||
      ["id_rsa", "id_ed25519", ".htpasswd"].includes(name)
    ) {
      mark("exposure");
    }
    if (
      ["nginx.conf", "httpd.conf", "apache2.conf", "haproxy.cfg", "caddyfile"].includes(name) ||
      /^(envoy|traefik)\.ya?ml$/.test(name)
    ) {
      mark("network");
    }
    if (/^(openapi|swagger)\.(ya?ml|json)$/.test(name) || name.endsWith(".proto")) mark("api");
    if (["html", "ejs", "hbs", "pug", "vue", "svelte", "erb", "twig"].includes(extensionOf(file))) {
      surfaces.add("web");
    }
  }

  for (const [manifest, text] of manifestTexts) {
    surfaces.add("supply-chain");
    if (markers.size < 30) markers.add(manifest);
    const lower = text.toLowerCase();
    for (const { signal, pattern } of SIGNAL_PATTERNS) {
      if (!pattern.test(lower)) continue;
      if (signal.framework) frameworks.add(signal.framework);
      for (const surface of signal.surfaces) surfaces.add(surface);
    }
  }

  return {
    languages: [...languages].toSorted(),
    frameworks: [...frameworks].toSorted(),
    surfaces: REPO_SURFACES.filter((surface) => surfaces.has(surface)),
    manifests: [...markers].toSorted(),
  };
}

/** Bounded walk of `root` (skips dependency and build folders), then {@link classifyRepo}. */
export async function detectRepoInventory(root: string): Promise<CyberRepoInventory> {
  const files: string[] = [];
  const queue: Array<{ readonly dir: string; readonly depth: number }> = [{ dir: "", depth: 0 }];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && depth < MAX_DEPTH) {
          queue.push({ dir: relative, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        files.push(relative);
        if (files.length >= MAX_FILES) break;
      }
    }
  }

  const manifestTexts = new Map<string, string>();
  for (const file of files) {
    if (!MANIFEST_NAMES.has(baseName(file)) || manifestTexts.size >= 40) continue;
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (text !== null) manifestTexts.set(file, text.slice(0, MAX_MANIFEST_BYTES));
  }
  return classifyRepo(files, manifestTexts);
}
