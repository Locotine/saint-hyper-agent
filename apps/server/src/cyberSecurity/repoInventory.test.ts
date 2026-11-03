import { describe, expect, it } from "vitest";

import { classifyRepo } from "./repoInventory.ts";

const manifests = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("classifyRepo", () => {
  it("finds the web, api, auth and supply-chain surfaces of a node web app", () => {
    const inventory = classifyRepo(
      ["package.json", "src/server.ts", "src/app.tsx"],
      manifests({
        "package.json": JSON.stringify({
          dependencies: { express: "^4", next: "14", jsonwebtoken: "9", "react-dom": "18" },
        }),
      }),
    );
    expect(inventory.languages).toEqual(["TypeScript"]);
    expect(inventory.frameworks).toEqual(["Express", "Next.js", "React"]);
    expect(inventory.surfaces).toEqual(["web", "api", "auth", "supply-chain"]);
  });

  it("finds container, k8s, cloud and cicd from marker files", () => {
    const inventory = classifyRepo(
      ["Dockerfile", "deploy/k8s/app.yaml", "infra/main.tf", ".github/workflows/ci.yml", "main.go"],
      manifests({}),
    );
    expect(inventory.languages).toEqual(["Go"]);
    expect(inventory.surfaces).toEqual(["container", "k8s", "cloud", "cicd"]);
    expect(inventory.surfaces).not.toContain("web");
  });

  it("does not take a longer package name for the framework it contains", () => {
    const inventory = classifyRepo(
      ["package.json"],
      manifests({ "package.json": '{"dependencies":{"express-session":"1","nextjs-toast":"1"}}' }),
    );
    expect(inventory.frameworks).toEqual([]);
    expect(inventory.surfaces).toEqual(["supply-chain"]);
  });

  it("finds native code, scripts, exposed files and network config from file names", () => {
    const inventory = classifyRepo(
      [
        "src/parser.c",
        "deploy/install.sh",
        ".env",
        ".env.example",
        "app.js.map",
        "conf/nginx.conf",
      ],
      manifests({}),
    );
    expect(inventory.surfaces).toEqual(["native", "scripts", "exposure", "network"]);
  });

  it("finds a directory service from its client dependency", () => {
    const inventory = classifyRepo(
      ["package.json"],
      manifests({ "package.json": '{"dependencies":{"ldapjs":"3"}}' }),
    );
    expect(inventory.surfaces).toEqual(["supply-chain", "directory"]);
  });

  it("returns no surface for a repo with no source or manifest", () => {
    expect(classifyRepo(["notes.txt"], manifests({})).surfaces).toEqual([]);
  });
});
