#!/usr/bin/env node
// FILE: run-with-rust.mjs
// Purpose: Ensures `~/.cargo/bin` and WinGet LLVM-MinGW bin directories are on PATH
//          even in existing terminal sessions, then runs `cargo` or `@tauri-apps/cli`.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function findLlvmMingwBinDirs() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const packagesRoot = join(localAppData, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packagesRoot)) return [];
  const dirs = [];
  for (const pkg of readdirSync(packagesRoot)) {
    if (!pkg.startsWith("MartinStorsjo.LLVM-MinGW")) continue;
    const pkgPath = join(packagesRoot, pkg);
    for (const child of readdirSync(pkgPath)) {
      const binDir = join(pkgPath, child, "bin");
      if (existsSync(binDir)) dirs.push(binDir);
    }
  }
  return dirs;
}

const candidateDirs = [
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "mise", "installs", "bun", "1.4.4", "bin")
    : null,
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "mise", "installs", "node", "24.13.1")
    : null,
  join(homedir(), ".cargo", "bin"),
  ...findLlvmMingwBinDirs(),
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links") : null,
].filter((dir) => typeof dir === "string" && existsSync(dir));

const currentPath = process.env.PATH ?? process.env.Path ?? "";
const pathEntries = currentPath.split(delimiter);
const missingDirs = candidateDirs.filter((dir) => !pathEntries.includes(dir));

if (missingDirs.length > 0) {
  const nextPath = [...missingDirs, currentPath].join(delimiter);
  process.env.PATH = nextPath;
  process.env.Path = nextPath;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/run-with-rust.mjs <command> [...args]");
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
