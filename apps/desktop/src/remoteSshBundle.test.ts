import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  remoteDepsDescriptorPath,
  remoteDepsPackPath,
  remoteInstallBundleTree,
  remoteInstallDepsHash,
  remoteInstallDepsTrees,
  remoteInstallVersion,
} from "./remoteSshBundle";

const entry = (path: string, contents: string) => ({ path, contents: Buffer.from(contents) });

describe("remoteInstallVersion", () => {
  it("names the install after the app version and the bundle contents", () => {
    const version = remoteInstallVersion("1.0.9", [entry("dist/index.mjs", "a")]);
    expect(version).toMatch(/^1\.0\.9-[0-9a-f]{12}$/u);
  });

  it("changes when a rebuild keeps the app version but changes the bundle", () => {
    expect(remoteInstallVersion("1.0.9", [entry("dist/index.mjs", "a")])).not.toBe(
      remoteInstallVersion("1.0.9", [entry("dist/index.mjs", "b")]),
    );
    expect(remoteInstallVersion("1.0.9", [entry("dist/a.mjs", "x")])).not.toBe(
      remoteInstallVersion("1.0.9", [entry("dist/b.mjs", "x")]),
    );
  });

  it("does not depend on directory listing order", () => {
    const first = entry("dist/a.mjs", "a");
    const second = entry("package.json", "{}");
    expect(remoteInstallVersion("1.0.9", [first, second])).toBe(
      remoteInstallVersion("1.0.9", [second, first]),
    );
  });
});

describe("remoteInstallDepsHash", () => {
  it("names the dependency folder after the committed pack's sha256", () => {
    const sha256 = "a".repeat(12) + "b".repeat(52);
    expect(remoteInstallDepsHash(JSON.stringify({ sha256, dependencies: {} }))).toBe(
      "aaaaaaaaaaaa",
    );
  });

  it("refuses a descriptor without a sha256", () => {
    expect(() => remoteInstallDepsHash("{}")).toThrow(/no sha256/u);
    expect(() => remoteInstallDepsHash(JSON.stringify({ sha256: "xyz" }))).toThrow(/no sha256/u);
  });

  it("reads the descriptor committed in this checkout", () => {
    const appRoot = Path.resolve(import.meta.dirname, "../../..");
    const descriptor = FS.readFileSync(remoteDepsDescriptorPath(appRoot), "utf8");
    expect(remoteInstallDepsHash(descriptor)).toMatch(/^[0-9a-f]{12}$/u);
    expect(FS.existsSync(remoteDepsPackPath(appRoot))).toBe(true);
  });
});

describe("remote install tree hashes", () => {
  it("hashes the shipped files regardless of their order", () => {
    const a = entry("dist/index.mjs", "main");
    const b = entry("package.json", "{}");
    expect(remoteInstallBundleTree([a, b])).toBe(remoteInstallBundleTree([b, a]));
    expect(remoteInstallBundleTree([a, b])).not.toBe(
      remoteInstallBundleTree([entry("dist/index.mjs", "other"), b]),
    );
  });

  it("reads per-host dependency trees and drops malformed ones", () => {
    const good = "a".repeat(64);
    expect(
      remoteInstallDepsTrees(
        JSON.stringify({ trees: { "linux-x64": good, "darwin-arm64": "xyz" } }),
      ),
    ).toEqual({ "linux-x64": good });
    expect(remoteInstallDepsTrees("{}")).toEqual({});
  });

  it("has a tree for every host in the committed dependency descriptor", () => {
    const appRoot = Path.resolve(import.meta.dirname, "../../..");
    const descriptor = FS.readFileSync(remoteDepsDescriptorPath(appRoot), "utf8");
    expect(Object.keys(remoteInstallDepsTrees(descriptor)).toSorted()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
  });
});
