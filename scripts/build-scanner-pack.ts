#!/usr/bin/env node
// FILE: build-scanner-pack.ts
// Purpose: Refreshes the committed security-scanner pack (apps/server/scanner-pack).
// Usage: bun run scanners:pack [--update-pins | --check] [--host=<platform-arch> | --all]
//        --update-pins  fetch each project's published checksum file into packages/shared/src/scannerPins.json
//                       (review the diff before building)
//        --check        only report whether the pack is current
//        (default)      download the pinned releases, verify them, and write the pack (needs network)
//        Scope of a build or check: the machine's own platform-arch by default, so only that
//        host's binaries are downloaded; --host=<h> picks another (repeat or comma-separate),
//        --all covers every host (release builds). --out=<dir> reads/writes the pack there
//        instead of apps/server/scanner-pack.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildScannerPack,
  checkScannerPack,
  currentScannerHost,
  SCANNER_HOSTS,
  type ScannerHost,
  SCANNER_PACK_DIR,
  SCANNER_PACK_REBUILD_HINT,
  updateScannerPins,
} from "./lib/scanner-pack.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);

const outArg = argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const packDir = resolve(outArg ?? join(repoRoot, SCANNER_PACK_DIR));

/** `--all`, else every `--host=` value, else the host this machine is. */
function selectedHosts(): readonly ScannerHost[] {
  if (args.has("--all")) return SCANNER_HOSTS;
  const requested = argv
    .filter((arg) => arg.startsWith("--host="))
    .flatMap((arg) => arg.slice("--host=".length).split(","))
    .filter(Boolean);
  if (requested.length === 0) return [currentScannerHost()];
  const unknown = requested.filter((host) => !SCANNER_HOSTS.some((known) => known === host));
  if (unknown.length > 0) {
    throw new Error(`Unknown scanner host ${unknown.join(", ")}; use ${SCANNER_HOSTS.join(", ")}.`);
  }
  return SCANNER_HOSTS.filter((known) => requested.includes(known));
}

if (args.has("--check")) {
  const problems = checkScannerPack(repoRoot, packDir, selectedHosts());
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(SCANNER_PACK_REBUILD_HINT);
    process.exit(1);
  }
  console.log(`${packDir} is current.`);
} else if (args.has("--update-pins")) {
  await updateScannerPins(repoRoot);
  console.log(
    "Updated packages/shared/src/scannerPins.json; review the diff, then run `bun run scanners:pack`.",
  );
} else {
  const hosts = selectedHosts();
  console.log(`Building the scanner pack for ${hosts.join(", ")} only.`);
  const lock = await buildScannerPack(repoRoot, packDir, {
    log: (message) => console.log(message),
    hosts,
  });
  console.log(`Wrote ${packDir} (pack ${lock.version}).`);
}
