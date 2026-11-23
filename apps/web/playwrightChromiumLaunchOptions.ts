import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { chromium, type LaunchOptions } from "playwright";

function hasBundledPlaywrightChromium(): boolean {
  try {
    const executablePath = chromium.executablePath();
    if (existsSync(executablePath)) return true;
    // `playwright install --only-shell chromium` installs `chromium_headless_shell-*`
    // alongside `chromium-*` inside the same Playwright cache root.
    let dir = path.dirname(executablePath);
    for (let depth = 0; depth < 8; depth += 1) {
      if (path.basename(dir).startsWith("chromium-")) {
        const cacheRoot = path.dirname(dir);
        return (
          existsSync(cacheRoot) &&
          readdirSync(cacheRoot).some((entry) => entry.startsWith("chromium_headless_shell-"))
        );
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}

function findSystemChromiumExecutable(): string | undefined {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.PROGRAMFILES ?? "C:\\Program Files",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            path.join(
              process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
            ...(process.env.LOCALAPPDATA
              ? [
                  path.join(
                    process.env.LOCALAPPDATA,
                    "Google",
                    "Chrome",
                    "Application",
                    "chrome.exe",
                  ),
                ]
              : []),
          ]
        : [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function resolvePlaywrightChromiumLaunchOptions():
  | Omit<LaunchOptions, "tracesDir">
  | undefined {
  const explicitPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const linuxArgs = process.platform === "linux" ? { args: ["--no-sandbox"] } : {};
  if (explicitPath) {
    return { executablePath: explicitPath, ...linuxArgs };
  }
  if (hasBundledPlaywrightChromium()) {
    return undefined;
  }
  const systemExecutable = findSystemChromiumExecutable();
  if (systemExecutable) {
    return { executablePath: systemExecutable, ...linuxArgs };
  }
  return undefined;
}
