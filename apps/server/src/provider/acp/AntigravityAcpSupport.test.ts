import type * as Acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  applyAntigravityAcpInteractionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityAcpSpawnInput,
  buildAntigravityPromptUsageSnapshot,
  parseAntigravityAcpConfigModels,
  resolveAntigravityAcpAuthMethodId,
  resolveAntigravityAcpModelChoice,
  resolveAntigravityCliBinaryPath,
  resolveAntigravityTransport,
} from "./AntigravityAcpSupport.ts";

const SAMPLE_CONFIG_OPTIONS: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-argon",
    options: [
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  {
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    name: "Permission Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "accept-edits", name: "Accept Edits" },
      { value: "auto", name: "Auto" },
      { value: "plan", name: "Plan" },
    ],
  },
];

describe("AntigravityAcpSupport", () => {
  it("defaults to acp across all flavors (Stable and Beta) and honors SAINT_ANTIGRAVITY_TRANSPORT overrides", () => {
    expect(resolveAntigravityTransport({ env: {}, flavor: "production" })).toBe("acp");
    expect(resolveAntigravityTransport({ env: {}, flavor: "beta" })).toBe("acp");
    expect(resolveAntigravityTransport({ env: {}, flavor: "development" })).toBe("acp");
    expect(
      resolveAntigravityTransport({
        env: { SAINT_ANTIGRAVITY_TRANSPORT: "print" },
        flavor: "production",
      }),
    ).toBe("print");
    expect(
      resolveAntigravityTransport({
        env: { SAINT_ANTIGRAVITY_TRANSPORT: "acp" },
        flavor: "production",
      }),
    ).toBe("acp");
  });

  it("resolves agy binary path from explicit override or standard install directories", () => {
    expect(resolveAntigravityCliBinaryPath("/custom/bin/agy")).toBe("/custom/bin/agy");
    expect(
      resolveAntigravityCliBinaryPath(undefined, {
        env: { PATH: "" },
        platform: "linux",
        homeDir: "/home/tester",
        pathExists: (candidate) => candidate === "/home/tester/.gemini/antigravity-cli/bin/agy",
      }),
    ).toBe("/home/tester/.gemini/antigravity-cli/bin/agy");
  });

  it("builds spawn input with args ['acp'] and filtered antigravity environment", () => {
    const spawn = buildAntigravityAcpSpawnInput(
      {
        binaryPath: "/usr/local/bin/agy",
        environment: { GEMINI_API_KEY: "gemini-secret" },
      },
      "/tmp/workspace",
      {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "ambient-openai-secret",
      },
    );

    expect(spawn.command).toBe("/usr/local/bin/agy");
    expect(spawn.args).toEqual(["acp"]);
    expect(spawn.cwd).toBe("/tmp/workspace");
    expect(spawn.env?.GEMINI_API_KEY).toBe("gemini-secret");
    expect(spawn.env?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(spawn.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("resolves auth method priority based on advertised methods and environment", async () => {
    const initResponse: Acp.InitializeResponse = {
      protocolVersion: 1,
      authMethods: [
        { id: "oauth-personal", name: "Google Account" },
        { id: "gemini-api-key", name: "Gemini API Key" },
        { id: "agent-platform", name: "Vertex AI" },
      ],
    };

    await expect(
      Effect.runPromise(resolveAntigravityAcpAuthMethodId(initResponse, {})),
    ).resolves.toBe("oauth-personal");

    await expect(
      Effect.runPromise(
        resolveAntigravityAcpAuthMethodId(initResponse, { GEMINI_API_KEY: "key-123" }),
      ),
    ).resolves.toBe("gemini-api-key");

    await expect(
      Effect.runPromise(
        resolveAntigravityAcpAuthMethodId(initResponse, {
          GOOGLE_APPLICATION_CREDENTIALS: "/path/to/creds.json",
        }),
      ),
    ).resolves.toBe("agent-platform");
  });

  it("maps legacy display names, ACP slugs, and effort options to modelValue and thought_level", () => {
    expect(
      resolveAntigravityAcpModelChoice({
        configOptions: SAMPLE_CONFIG_OPTIONS,
        requestedModel: "Gemini 3.5 Flash",
      }),
    ).toEqual({
      modelConfigId: "model",
      modelValue: "gemini-3.8-flash",
      displayModel: "Gemini 3.8 Flash",
      desiredThoughtLevel: "medium",
    });

    expect(
      resolveAntigravityAcpModelChoice({
        configOptions: SAMPLE_CONFIG_OPTIONS,
        requestedModel: "Gemini 3.8 Flash (Low)",
      }),
    ).toEqual({
      modelConfigId: "model",
      modelValue: "gemini-3.8-flash",
      displayModel: "Gemini 3.8 Flash",
      desiredThoughtLevel: "low",
    });

    expect(
      resolveAntigravityAcpModelChoice({
        configOptions: SAMPLE_CONFIG_OPTIONS,
        requestedModel: "Gemini 4 Argon",
        modelOptions: { reasoningEffort: "high", fastMode: true },
      }),
    ).toEqual({
      modelConfigId: "model",
      modelValue: "gemini-4-argon",
      displayModel: "Gemini 4 Argon",
      desiredThoughtLevel: "low",
    });

    expect(
      resolveAntigravityAcpModelChoice({
        configOptions: SAMPLE_CONFIG_OPTIONS,
        requestedModel: "Claude Sonnet 4.6",
      }),
    ).toEqual({
      modelConfigId: "model",
      modelValue: "claude-sonnet-4-6",
      displayModel: "Claude Sonnet 4.6",
    });
  });

  it("applies model first and only sets thought_level when advertised on updated configOptions", async () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    let currentOptions = [...SAMPLE_CONFIG_OPTIONS];

    const runtime = {
      getConfigOptions: Effect.sync(() => currentOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ configId, value });
          if (configId === "model" && value === "claude-sonnet-4-6") {
            currentOptions = currentOptions.filter((opt) => opt.id !== "thought_level");
          }
          return { configOptions: [...currentOptions] };
        }),
    };

    const geminiApplied = await Effect.runPromise(
      applyAntigravityAcpModelSelection({
        runtime,
        model: "Gemini 3.5 Flash",
        modelOptions: { reasoningEffort: "high" },
        mapError: ({ cause }) => cause,
      }),
    );
    expect(geminiApplied).toEqual({
      model: "Gemini 3.8 Flash",
      modelValue: "gemini-3.8-flash",
      thoughtLevel: "high",
    });
    expect(calls).toEqual([
      { configId: "model", value: "gemini-3.8-flash" },
      { configId: "thought_level", value: "high" },
    ]);

    calls.length = 0;
    const claudeApplied = await Effect.runPromise(
      applyAntigravityAcpModelSelection({
        runtime,
        model: "Claude Sonnet 4.6",
        modelOptions: { reasoningEffort: "thinking" },
        mapError: ({ cause }) => cause,
      }),
    );
    expect(claudeApplied).toEqual({
      model: "Claude Sonnet 4.6",
      modelValue: "claude-sonnet-4-6",
    });
    expect(calls).toEqual([{ configId: "model", value: "claude-sonnet-4-6" }]);
  });

  it("switches interaction mode to plan or auto", async () => {
    const modeCalls: string[] = [];
    const runtime = {
      getModeState: Effect.succeed({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "auto", name: "Auto" },
          { id: "plan", name: "Plan" },
        ],
      }),
      getConfigOptions: Effect.succeed(SAMPLE_CONFIG_OPTIONS),
      setMode: (modeId: string) =>
        Effect.sync(() => {
          modeCalls.push(modeId);
          return {};
        }),
      setConfigOption: () => Effect.succeed({ configOptions: [...SAMPLE_CONFIG_OPTIONS] }),
    };

    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        interactionMode: "default",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(modeCalls).toEqual(["plan", "auto"]);
  });

  it("parses advertised ACP configOptions into Saint model descriptors and computes prompt usage", () => {
    const models = parseAntigravityAcpConfigModels(SAMPLE_CONFIG_OPTIONS);
    expect(models).toEqual([
      {
        slug: "Gemini 4 Argon",
        name: "Gemini 4 Argon",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.8 Flash",
        name: "Gemini 3.8 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "Claude Opus 4.6",
        name: "Claude Opus 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "GPT-OSS 120B",
        name: "GPT-OSS 120B",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
    ]);

    const usageResult = buildAntigravityPromptUsageSnapshot({
      usage: {
        inputTokens: 1_200,
        cachedReadTokens: 300,
        cachedWriteTokens: 0,
        outputTokens: 150,
        thoughtTokens: 50,
        totalTokens: 1_700,
      },
      model: "Gemini 3.8 Flash",
      previousTotalProcessedTokens: 1_000,
    });
    expect(usageResult?.nextTotalProcessedTokens).toBe(1_700);
    expect(usageResult?.snapshot).toMatchObject({
      usedTokens: 1_700,
      totalProcessedTokens: 1_700,
      maxTokens: 1_048_576,
      inputTokens: 1_200,
      cachedInputTokens: 300,
      outputTokens: 150,
      reasoningOutputTokens: 50,
      compactsAutomatically: true,
    });
  });
});
