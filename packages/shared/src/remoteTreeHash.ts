// FILE: remoteTreeHash.ts
// Purpose: One hash of an install tree, computed the same way by the desktop (from the files it
//          ships), the artifact build (from the unpacked dependency pack) and the remote host
//          (from what is on its disk). A host that reuses an install another account published
//          runs only a tree whose hash matches the one its own desktop expects.
// Layer: Shared runtime utility (desktop main, the desktop artifact build, remote install script)
// Exports: REMOTE_TREE_HASH_SCRIPT, hashRemoteTreeEntries

import { createHash } from "node:crypto";

/**
 * Node source a remote host runs as `node -e <script> <dir> [<skipped path>...]`; it prints the
 * tree's hash. A skipped path is relative to `<dir>` and matches a file or folder at that exact
 * place. Regular files and symlink targets count; modes, times and empty folders do not.
 */
export const REMOTE_TREE_HASH_SCRIPT = String.raw`
const fs = require("fs");
const crypto = require("crypto");
const root = process.argv[1];
const skip = process.argv.slice(2);
const entries = [];
const walk = (dir, rel) => {
  for (const name of fs.readdirSync(dir)) {
    const path = rel ? rel + "/" + name : name;
    if (skip.includes(path)) continue;
    const abs = dir + "/" + name;
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory()) walk(abs, path);
    else if (stat.isSymbolicLink()) entries.push(["l", path, abs]);
    else if (stat.isFile()) entries.push(["f", path, abs]);
  }
};
walk(root, "");
entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
const hash = crypto.createHash("sha256");
for (const [type, path, abs] of entries) {
  hash.update(type + "\0" + path + "\0");
  hash.update(type === "l" ? fs.readlinkSync(abs) : fs.readFileSync(abs));
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
`;

/** The hash {@link REMOTE_TREE_HASH_SCRIPT} prints for a tree of exactly these regular files. */
export function hashRemoteTreeEntries(
  entries: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>,
): string {
  const hash = createHash("sha256");
  for (const entry of entries.toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(`f\0${entry.path}\0`).update(entry.contents).update("\0");
  }
  return hash.digest("hex");
}
