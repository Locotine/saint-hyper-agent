#!/usr/bin/env node
// FILE: run-with-rust.mjs
// Purpose: Ensures `~/.cargo/bin` and WinGet LLVM-MinGW bin directories are on PATH
//          even in existing terminal sessions, installs a missing Rust toolchain and Linux
//          Tauri system packages, then runs `cargo` or `@tauri-apps/cli`.

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

function findMiseDirs() {
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "mise") : null,
    join(homedir(), ".local", "share", "mise"),
  ].filter((root) => typeof root === "string" && existsSync(root));

  const dirs = [];
  for (const root of roots) {
    const shimsDir = join(root, "shims");
    if (existsSync(shimsDir)) dirs.push(shimsDir);
    for (const [tool, subDir] of [
      ["bun", "bin"],
      ["node", "bin"],
      ["node", ""],
    ]) {
      const toolRoot = join(root, "installs", tool);
      if (!existsSync(toolRoot)) continue;
      const versions = readdirSync(toolRoot).sort().reverse();
      for (const version of versions) {
        const candidate = subDir ? join(toolRoot, version, subDir) : join(toolRoot, version);
        if (existsSync(candidate)) dirs.push(candidate);
      }
    }
  }
  return dirs;
}

const candidateDirs = [
  ...findMiseDirs(),
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

function commandExists(name) {
  return (
    spawnSync(name, ["--version"], { stdio: "ignore", shell: process.platform === "win32" })
      .error === undefined
  );
}

function runOrExit(description, command_, args_, manualHint) {
  console.log(`[desktop-rust] ${description}: ${[command_, ...args_].join(" ")}`);
  const run = spawnSync(command_, args_, { stdio: "inherit", env: process.env });
  if (run.status === 0) return;
  console.error(`[desktop-rust] ${description} failed. Run it manually:\n  ${manualHint}`);
  process.exit(run.status ?? 1);
}

function ensureRustToolchain() {
  if (commandExists("cargo")) return;
  const installer =
    "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal";
  if (process.platform === "win32") {
    console.error("[desktop-rust] Rust is missing. Install it from https://rustup.rs, then rerun.");
    process.exit(1);
  }
  runOrExit(
    "Installing the Rust toolchain (rustup, user-local)",
    "sh",
    ["-c", installer],
    installer,
  );
  const cargoBin = join(homedir(), ".cargo", "bin");
  process.env.PATH = [cargoBin, process.env.PATH].join(delimiter);
}

// Build-time set from .github/workflows/release-tauri.yml. The tray indicator library is loaded
// at runtime, so its -dev package is only needed by the release job that bundles the AppImage.
const LINUX_PACKAGES = {
  "apt-get": [
    "build-essential",
    "pkg-config",
    "libssl-dev",
    "libwebkit2gtk-4.1-dev",
    "librsvg2-dev",
    "patchelf",
    "libxdo-dev",
    "libxcb1-dev",
    "libxrandr-dev",
    "libdbus-1-dev",
  ],
  dnf: [
    "gcc",
    "pkgconf-pkg-config",
    "openssl-devel",
    "webkit2gtk4.1-devel",
    "librsvg2-devel",
    "patchelf",
    "libxdo-devel",
    "libxcb-devel",
    "libXrandr-devel",
    "dbus-devel",
  ],
  pacman: [
    "base-devel",
    "openssl",
    "webkit2gtk-4.1",
    "librsvg",
    "patchelf",
    "xdotool",
    "libxcb",
    "libxrandr",
    "dbus",
  ],
};

function ensureLinuxSystemPackages() {
  const manager = Object.keys(LINUX_PACKAGES).find(commandExists);
  if (!manager) {
    if (spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1"]).status === 0) return;
    console.error(
      "[desktop-rust] WebKitGTK 4.1 development files are missing and no apt-get, dnf or pacman was found. See https://v2.tauri.app/start/prerequisites/#linux.",
    );
    process.exit(1);
  }
  const packages = LINUX_PACKAGES[manager];
  const missing =
    manager === "apt-get"
      ? packages.filter(
          (name) =>
            spawnSync("dpkg-query", ["-W", "-f=${Status}", name], { encoding: "utf8" }).stdout !==
            "install ok installed",
        )
      : spawnSync("pkg-config", ["--exists", "webkit2gtk-4.1", "librsvg-2.0", "dbus-1"]).status ===
          0
        ? []
        : packages;
  if (missing.length === 0) return;

  const install = {
    "apt-get": ["apt-get", "install", "-y", ...missing],
    dnf: ["dnf", "install", "-y", ...missing],
    pacman: ["pacman", "-S", "--needed", "--noconfirm", ...missing],
  }[manager];
  const hint =
    manager === "apt-get"
      ? `sudo apt-get update && sudo ${install.join(" ")}`
      : `sudo ${install.join(" ")}`;
  console.log(`[desktop-rust] Missing Tauri system packages: ${missing.join(" ")}`);
  if (manager === "apt-get") {
    runOrExit("Refreshing the package index", "sudo", ["apt-get", "update"], hint);
  }
  runOrExit("Installing Tauri system packages", "sudo", install, hint);
}

// Only cargo and the Tauri CLI compile against the native toolchain; `bun build` steps skip this.
const needsNativeToolchain = [command, ...args].some(
  (arg) => arg === "cargo" || arg.startsWith("@tauri-apps/cli"),
);
if (needsNativeToolchain && process.env.SAINT_SKIP_SYSTEM_DEPS !== "1") {
  ensureRustToolchain();
  if (process.platform === "linux") ensureLinuxSystemPackages();
}

const result = spawnSync(command, args, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
