import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hashRemoteTreeEntries, REMOTE_TREE_HASH_SCRIPT } from "./remoteTreeHash";

const hashDirectory = (dir: string, ...skip: string[]) =>
  execFileSync(process.execPath, ["-e", REMOTE_TREE_HASH_SCRIPT, dir, ...skip], {
    encoding: "utf8",
  });

function withTree(files: Record<string, string>, run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "saint-tree-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("remote tree hash", () => {
  const files = { "dist/index.mjs": "main", "dist/a/b.mjs": "deep", "package.json": "{}" };
  const entries = Object.entries(files).map(([path, contents]) => ({
    path,
    contents: Buffer.from(contents),
  }));

  it("matches between the desktop's files and the tree on disk", () => {
    withTree(files, (dir) => {
      expect(hashDirectory(dir)).toBe(hashRemoteTreeEntries(entries));
    });
  });

  it("ignores skipped paths and tells a changed, added or removed file apart", () => {
    withTree({ ...files, ".installed": "" }, (dir) => {
      expect(hashDirectory(dir, ".installed")).toBe(hashRemoteTreeEntries(entries));
      writeFileSync(join(dir, "dist/index.mjs"), "tampered");
      expect(hashDirectory(dir, ".installed")).not.toBe(hashRemoteTreeEntries(entries));
    });
    withTree({ ...files, "dist/extra.mjs": "planted" }, (dir) => {
      expect(hashDirectory(dir)).not.toBe(hashRemoteTreeEntries(entries));
    });
    withTree({ "package.json": "{}" }, (dir) => {
      expect(hashDirectory(dir)).not.toBe(hashRemoteTreeEntries(entries));
    });
  });

  it("counts a symlink's target, not the file it points to", () => {
    withTree({ "a.txt": "x" }, (dir) => {
      symlinkSync("a.txt", join(dir, "link"));
      const before = hashDirectory(dir);
      rmSync(join(dir, "link"));
      symlinkSync("elsewhere", join(dir, "link"));
      expect(hashDirectory(dir)).not.toBe(before);
    });
  });
});
