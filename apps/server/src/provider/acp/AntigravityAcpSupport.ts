// FILE: AntigravityAcpSupport.ts
// Purpose: Antigravity (`agy acp`) transport gate, executable resolution, auth, model/thought_level, and mode helpers.
// Layer: Provider ACP support
// Exports: AntigravityAcpSupport helpers and runtime factory.

import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type * as Acp from "@agentclientprotocol/sdk";
import type {
  AntigravityModelOptions,
  ProviderInteractionMode,
  ProviderModelDescriptor,
  RuntimeMode,
  ThreadTokenUsageSnapshot,
} from "@saint/contracts";
import type { SaintDesktopFlavor } from "@saint/shared/desktopIdentity";
import { resolveExecutable } from "@saint/shared/executable";
import { Effect, Layer, Scope, ServiceMap } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import {
  parseAntigravityCliModelLabel,
  resolveAntigravityModelMaxTokens,
} from "../Layers/AntigravityAdapter.ts";
import { computeUsagePercent, nonNegativeInteger, positiveInteger } from "../tokenUsage.ts";
import {
  availableAuthMethodIds,
  findSelectConfig,
  flattenConfigOptions,
} from "./AcpConfigOptions.ts";
import * as AcpErrors from "./AcpErrors.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export const SAINT_ANTIGRAVITY_TRANSPORT_ENV = "SAINT_ANTIGRAVITY_TRANSPORT";
export const DEFAULT_ANTIGRAVITY_ACP_MODEL = "Gemini 3.8 Flash";

export type AntigravityTransport = "acp" | "print";

export function resolveAntigravityTransport(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly flavor?: SaintDesktopFlavor | "unknown";
}): AntigravityTransport {
  const env = options?.env ?? process.env;
  const rawOverride = env[SAINT_ANTIGRAVITY_TRANSPORT_ENV]?.trim().toLowerCase();
  if (rawOverride === "print") {
    return "print";
  }
  return "acp";
}

export interface AntigravityAcpRuntimeSettings {
  readonly binaryPath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface AntigravityCliResolutionOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDir?: string | undefined;
  readonly pathExists?: ((path: string) => boolean) | undefined;
}

export function resolveAntigravityCliBinaryPath(
  binaryPath?: string | null,
  options: AntigravityCliResolutionOptions = {},
): string {
  const configured = binaryPath?.trim();
  if (configured) {
    return configured;
  }
  const name = "agy";
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolved = resolveExecutable(name, { platform, env });
  if (resolved) {
    return resolved;
  }
  const homeDir =
    options.homeDir ?? env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? nodeOs.homedir();
  const joinPath = platform === "win32" ? nodePath.win32.join : nodePath.posix.join;
  const candidates: string[] = [
    joinPath(homeDir, ".gemini", "antigravity-cli", "bin", name),
    joinPath(homeDir, ".local", "bin", name),
  ];
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA?.trim() ||
      (homeDir ? nodePath.win32.join(homeDir, "AppData", "Local") : undefined);
    if (localAppData) {
      candidates.push(
        nodePath.win32.join(localAppData, "Programs", "antigravity-cli", name),
        nodePath.win32.join(localAppData, "antigravity-cli", "bin", name),
      );
    }
  }
  if (options.pathExists) {
    for (const candidate of candidates) {
      if (platform === "win32") {
        for (const ext of [".exe", ".cmd", ".bat"]) {
          const withExt = `${candidate}${ext}`;
          if (options.pathExists(withExt)) {
            return withExt;
          }
        }
      }
      if (options.pathExists(candidate)) {
        return candidate;
      }
    }
    return name;
  }
  for (const candidate of candidates) {
    const candidateResolved = resolveExecutable(candidate, { platform, env });
    if (candidateResolved) {
      return candidateResolved;
    }
  }
  return name;
}

export function buildAntigravityAcpProcessEnv(
  settings?: AntigravityAcpRuntimeSettings | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const mergedEnv: NodeJS.ProcessEnv = settings?.environment
    ? { ...baseEnv, ...settings.environment }
    : baseEnv;
  return buildProviderChildEnvironment({
    provider: "antigravity",
    baseEnv: mergedEnv,
    overrides: {
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
      SAINT_ANTIGRAVITY_EVENTS: "",
    },
  });
}

export function buildAntigravityAcpSpawnInput(
  settings: AntigravityAcpRuntimeSettings | null | undefined,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): AcpSpawnInput {
  const env = buildAntigravityAcpProcessEnv(settings, baseEnv);
  return {
    command: resolveAntigravityCliBinaryPath(settings?.binaryPath, { env }),
    args: ["acp"],
    cwd,
    env,
  };
}

export const resolveAntigravityAcpAuthMethodId = (
  initializeResult: Acp.InitializeResponse,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string, AcpErrors.AcpError> =>
  Effect.gen(function* () {
    const authMethodIds = availableAuthMethodIds(initializeResult);
    const hasGeminiApiKey = Boolean(env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim());
    if (hasGeminiApiKey && authMethodIds.has("gemini-api-key")) {
      return "gemini-api-key";
    }
    if (env.GOOGLE_APPLICATION_CREDENTIALS?.trim() && authMethodIds.has("agent-platform")) {
      return "agent-platform";
    }
    if (authMethodIds.has("oauth-personal")) {
      return "oauth-personal";
    }
    if (authMethodIds.has("oauth-business")) {
      return "oauth-business";
    }
    const first = [...authMethodIds][0];
    if (first) {
      return first;
    }
    return yield* new AcpErrors.AcpRequestError({
      code: -32602,
      errorMessage: "Antigravity ACP authentication is unavailable.",
      data: {
        authMethods: [...authMethodIds],
        detail: "Run `agy` (or `agy acp --login`) to sign in, or set GEMINI_API_KEY.",
      },
    });
  });

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "authPolicy" | "launchProvider" | "resolveAuthMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly antigravitySettings?: AntigravityAcpRuntimeSettings | null | undefined;
}

export const makeAntigravityAcpRuntime = (
  input: AntigravityAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const spawn = buildAntigravityAcpSpawnInput(input.antigravitySettings, input.cwd);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        launchProvider: "antigravity",
        spawn,
        authPolicy: "on-demand",
        resolveAuthMethodId: (initializeResult) =>
          resolveAntigravityAcpAuthMethodId(initializeResult, spawn.env ?? process.env),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return ServiceMap.getUnsafe(acpContext, AcpSessionRuntime);
  });

const ANTIGRAVITY_MODEL_CONFIG_ID = "model";
const ANTIGRAVITY_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const ANTIGRAVITY_MODE_CONFIG_ID = "mode";
const ANTIGRAVITY_DEFAULT_THOUGHT_LEVEL = "medium";

const THOUGHT_LEVEL_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  thinking: "Thinking",
};

const EFFORT_SORT_ORDER = ["low", "medium", "high", "xhigh", "max", "thinking"] as const;

function formatThoughtLevelLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  return (
    THOUGHT_LEVEL_LABELS[normalized] ?? normalized.charAt(0).toUpperCase() + normalized.slice(1)
  );
}

export interface AntigravityAcpResolvedModelChoice {
  readonly modelConfigId?: string;
  readonly modelValue?: string;
  readonly displayModel: string;
  readonly desiredThoughtLevel?: string;
}

function matchAdvertisedModelOption(
  requestedModel: string,
  options: ReadonlyArray<Acp.SessionConfigSelectOption>,
): Acp.SessionConfigSelectOption | undefined {
  const trimmed = requestedModel.trim();
  if (!trimmed || options.length === 0) {
    return undefined;
  }
  const lowerRequested = trimmed.toLowerCase();
  const parsedRequested = parseAntigravityCliModelLabel(trimmed);
  const baseRequested = (parsedRequested?.model ?? trimmed).trim();
  const lowerBase = baseRequested.toLowerCase();

  for (const option of options) {
    const valueLower = option.value.trim().toLowerCase();
    const nameLower = option.name.trim().toLowerCase();
    if (valueLower === lowerRequested || valueLower === lowerBase) {
      return option;
    }
    if (nameLower === lowerRequested || nameLower === lowerBase) {
      return option;
    }
  }

  for (const option of options) {
    const optionParsed = parseAntigravityCliModelLabel(option.name);
    const optionBase = (optionParsed?.model ?? option.name).trim().toLowerCase();
    if (optionBase === lowerBase) {
      return option;
    }
  }

  if (/^gemini\b.*\bflash\b/iu.test(baseRequested) && !/\bimage\b/iu.test(baseRequested)) {
    const flashCandidate = options.find((option) => {
      const candidateText = `${option.name} ${option.value}`;
      return /\bgemini\b.*\bflash\b/iu.test(candidateText) && !/\bimage\b/iu.test(candidateText);
    });
    if (flashCandidate) {
      return flashCandidate;
    }
  }

  if (/^gemini\b.*\b(?:pro|argon)\b/iu.test(baseRequested)) {
    const proCandidate = options.find((option) => {
      const candidateText = `${option.name} ${option.value}`;
      return /\bgemini\b.*\b(?:pro|argon)\b/iu.test(candidateText);
    });
    if (proCandidate) {
      return proCandidate;
    }
  }

  return undefined;
}

export function resolveAntigravityAcpModelChoice(input: {
  readonly configOptions: ReadonlyArray<Acp.SessionConfigOption>;
  readonly requestedModel?: string | null | undefined;
  readonly modelOptions?: AntigravityModelOptions | null | undefined;
}): AntigravityAcpResolvedModelChoice {
  const rawRequested = input.requestedModel?.trim() || DEFAULT_ANTIGRAVITY_ACP_MODEL;
  const parsedRequested = parseAntigravityCliModelLabel(rawRequested);
  const fallbackDisplayModel = parsedRequested?.model ?? rawRequested;

  const modelConfig = findSelectConfig(input.configOptions, {
    id: ANTIGRAVITY_MODEL_CONFIG_ID,
    category: "model",
  });
  const selectOptions = modelConfig ? flattenConfigOptions(modelConfig.options) : [];
  const matchedOption = matchAdvertisedModelOption(rawRequested, selectOptions);
  const displayModel = matchedOption
    ? (parseAntigravityCliModelLabel(matchedOption.name)?.model ?? matchedOption.name.trim())
    : fallbackDisplayModel;

  const isGeminiModel = /^gemini\b/iu.test(displayModel);
  const fastModeEffort = input.modelOptions?.fastMode === true && isGeminiModel ? "low" : undefined;
  const explicitEffort =
    parsedRequested?.effort?.trim().toLowerCase() ??
    fastModeEffort ??
    input.modelOptions?.reasoningEffort?.trim().toLowerCase() ??
    (isGeminiModel ? ANTIGRAVITY_DEFAULT_THOUGHT_LEVEL : undefined);

  return {
    ...(modelConfig ? { modelConfigId: modelConfig.id } : {}),
    ...(matchedOption
      ? { modelValue: matchedOption.value }
      : modelConfig
        ? { modelValue: rawRequested }
        : {}),
    displayModel,
    ...(explicitEffort ? { desiredThoughtLevel: explicitEffort } : {}),
  };
}

export interface AntigravityAcpModelSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method: "session/set_config_option" | "session/get_config_options";
}

export interface AntigravityAcpAppliedModelResult {
  readonly model: string;
  readonly modelValue?: string;
  readonly thoughtLevel?: string;
}

export function applyAntigravityAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getConfigOptions" | "setConfigOption">;
  readonly model?: string | null | undefined;
  readonly modelOptions?: AntigravityModelOptions | null | undefined;
  readonly mapError: (context: AntigravityAcpModelSelectionErrorContext) => E;
}): Effect.Effect<AntigravityAcpAppliedModelResult, E> {
  return Effect.gen(function* () {
    const getOptions = input.runtime.getConfigOptions.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/get_config_options" })),
    );
    const setOption = (configId: string, value: string) =>
      input.runtime
        .setConfigOption(configId, value)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, method: "session/set_config_option" }),
          ),
        );

    const initialConfigOptions = yield* getOptions;
    const choice = resolveAntigravityAcpModelChoice({
      configOptions: initialConfigOptions,
      requestedModel: input.model,
      modelOptions: input.modelOptions,
    });

    if (choice.modelConfigId && choice.modelValue) {
      yield* setOption(choice.modelConfigId, choice.modelValue);
    }

    const updatedConfigOptions = yield* getOptions;
    const thoughtConfig = findSelectConfig(updatedConfigOptions, {
      id: ANTIGRAVITY_THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
    });
    let appliedThoughtLevel: string | undefined;
    if (thoughtConfig && choice.desiredThoughtLevel) {
      const allowedThoughtLevels = new Set(
        flattenConfigOptions(thoughtConfig.options).map((option) => option.value),
      );
      if (allowedThoughtLevels.has(choice.desiredThoughtLevel)) {
        yield* setOption(thoughtConfig.id, choice.desiredThoughtLevel);
        appliedThoughtLevel = choice.desiredThoughtLevel;
      }
    }

    return {
      model: choice.displayModel,
      ...(choice.modelValue ? { modelValue: choice.modelValue } : {}),
      ...(appliedThoughtLevel ? { thoughtLevel: appliedThoughtLevel } : {}),
    };
  });
}

export interface AntigravityAcpModeSelectionErrorContext {
  readonly cause: AcpErrors.AcpError;
  readonly method:
    | "session/set_mode"
    | "session/set_config_option"
    | "session/get_mode_state"
    | "session/get_config_options";
}

export function resolveAntigravityAcpModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly availableModeIds: ReadonlySet<string>;
}): Effect.Effect<string | undefined, ProviderAdapterValidationError> {
  const { runtimeMode, interactionMode, availableModeIds } = input;
  const targetModeId =
    interactionMode === "plan" ? "plan" : runtimeMode === "auto" ? "auto" : "default";

  if (availableModeIds.size === 0) {
    const requiredBy =
      interactionMode === "plan"
        ? "plan interaction mode"
        : runtimeMode === "approval-required" || runtimeMode === "auto"
          ? `runtime mode "${runtimeMode}"`
          : undefined;
    if (requiredBy) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: "antigravity",
          operation: "resolveAntigravityAcpModeId",
          issue: `Requested ${requiredBy} requires the ACP session to expose modes, but none were reported.`,
        }),
      );
    }
    return Effect.succeed(undefined);
  }

  if (!availableModeIds.has(targetModeId)) {
    if (runtimeMode === "full-access" && interactionMode !== "plan") {
      return Effect.succeed(undefined);
    }
    const requiredBy =
      interactionMode === "plan" ? "plan interaction mode" : `runtime mode "${runtimeMode}"`;
    return Effect.fail(
      new ProviderAdapterValidationError({
        provider: "antigravity",
        operation: "resolveAntigravityAcpModeId",
        issue: `Requested ${requiredBy} does not match any available ACP mode. Available modes: ${[
          ...availableModeIds,
        ].join(", ")}`,
      }),
    );
  }

  return Effect.succeed(targetModeId);
}

export function applyAntigravityAcpInteractionMode<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "getModeState" | "setConfigOption" | "setMode"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly mapError: (context: AntigravityAcpModeSelectionErrorContext) => E;
}): Effect.Effect<void, E | ProviderAdapterValidationError> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/get_mode_state" })),
    );
    const configOptions = yield* input.runtime.getConfigOptions.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/get_config_options" })),
    );
    const modeConfig = findSelectConfig(configOptions, {
      id: ANTIGRAVITY_MODE_CONFIG_ID,
      category: "mode",
    });

    const availableModeIds = new Set<string>([
      ...(modeState?.availableModes.map((mode) => mode.id) ?? []),
      ...(modeConfig ? flattenConfigOptions(modeConfig.options).map((opt) => opt.value) : []),
    ]);
    const targetModeId = yield* resolveAntigravityAcpModeId({
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      availableModeIds,
    });
    if (!targetModeId) {
      return;
    }

    const currentModeId =
      modeState?.currentModeId ??
      (typeof modeConfig?.currentValue === "string" ? modeConfig.currentValue : undefined);
    if (currentModeId === targetModeId) {
      return;
    }

    const modeAdvertisedInState =
      modeState?.availableModes.some((mode) => mode.id === targetModeId) ?? false;
    const modeAdvertisedInConfig =
      modeConfig !== undefined &&
      flattenConfigOptions(modeConfig.options).some((option) => option.value === targetModeId);

    if (modeAdvertisedInState) {
      yield* input.runtime.setMode(targetModeId).pipe(
        Effect.catch((setModeError) =>
          modeAdvertisedInConfig && modeConfig
            ? input.runtime.setConfigOption(modeConfig.id, targetModeId).pipe(
                Effect.asVoid,
                Effect.mapError((cause) =>
                  input.mapError({ cause, method: "session/set_config_option" }),
                ),
              )
            : Effect.fail(input.mapError({ cause: setModeError, method: "session/set_mode" })),
        ),
      );
      return;
    }

    if (modeAdvertisedInConfig && modeConfig) {
      yield* input.runtime.setConfigOption(modeConfig.id, targetModeId).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => input.mapError({ cause, method: "session/set_config_option" })),
      );
    }
  });
}

export interface AntigravityAcpModelInfo {
  readonly modelId?: string | undefined;
  readonly name: string;
}

function collectAvailableModelEffortsBySlug(
  availableModels: ReadonlyArray<AntigravityAcpModelInfo> | null | undefined,
): Map<string, ReadonlyArray<{ readonly value: string; readonly label: string }>> {
  const grouped = new Map<string, string[]>();
  if (!availableModels) {
    return new Map();
  }
  for (const model of availableModels) {
    const parsed = parseAntigravityCliModelLabel(model.name);
    const slug = (parsed?.model ?? model.name).trim().toLowerCase();
    const effort = parsed?.effort?.trim().toLowerCase();
    if (!slug || !effort) {
      continue;
    }
    const existing = grouped.get(slug) ?? [];
    if (!existing.includes(effort)) {
      existing.push(effort);
      grouped.set(slug, existing);
    }
  }
  const result = new Map<
    string,
    ReadonlyArray<{ readonly value: string; readonly label: string }>
  >();
  for (const [slug, efforts] of grouped) {
    const sorted = efforts.toSorted((left, right) => {
      const leftIndex = EFFORT_SORT_ORDER.indexOf(left as (typeof EFFORT_SORT_ORDER)[number]);
      const rightIndex = EFFORT_SORT_ORDER.indexOf(right as (typeof EFFORT_SORT_ORDER)[number]);
      return (
        (leftIndex < 0 ? EFFORT_SORT_ORDER.length : leftIndex) -
        (rightIndex < 0 ? EFFORT_SORT_ORDER.length : rightIndex)
      );
    });
    result.set(
      slug,
      sorted.map((value) => ({ value, label: formatThoughtLevelLabel(value) })),
    );
  }
  return result;
}

export function parseAntigravityAcpConfigModels(
  configOptions: ReadonlyArray<Acp.SessionConfigOption>,
  availableModels?: ReadonlyArray<AntigravityAcpModelInfo> | null,
): ReadonlyArray<ProviderModelDescriptor> {
  const modelConfig = findSelectConfig(configOptions, {
    id: ANTIGRAVITY_MODEL_CONFIG_ID,
    category: "model",
  });
  if (!modelConfig) {
    return [];
  }
  const thoughtConfig = findSelectConfig(configOptions, {
    id: ANTIGRAVITY_THOUGHT_LEVEL_CONFIG_ID,
    category: "thought_level",
  });
  const advertisedThoughtEfforts = thoughtConfig
    ? flattenConfigOptions(thoughtConfig.options).map((option) => {
        const value = option.value.trim().toLowerCase();
        return {
          value,
          label:
            THOUGHT_LEVEL_LABELS[value] ??
            (option.name.trim() || formatThoughtLevelLabel(option.value)),
        };
      })
    : [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ];
  const effortsBySlug = collectAvailableModelEffortsBySlug(availableModels);

  const seen = new Set<string>();
  const descriptors: ProviderModelDescriptor[] = [];
  for (const option of flattenConfigOptions(modelConfig.options)) {
    const parsed = parseAntigravityCliModelLabel(option.name);
    const slug = (parsed?.model ?? option.name).trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const isGemini = /^gemini\b/iu.test(slug);
    const fixedEffort = parsed?.effort?.trim().toLowerCase();
    const geminiEfforts = effortsBySlug.get(slug.toLowerCase()) ?? advertisedThoughtEfforts;
    const supportedReasoningEfforts = isGemini
      ? geminiEfforts
      : fixedEffort
        ? [{ value: fixedEffort, label: formatThoughtLevelLabel(fixedEffort) }]
        : [];
    const defaultReasoningEffort = isGemini
      ? geminiEfforts.some((entry) => entry.value === ANTIGRAVITY_DEFAULT_THOUGHT_LEVEL)
        ? ANTIGRAVITY_DEFAULT_THOUGHT_LEVEL
        : geminiEfforts[0]?.value
      : fixedEffort;

    descriptors.push({
      slug,
      name: slug,
      ...(supportedReasoningEfforts.length > 0
        ? {
            supportedReasoningEfforts,
            ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          }
        : {}),
    });
  }
  return descriptors;
}

export function buildAntigravityPromptUsageSnapshot(input: {
  readonly usage: Acp.Usage | null | undefined;
  readonly model: string;
  readonly previousTotalProcessedTokens: number;
  readonly maxTokens?: number | undefined;
  readonly currentContextUsedTokens?: number | undefined;
}):
  | {
      readonly snapshot: ThreadTokenUsageSnapshot;
      readonly nextTotalProcessedTokens: number;
    }
  | undefined {
  const usage = input.usage;
  if (!usage) {
    return undefined;
  }
  const inputTokens = nonNegativeInteger(usage.inputTokens) ?? 0;
  const cachedReadTokens = nonNegativeInteger(usage.cachedReadTokens) ?? 0;
  const cachedWriteTokens = nonNegativeInteger(usage.cachedWriteTokens) ?? 0;
  const cachedInputTokens = cachedReadTokens + cachedWriteTokens;
  const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
  const reasoningOutputTokens = nonNegativeInteger(usage.thoughtTokens) ?? 0;
  const explicitTotal = nonNegativeInteger(usage.totalTokens);
  const computedTotal = inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  const turnTotalTokens = explicitTotal && explicitTotal > 0 ? explicitTotal : computedTotal;
  // Prompt completion usage from `agy acp` sums every step in a multi-step tool loop.
  // When live `usage_update` notifications already reported the current context-window
  // occupancy during the turn, keep that occupancy for `usedTokens` and record the
  // multi-step total in `totalProcessedTokens`.
  const contextUsedTokens = positiveInteger(input.currentContextUsedTokens);
  const usedTokens = contextUsedTokens ?? turnTotalTokens;
  if (usedTokens <= 0) {
    return undefined;
  }
  const maxTokens =
    positiveInteger(input.maxTokens) ?? resolveAntigravityModelMaxTokens(input.model);
  const usedPercent = computeUsagePercent(usedTokens, maxTokens);
  const nextTotalProcessedTokens = Math.max(
    input.previousTotalProcessedTokens + outputTokens + reasoningOutputTokens,
    turnTotalTokens,
    usedTokens,
  );
  return {
    nextTotalProcessedTokens,
    snapshot: {
      usedTokens,
      totalProcessedTokens: nextTotalProcessedTokens,
      maxTokens,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      lastUsedTokens: usedTokens,
      lastInputTokens: inputTokens,
      lastCachedInputTokens: cachedInputTokens,
      lastOutputTokens: outputTokens,
      lastReasoningOutputTokens: reasoningOutputTokens,
      compactsAutomatically: true,
    },
  };
}
