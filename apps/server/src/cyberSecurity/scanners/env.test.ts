import path from "node:path";

import { describe, expect, it } from "vitest";

import { scannerEnv } from "./env.ts";

const SERVER_SECRETS = {
  SAINT_AUTH_TOKEN: "server-token",
  GITHUB_TOKEN: "ghp_secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  OPENAI_API_KEY: "sk-secret",
};

describe("scannerEnv on POSIX", () => {
  const env = scannerEnv({
    platform: "linux",
    scratch: "/scratch/gitleaks",
    home: "/home/me",
    source: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", ...SERVER_SECRETS },
  });

  it("carries only what a program needs to start", () => {
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/home/me",
      NO_COLOR: "1",
      CI: "1",
    });
  });

  it("never inherits the server's tokens", () => {
    for (const name of Object.keys(SERVER_SECRETS)) expect(env).not.toHaveProperty(name);
  });

  it("adds the run's own variables last", () => {
    expect(
      scannerEnv({
        platform: "linux",
        scratch: "/s",
        home: "/h",
        source: {},
        extra: { HTTPS_PROXY: "http://127.0.0.1:9", HOME: "/override" },
      }),
    ).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:9", HOME: "/override", LANG: "C.UTF-8" });
  });
});

describe("scannerEnv on Windows", () => {
  const source = {
    Path: "C:\\Windows\\System32;C:\\tools",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    USERNAME: "me",
    ...SERVER_SECRETS,
  };
  const env = scannerEnv({
    platform: "win32",
    scratch: "C:\\state\\cs\\trivy",
    home: "C:\\Users\\me",
    source,
  });

  it("finds PATH under any capitalization and keeps what process creation needs", () => {
    expect(env).toMatchObject({
      PATH: "C:\\Windows\\System32;C:\\tools",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
  });

  it("points the user and cache folders where Go tools look", () => {
    expect(env).toMatchObject({
      USERPROFILE: "C:\\Users\\me",
      HOME: "C:\\Users\\me",
      LOCALAPPDATA: path.win32.join("C:\\Users\\me", "AppData", "Local"),
      APPDATA: path.win32.join("C:\\Users\\me", "AppData", "Roaming"),
    });
  });

  it("keeps temp files inside the scratch folder, not the shared temp folder", () => {
    expect(env.TEMP).toBe(path.win32.join("C:\\state\\cs\\trivy", "tmp"));
    expect(env.TMP).toBe(env.TEMP);
  });

  it("never inherits the server's tokens or unrelated variables", () => {
    for (const name of [...Object.keys(SERVER_SECRETS), "USERNAME"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("falls back to the standard system root when the server has none set", () => {
    expect(
      scannerEnv({ platform: "win32", scratch: "C:\\s", home: "C:\\h", source: {} }),
    ).toMatchObject({
      SystemRoot: "C:\\Windows",
      ComSpec: path.win32.join("C:\\Windows", "System32", "cmd.exe"),
    });
  });

  it("matches variable names case-insensitively, as Windows does", () => {
    expect(
      scannerEnv({
        platform: "win32",
        scratch: "C:\\s",
        home: "C:\\h",
        source: { PATH: "C:\\x", pathext: ".EXE", systemdrive: "C:" },
      }),
    ).toMatchObject({ PATH: "C:\\x", PATHEXT: ".EXE", SystemDrive: "C:" });
  });
});
