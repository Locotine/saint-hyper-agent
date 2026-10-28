#!/usr/bin/env node
// FILE: build-remote-deps-pack.ts
// Purpose: Refreshes the committed remote SSH dependency pack (apps/server/remote-deps).
// Usage: bun run remote:deps-pack [--check] [--verbose]
//        Run after changing a remote server dependency, its patch, or bun.lock; needs npm
//        and the registry. `--check` only reports whether the committed pack is current.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRemoteDepsPack,
  checkRemoteDepsPack,
  REMOTE_DEPS_DIR,
  REMOTE_DEPS_REBUILD_HINT,
} from "./lib/remote-deps-pack.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));

if (args.has("--check")) {
  const problems = checkRemoteDepsPack(repoRoot);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(REMOTE_DEPS_REBUILD_HINT);
    process.exit(1);
  }
  console.log(`${REMOTE_DEPS_DIR} is current.`);
} else {
  const outDir = resolve(join(repoRoot, REMOTE_DEPS_DIR));
  const lock = buildRemoteDepsPack(repoRoot, outDir, { verbose: args.has("--verbose") });
  console.log(`Wrote ${REMOTE_DEPS_DIR} (sha256 ${lock.sha256}).`);
}
