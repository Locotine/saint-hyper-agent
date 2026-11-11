import { describe, expect, it } from "vitest";

import { buildAcpSpawnProcessEnv } from "./AcpSessionRuntime.ts";

describe("buildAcpSpawnProcessEnv", () => {
  it("scrubs ambient provider credentials before applying ACP flags and selected credentials", () => {
    const env = buildAcpSpawnProcessEnv(
      {
        command: "grok",
        args: ["agent", "stdio"],
        env: { NO_BROWSER: "true" },
        providerEnvironment: {
          driver: "grok",
          instanceId: "grok_work",
          environment: { GROK_CODE_XAI_API_KEY: "selected-account-b" },
        },
      },
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.example",
        XAI_API_KEY: "ambient-account-a",
      },
    );

    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_CODE_XAI_API_KEY).toBe("selected-account-b");
    expect(env.NO_BROWSER).toBe("true");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy.example");
  });

  it("preserves legacy generic ACP environment overlay behavior", () => {
    const env = buildAcpSpawnProcessEnv(
      { command: "custom-acp", args: [], env: { CUSTOM_VALUE: "selected" } },
      { PATH: "/usr/bin", CUSTOM_VALUE: "ambient" },
    );

    expect(env).toEqual({ PATH: "/usr/bin", CUSTOM_VALUE: "selected" });
  });

  it("uses the launchProvider credential profile when specified", () => {
    const env = buildAcpSpawnProcessEnv(
      { command: "agy", args: ["acp"] },
      {
        PATH: "/usr/bin",
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_API_KEY: "google-key",
        OPENAI_API_KEY: "ambient-openai-key",
        ANTHROPIC_API_KEY: "ambient-anthropic-key",
      },
      "linux",
      "antigravity",
    );

    expect(env.GEMINI_API_KEY).toBe("gemini-key");
    expect(env.GOOGLE_API_KEY).toBe("google-key");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
