import { describe, expect, it } from "vitest";

import { remoteInstallDepsHash, remoteInstallVersion } from "./remoteSshBundle";

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
  it("follows the npm manifest and patches but not the bundle", () => {
    const manifest = [entry("package.json", "{}"), entry("patches/index.tsv", "")];
    const hash = remoteInstallDepsHash([...manifest, entry("dist/index.mjs", "a")]);
    expect(hash).toMatch(/^[0-9a-f]{12}$/u);
    expect(remoteInstallDepsHash([...manifest, entry("dist/index.mjs", "b")])).toBe(hash);
    expect(
      remoteInstallDepsHash([
        entry("package.json", '{"dependencies":{}}'),
        entry("patches/index.tsv", ""),
      ]),
    ).not.toBe(hash);
  });
});
