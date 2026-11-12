#!/usr/bin/env node
// FILE: build-server-sidecar.ts
// Purpose: Compiles `apps/server` (`@saint/cli`) into a standalone single-file executable
//          for Tauri v2 `externalBin` sidecar packaging via `bun build --compile` (Option 4A).
// Layer: Build / Packaging script

import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface BunBuildPluginBuilder {
  onLoad(
    options: { readonly filter: RegExp },
    callback: (args: { readonly path: string }) => {
      readonly contents: string;
      readonly loader: "ts";
    },
  ): void;
}

declare const Bun: {
  build(options: {
    readonly entrypoints: ReadonlyArray<string>;
    readonly minify: boolean;
    readonly compile: {
      readonly outfile: string;
      readonly target?: string;
    };
    readonly plugins: ReadonlyArray<{
      readonly name: string;
      setup(build: BunBuildPluginBuilder): void;
    }>;
  }): Promise<{ readonly success: boolean; readonly logs: ReadonlyArray<unknown> }>;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(repoRoot, "apps/server/src/index.ts");
const binariesDir = join(repoRoot, "apps/desktop-rust/binaries");

export function resolveBunCompileTarget(rustTriple: string): {
  readonly bunTarget: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
} {
  switch (rustTriple.trim()) {
    case "x86_64-pc-windows-msvc":
    case "x86_64-pc-windows-gnu":
    case "x86_64-pc-windows-gnullvm":
      return { bunTarget: "bun-windows-x64", platform: "win32", arch: "x64" };
    case "aarch64-pc-windows-msvc":
    case "aarch64-pc-windows-gnu":
    case "aarch64-pc-windows-gnullvm":
      return { bunTarget: "bun-windows-arm64", platform: "win32", arch: "arm64" };
    case "aarch64-apple-darwin":
      return { bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64" };
    case "x86_64-apple-darwin":
      return { bunTarget: "bun-darwin-x64", platform: "darwin", arch: "x64" };
    case "x86_64-unknown-linux-gnu":
      return { bunTarget: "bun-linux-x64", platform: "linux", arch: "x64" };
    case "aarch64-unknown-linux-gnu":
      return { bunTarget: "bun-linux-arm64", platform: "linux", arch: "arm64" };
    default:
      throw new Error(`Unsupported Rust target triple for Bun sidecar: ${rustTriple}`);
  }
}

export function resolveTauriTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  throw new Error(`Unsupported platform/arch for Tauri sidecar: ${platform}/${arch}`);
}

export function resolveSidecarOutputPaths(
  outDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): {
  readonly tripleBinaryPath: string;
  readonly gnuBinaryPath: string | null;
  readonly gnullvmBinaryPath: string | null;
  readonly plainBinaryPath: string;
} {
  const ext = platform === "win32" ? ".exe" : "";
  const triple = resolveTauriTargetTriple(platform, arch);
  const gnuTriple =
    platform === "win32"
      ? arch === "arm64"
        ? "aarch64-pc-windows-gnu"
        : "x86_64-pc-windows-gnu"
      : null;
  const gnullvmTriple =
    platform === "win32"
      ? arch === "arm64"
        ? "aarch64-pc-windows-gnullvm"
        : "x86_64-pc-windows-gnullvm"
      : null;
  return {
    tripleBinaryPath: join(outDir, `saint-server-${triple}${ext}`),
    gnuBinaryPath: gnuTriple ? join(outDir, `saint-server-${gnuTriple}${ext}`) : null,
    gnullvmBinaryPath: gnullvmTriple ? join(outDir, `saint-server-${gnullvmTriple}${ext}`) : null,
    plainBinaryPath: join(outDir, `saint-server${ext}`),
  };
}

if (import.meta.main) {
  mkdirSync(binariesDir, { recursive: true });
  const targetFlagIndex = process.argv.indexOf("--target");
  const requestedTriple =
    (targetFlagIndex >= 0 ? process.argv[targetFlagIndex + 1] : undefined) ??
    process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  const resolvedTarget = requestedTriple ? resolveBunCompileTarget(requestedTriple) : undefined;
  const { tripleBinaryPath, gnuBinaryPath, gnullvmBinaryPath, plainBinaryPath } =
    resolveSidecarOutputPaths(
      binariesDir,
      resolvedTarget?.platform ?? process.platform,
      resolvedTarget?.arch ?? process.arch,
    );

  console.log(
    `[build-server-sidecar] Compiling ${serverEntry} -> ${tripleBinaryPath}${resolvedTarget ? ` (${resolvedTarget.bunTarget})` : ""}`,
  );
  const buildResult = await Bun.build({
    entrypoints: [serverEntry],
    minify: true,
    compile: {
      outfile: tripleBinaryPath,
      ...(resolvedTarget ? { target: resolvedTarget.bunTarget } : {}),
    },
    plugins: [
      {
        name: "embed-create-require-modules",
        setup(build) {
          build.onLoad({ filter: /terminalModeReplay\.ts$/ }, (args) => {
            const contents = readFileSync(args.path, "utf8").replace(
              "const require = createRequire(import.meta.url);",
              "",
            );
            return { contents, loader: "ts" };
          });
        },
      },
    ],
  });
  if (!buildResult.success) {
    console.error("[build-server-sidecar] Build failed:", buildResult.logs);
    process.exit(1);
  }
  // Unlink first: overwriting a sidecar that is still running fails with ETXTBSY on Linux.
  const replaceBinary = (destination: string) => {
    rmSync(destination, { force: true });
    copyFileSync(tripleBinaryPath, destination);
  };
  if (gnuBinaryPath) replaceBinary(gnuBinaryPath);
  if (gnullvmBinaryPath) replaceBinary(gnullvmBinaryPath);
  replaceBinary(plainBinaryPath);
  console.log(`[build-server-sidecar] Sidecar ready: ${tripleBinaryPath}`);
}
