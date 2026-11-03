// FILE: env.ts
// Purpose: The environment a scanner process runs with: a short allowlist of what the platform
//          needs to start a program at all, never the server's own environment (tokens, keys).
// Layer: Server cyber security scanners (pure)
// Exports: scannerEnv

import path from "node:path";

import { resolveWindowsComSpec, resolveWindowsSystemRoot } from "@saint/shared/platformEnvironment";

/** Looks a variable up the way the platform does: any capitalization on Windows. */
function read(source: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) {
  if (source[name] !== undefined) return source[name];
  if (platform !== "win32") return undefined;
  const key = Object.keys(source).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : source[key];
}

/**
 * Windows variables a program needs to start and to find its own folders. Process creation
 * fails or Go's `os.UserCacheDir` has nowhere to go without them. `TEMP`/`TMP` point into the
 * scratch folder so nothing lands in the shared temp folder.
 */
const WINDOWS_PASSTHROUGH = [
  "SystemDrive",
  "windir",
  "PATHEXT",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/**
 * Environment for one scanner process. `scratch` is a folder only this run writes to; `home`
 * is where the scanner keeps its caches and settings (the real home, or the scratch folder for a
 * scanner that must not read the user's own configuration). `extra` is added last, and holds
 * only what the run needs, such as the proxy variables.
 */
export function scannerEnv(input: {
  readonly scratch: string;
  readonly home: string;
  readonly extra?: Readonly<Record<string, string>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** Where the platform values come from; the server's own environment by default. */
  readonly source?: NodeJS.ProcessEnv | undefined;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const source = input.source ?? process.env;
  const base: NodeJS.ProcessEnv = {
    PATH: read(source, "PATH", platform),
    LANG: read(source, "LANG", platform) ?? "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
  };
  if (platform === "win32") {
    const win = path.win32;
    const tmp = win.join(input.scratch, "tmp");
    Object.assign(base, {
      SystemRoot: resolveWindowsSystemRoot(source),
      ComSpec: resolveWindowsComSpec(source),
      TEMP: tmp,
      TMP: tmp,
      HOME: input.home,
      USERPROFILE: input.home,
      // Where Go's os.UserCacheDir and os.UserConfigDir look.
      LOCALAPPDATA: win.join(input.home, "AppData", "Local"),
      APPDATA: win.join(input.home, "AppData", "Roaming"),
    });
    for (const name of WINDOWS_PASSTHROUGH) {
      const value = read(source, name, platform);
      if (value !== undefined) base[name] = value;
    }
  } else {
    base.HOME = input.home;
  }
  return { ...base, ...input.extra };
}
