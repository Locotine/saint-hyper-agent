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
  resolveAntigravityAcpModeId,
  resolveAntigravityAcpModelChoice,
  resolveAntigravityCliBinaryPath,
  resolveAntigravityTransport,
  type AntigravityAcpModelInfo,
} from "./AntigravityAcpSupport.ts";

// Sanitized Phase 0 live capture fixtures from `agy acp` 1.5.9 (2026-11-16).
const P0_INITIALIZE_CAPABILITIES: Acp.AgentCapabilities = {
  loadSession: true,
  promptCapabilities: {
    image: true,
    audio: false,
    embeddedContext: true,
  },
  sessionCapabilities: {
    resume: {},
    close: {},
    list: {},
    additionalDirectories: {},
  },
};

const P0_SESSION_NEW_MODES: Acp.SessionModeState = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "accept-edits", name: "Accept edits" },
    { id: "auto", name: "Auto" },
    { id: "plan", name: "Plan" },
  ],
};

const P0_SESSION_NEW_MODELS: ReadonlyArray<AntigravityAcpModelInfo> = [
  { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
  { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
  { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
  { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
  { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
  { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
  { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
  { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
  { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];

const P0_SESSION_NEW_CONFIG_OPTIONS: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-carbon",
    options: [
      { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking Level",
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
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "accept-edits", name: "Accept edits" },
      { value: "auto", name: "Auto" },
      { value: "plan", name: "Plan" },
    ],
  },
];

const P0_HYDROGEN_THOUGHT_OPTIONS: ReadonlyArray<Acp.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-hydrogen",
    options: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
  },
  {
    id: "thought_level",
    name: "Thinking Level",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra" },
    ],
  },
];

const P0_AVAILABLE_COMMANDS: ReadonlyArray<Acp.AvailableCommand> = [
  { name: "goal", description: "Run until the specified goal is completely finished." },
  { name: "compact", description: "Compact the conversation now." },
  { name: "plan", description: "Plan carefully before executing a task." },
  { name: "swarm", description: "Run a swarm." },
];

const P0_USAGE_UPDATE = {
  sessionUpdate: "usage_update",
  used: 0,
  size: 1_048_576,
} as const;

const P0_PLAN_ARTIFACT_TOOL_CALL = {
  toolCallId: "call-plan-1",
  kind: "edit",
  status: "completed",
  title: "File plan.md",
  locations: [{ path: "/tmp/p0-brain/plan.md" }],
  rawInput: {
    ArtifactMetadata: { RequestFeedback: true, Summary: "Plan summary", UserFacing: true },
    Content: "# Implementation Plan\n\n1. Add README.md\n",
    Overwrite: true,
    Path: "/tmp/p0-brain/plan.md",
  },
} as const;

const P0_SESSION_LIST_SUPPORTED = true;

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
    expect(
      resolveAntigravityCliBinaryPath(undefined, {
        env: { PATH: "" },
        platform: "darwin",
        homeDir: "/Users/tester",
        pathExists: (candidate) => candidate === "/Users/tester/.local/bin/agy",
      }),
    ).toBe("/Users/tester/.local/bin/agy");
    expect(
      resolveAntigravityCliBinaryPath(undefined, {
        env: { PATH: "", USERPROFILE: "C:\\Users\\tester" },
        platform: "win32",
        homeDir: "C:\\Users\\tester",
        pathExists: (candidate) =>
          candidate === "C:\\Users\\tester\\.gemini\\antigravity-cli\\bin\\agy.exe",
      }),
    ).toBe("C:\\Users\\tester\\.gemini\\antigravity-cli\\bin\\agy.exe");
    expect(
      resolveAntigravityCliBinaryPath(undefined, {
        env: { PATH: "", LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
        platform: "win32",
        homeDir: "C:\\Users\\tester",
        pathExists: (candidate) =>
          candidate === "C:\\Users\\tester\\AppData\\Local\\Programs\\antigravity-cli\\agy.cmd",
      }),
    ).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\antigravity-cli\\agy.cmd");
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

  it("maps interaction and runtime modes to Antigravity ACP modes and fails closed when required modes are absent", async () => {
    expect(P0_INITIALIZE_CAPABILITIES.sessionCapabilities?.additionalDirectories).toEqual({});
    expect(P0_SESSION_LIST_SUPPORTED).toBe(true);
    expect(P0_AVAILABLE_COMMANDS.some((cmd) => cmd.name === "swarm")).toBe(true);
    expect(P0_PLAN_ARTIFACT_TOOL_CALL.kind).toBe("edit");

    const modeIds = new Set(P0_SESSION_NEW_MODES.availableModes.map((mode) => mode.id));
    await expect(
      Effect.runPromise(
        resolveAntigravityAcpModeId({
          runtimeMode: "approval-required",
          interactionMode: "default",
          availableModeIds: modeIds,
        }),
      ),
    ).resolves.toBe("default");
    await expect(
      Effect.runPromise(
        resolveAntigravityAcpModeId({
          runtimeMode: "auto",
          interactionMode: "default",
          availableModeIds: modeIds,
        }),
      ),
    ).resolves.toBe("auto");
    await expect(
      Effect.runPromise(
        resolveAntigravityAcpModeId({
          runtimeMode: "full-access",
          interactionMode: "default",
          availableModeIds: modeIds,
        }),
      ),
    ).resolves.toBe("default");
    await expect(
      Effect.runPromise(
        resolveAntigravityAcpModeId({
          runtimeMode: "full-access",
          interactionMode: "plan",
          availableModeIds: modeIds,
        }),
      ),
    ).resolves.toBe("plan");

    const missingAutoError = await Effect.runPromise(
      Effect.flip(
        resolveAntigravityAcpModeId({
          runtimeMode: "auto",
          interactionMode: "default",
          availableModeIds: new Set(["default", "plan"]),
        }),
      ),
    );
    expect(missingAutoError.message).toContain('runtime mode "auto"');

    const missingPlanError = await Effect.runPromise(
      Effect.flip(
        resolveAntigravityAcpModeId({
          runtimeMode: "full-access",
          interactionMode: "plan",
          availableModeIds: new Set(["default"]),
        }),
      ),
    );
    expect(missingPlanError.message).toContain("plan interaction mode");

    await expect(
      Effect.runPromise(
        resolveAntigravityAcpModeId({
          runtimeMode: "full-access",
          interactionMode: "default",
          availableModeIds: new Set(["auto"]),
        }),
      ),
    ).resolves.toBeUndefined();

    const modeCalls: string[] = [];
    let currentModeId = "auto";
    const runtime = {
      getModeState: Effect.sync(() => ({
        currentModeId,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "auto", name: "Auto" },
          { id: "plan", name: "Plan" },
        ],
      })),
      getConfigOptions: Effect.succeed(SAMPLE_CONFIG_OPTIONS),
      setMode: (modeId: string) =>
        Effect.sync(() => {
          currentModeId = modeId;
          modeCalls.push(modeId);
          return {};
        }),
      setConfigOption: () => Effect.succeed({ configOptions: [...SAMPLE_CONFIG_OPTIONS] }),
    };

    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        runtimeMode: "approval-required",
        interactionMode: "default",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        runtimeMode: "auto",
        interactionMode: "default",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyAntigravityAcpInteractionMode({
        runtime,
        runtimeMode: "full-access",
        interactionMode: "default",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(modeCalls).toEqual(["plan", "default", "auto", "default"]);
  });

  it("includes updated agy login hint when auth methods are empty", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveAntigravityAcpAuthMethodId({ protocolVersion: 1, authMethods: [] }, {})),
    );
    expect(error._tag).toBe("AcpRequestError");
    if (error._tag === "AcpRequestError") {
      const detail = String((error.data as { detail?: unknown })?.detail ?? "");
      expect(detail).toContain("agy acp --login");
      expect(detail).not.toContain("agy auth login");
    }
  });

  it("parses advertised ACP configOptions and availableModels including xhigh for Hydrogen and prefers declared context window", () => {
    const p0Models = parseAntigravityAcpConfigModels(
      P0_SESSION_NEW_CONFIG_OPTIONS,
      P0_SESSION_NEW_MODELS,
    );
    const hydrogen = p0Models.find((m) => m.slug === "Gemini 4 Hydrogen");
    expect(hydrogen?.supportedReasoningEfforts).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "XHigh" },
    ]);
    const carbon = p0Models.find((m) => m.slug === "Gemini 4 Carbon");
    expect(carbon?.supportedReasoningEfforts).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ]);

    const hydrogenFromConfig = parseAntigravityAcpConfigModels(P0_HYDROGEN_THOUGHT_OPTIONS);
    expect(hydrogenFromConfig[0]?.supportedReasoningEfforts).toContainEqual({
      value: "xhigh",
      label: "XHigh",
    });

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
      maxTokens: P0_USAGE_UPDATE.size * 2,
    });
    expect(usageResult?.nextTotalProcessedTokens).toBe(1_700);
    expect(usageResult?.snapshot).toMatchObject({
      usedTokens: 1_700,
      totalProcessedTokens: 1_700,
      maxTokens: P0_USAGE_UPDATE.size * 2,
      inputTokens: 1_200,
      cachedInputTokens: 300,
      outputTokens: 150,
      reasoningOutputTokens: 50,
      compactsAutomatically: true,
    });

    const multiStepResult = buildAntigravityPromptUsageSnapshot({
      usage: {
        inputTokens: 210_000,
        cachedReadTokens: 35_000,
        cachedWriteTokens: 0,
        outputTokens: 4_000,
        thoughtTokens: 1_000,
        totalTokens: 250_000,
      },
      model: "Gemini 4 Neon",
      previousTotalProcessedTokens: 10_000,
      maxTokens: P0_USAGE_UPDATE.size,
      currentContextUsedTokens: 60_000,
    });
    expect(multiStepResult?.nextTotalProcessedTokens).toBe(250_000);
    expect(multiStepResult?.snapshot).toMatchObject({
      usedTokens: 60_000,
      totalProcessedTokens: 250_000,
      maxTokens: P0_USAGE_UPDATE.size,
      lastUsedTokens: 60_000,
      compactsAutomatically: true,
    });
  });
});
