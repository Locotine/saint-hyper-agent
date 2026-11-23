// FILE: AntigravityAcpAdapter.ts
// Purpose: Antigravity CLI (`agy acp`) long-lived session adapter on AcpSessionRuntime.
// Layer: Provider adapter
// Exports: makeAntigravityAcpAdapterLive and Antigravity ACP helpers.

import type * as Acp from "@agentclientprotocol/sdk";
import {
  type AntigravityModelOptions,
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@saint/contracts";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type SaintHarnessPolicyDeliveryState,
  takeSaintHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { buildAcpSaintMcpServers } from "../../agentGateway/mcpInjection.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  captureAgentGatewayCapabilityInput,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewayCapabilityInput,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  acceptAcpPlanUpdate,
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  forkAcpAdapterTurnIdleWatchdog,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  ACP_SUBAGENT_TOOL_KIND,
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { makeAcpDebugLoggers, makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  type AcpPlanUpdate,
  type AcpToolCallState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyAntigravityAcpInteractionMode,
  applyAntigravityAcpModelSelection,
  type AntigravityAcpModelInfo,
  type AntigravityAcpRuntimeSettings,
  buildAntigravityAcpProcessEnv,
  buildAntigravityPromptUsageSnapshot,
  DEFAULT_ANTIGRAVITY_ACP_MODEL,
  makeAntigravityAcpRuntime,
  parseAntigravityAcpConfigModels,
  resolveAntigravityCliBinaryPath,
} from "../acp/AntigravityAcpSupport.ts";
import { forkViaAcpRuntime } from "../acp/acpFork.ts";
import { makeSessionTeardownGate } from "../acp/SessionTeardownGate.ts";
import { cancelTurnAndWait } from "../acp/TurnCancellation.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { extractTerminalPlanMarkdown } from "../planMode.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  AntigravityAdapter,
  type AntigravityAdapterShape,
} from "../Services/AntigravityAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { snapshotProviderTurns } from "../snapshotProviderTurns.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "antigravity" as const;

export const takeAntigravitySaintHarnessPolicyTextPart = (
  state: SaintHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSaintHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });

const ANTIGRAVITY_ACP_TRANSPORT_DEBUG_MARKER = "antigravity-acp-v1";
const ANTIGRAVITY_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const ANTIGRAVITY_ACP_DEBUG_ENV = "SAINT_ANTIGRAVITY_ACP_DEBUG";
const ANTIGRAVITY_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const ANTIGRAVITY_TURN_SETTLE_DRAIN_POLL_MS = 25;
const ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SAINT_ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const ANTIGRAVITY_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const ANTIGRAVITY_NESTED_TASK_IDLE_TIMEOUT_MS = 60 * 60_000;
const ANTIGRAVITY_CANCEL_GRACE_MS = 5_000;
const ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_STARTUP_REPLAY_MAX_WAIT_MS = 3_000;
const ANTIGRAVITY_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const ANTIGRAVITY_COMMAND_DISCOVERY_WAIT_MS = 500;
const ANTIGRAVITY_COMMAND_DISCOVERY_POLL_MS = 25;
/**
 * Maximum silence before orphaned Antigravity background tasks/subagents are
 * auto-settled so idle reaping can eventually reclaim abandoned sessions.
 */
const ANTIGRAVITY_BACKGROUND_TASK_MAX_SILENT_MS = 30 * 60_000;

function antigravityModelSelectionKey(
  model: string,
  modelOptions: AntigravityModelOptions | undefined,
): string {
  const entries = modelOptions
    ? Object.entries(modelOptions)
        .filter(([, value]) => value !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
    : [];
  return JSON.stringify([model.trim(), entries]);
}

function antigravityInteractionModeKey(
  runtimeMode: ProviderSession["runtimeMode"],
  interactionMode: ProviderInteractionMode,
): string {
  return `${runtimeMode}:${interactionMode}`;
}

function readDiscoveryAvailableCommands(
  runtime: Pick<AcpSessionRuntimeShape, "getAvailableCommands">,
): Effect.Effect<ReadonlyArray<Acp.AvailableCommand>> {
  return Effect.gen(function* () {
    const deadline = Date.now() + ANTIGRAVITY_COMMAND_DISCOVERY_WAIT_MS;
    while (true) {
      const commands = yield* runtime.getAvailableCommands.pipe(
        Effect.timeoutOption(2_000),
        Effect.map(Option.getOrElse((): ReadonlyArray<Acp.AvailableCommand> => [])),
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<Acp.AvailableCommand>)),
      );
      if (commands.length > 0 || Date.now() >= deadline) {
        return commands;
      }
      yield* Effect.sleep(ANTIGRAVITY_COMMAND_DISCOVERY_POLL_MS);
    }
  });
}

const ANTIGRAVITY_PLAN_MODE_PROMPT_PREFIX = [
  "Saint Antigravity plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

function antigravityAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `Antigravity ACP did not respond to ${method} within ${ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

function runAntigravityAcpConfigurationAfterReplay<A, E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "awaitLoadReplayReady">;
  readonly threadId: ThreadId;
  readonly effect: Effect.Effect<A, E>;
}): Effect.Effect<A, E | ProviderAdapterError> {
  return input.runtime.awaitLoadReplayReady.pipe(
    Effect.mapError((cause) =>
      mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
    ),
    Effect.andThen(
      input.effect.pipe(
        Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(antigravityAcpTimeoutError("session/set_config_option")),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
  );
}

function isAntigravityAcpDebugEnabled(): boolean {
  return process.env[ANTIGRAVITY_ACP_DEBUG_ENV] === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the configured binary path and discovery cache key shared by
 * `listModels` and `listCommands` so cached slash commands stay scoped to the
 * same resolved binary path and environment.
 */
export function resolveAntigravityDiscoveryCacheKey(input: {
  readonly binaryPath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}): {
  readonly configuredBinaryPath: string | undefined;
  readonly cacheKey: string;
} {
  const configuredBinaryPath = input.binaryPath?.trim() || undefined;
  const discoveryEnv = buildAntigravityAcpProcessEnv(
    configuredBinaryPath !== undefined || input.environment !== undefined
      ? {
          ...(configuredBinaryPath !== undefined ? { binaryPath: configuredBinaryPath } : {}),
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        }
      : undefined,
  );
  const resolvedBinaryPath = resolveAntigravityCliBinaryPath(configuredBinaryPath, {
    env: discoveryEnv,
  });
  const environmentEntries =
    input.environment !== undefined
      ? Object.entries(input.environment).toSorted(([left], [right]) => left.localeCompare(right))
      : [];
  const normalizedEnvironment =
    environmentEntries.length > 0 ? Object.fromEntries(environmentEntries) : null;
  return {
    configuredBinaryPath,
    cacheKey: [resolvedBinaryPath, JSON.stringify(normalizedEnvironment)].join("\u0000"),
  };
}

export function resolveAntigravitySessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
  sessionCwd?: string,
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    sessionCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

export function extractAntigravityResumeSessionId(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["sessionId", "conversationId", "providerThreadId", "id"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

export function scopeAntigravityRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

export function isRenderableAntigravityAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

export function isAntigravityNestedTaskToolCall(toolCall: AcpToolCallState): boolean {
  if (toolCall.kind === ACP_SUBAGENT_TOOL_KIND || toolCall.data.tool === "task") {
    return true;
  }
  const normalizedTitle = toolCall.title?.trim().toLowerCase();
  if (normalizedTitle === "run invoke_subagent" || normalizedTitle === "invoke_subagent") {
    return true;
  }
  const rawInput = toolCall.data.rawInput;
  if (isRecord(rawInput)) {
    if (typeof rawInput.TypeName === "string" && typeof rawInput.Prompt === "string") {
      return true;
    }
  }
  return false;
}

function extractAntigravityToolOutputText(toolCall: AcpToolCallState): string {
  const parts: string[] = [];
  if (typeof toolCall.detail === "string" && toolCall.detail.trim().length > 0) {
    parts.push(toolCall.detail);
  }
  const rawOutput = toolCall.data.rawOutput;
  if (typeof rawOutput === "string") {
    parts.push(rawOutput);
  } else if (isRecord(rawOutput)) {
    for (const key of ["output", "result", "message", "text", "summary", "status"]) {
      const value = rawOutput[key];
      if (typeof value === "string" && value.trim().length > 0) {
        parts.push(value);
      }
    }
    if (
      typeof rawOutput.conversationId === "string" &&
      rawOutput.conversationId.trim().length > 0
    ) {
      parts.push(`conversationId=${rawOutput.conversationId}`);
    }
    if (typeof rawOutput.taskId === "string" && rawOutput.taskId.trim().length > 0) {
      parts.push(`taskId=${rawOutput.taskId}`);
    }
  }
  const content = Array.isArray(toolCall.data.content) ? toolCall.data.content : [];
  for (const entry of content) {
    if (isRecord(entry)) {
      if (typeof entry.text === "string") {
        parts.push(entry.text);
      } else if (isRecord(entry.content) && typeof entry.content.text === "string") {
        parts.push(entry.content.text);
      }
    }
  }
  return parts.join("\n");
}

function normalizedAntigravityToolName(toolCall: AcpToolCallState): string {
  const rawTool = typeof toolCall.data.tool === "string" ? toolCall.data.tool : "";
  const title = toolCall.title ?? "";
  return (rawTool || title).trim().toLowerCase();
}

export function isAntigravityBackgroundCommandToolCall(toolCall: AcpToolCallState): boolean {
  if (toolCall.kind !== "execute") {
    return false;
  }
  const rawInput = toolCall.data.rawInput;
  if (isRecord(rawInput) && typeof rawInput.WaitMsBeforeAsync === "number") {
    return true;
  }
  const outputText = extractAntigravityToolOutputText(toolCall);
  if (outputText.length > 0) {
    return /background task|running in the background|command is still running/iu.test(outputText);
  }
  return false;
}

/**
 * True when an Antigravity command/workflow/schedule actually detached into the
 * background inside the `agy acp` process and continues running after the tool
 * call itself returns.
 */
export function isAntigravityBackgroundCommandLaunched(toolCall: AcpToolCallState): boolean {
  const rawInput = toolCall.data.rawInput;
  const toolName = normalizedAntigravityToolName(toolCall);
  if (toolCall.kind === "execute" && isRecord(rawInput) && rawInput.IsDaemon === true) {
    return true;
  }
  if (toolName.includes("schedule") || toolName.includes("run_workflow")) {
    const outputText = extractAntigravityToolOutputText(toolCall);
    return (
      toolCall.status !== "failed" &&
      (!outputText ||
        !/completed synchronously|exited with code|failed|error/iu.test(outputText) ||
        /running in the background|background task|task id|scheduled/iu.test(outputText))
    );
  }
  if (toolCall.kind !== "execute") {
    return false;
  }
  const outputText = extractAntigravityToolOutputText(toolCall);
  return /running in the background|background task with task id|command is still running|backgrounded/iu.test(
    outputText,
  );
}

/**
 * True when `invoke_subagent` returned an asynchronous launch handle (such as a
 * `conversationId` or background-launch notice) rather than a synchronous final
 * subagent result.
 */
export function isAntigravityAsyncSubagentLaunched(toolCall: AcpToolCallState): boolean {
  if (!isAntigravityNestedTaskToolCall(toolCall) || toolCall.status !== "completed") {
    return false;
  }
  const rawOutput = toolCall.data.rawOutput;
  if (isRecord(rawOutput) && typeof rawOutput.conversationId === "string") {
    const status = typeof rawOutput.status === "string" ? rawOutput.status.toLowerCase() : "";
    if (status !== "completed" && status !== "failed" && status !== "cancelled") {
      return true;
    }
  }
  const outputText = extractAntigravityToolOutputText(toolCall);
  if (outputText.length === 0) {
    return false;
  }
  return /running in the background|runs in the background|launched.*background|conversationid\s*[:=]/iu.test(
    outputText,
  );
}

export function extractAntigravityBackgroundExternalId(
  toolCall: AcpToolCallState,
): string | undefined {
  const rawOutput = toolCall.data.rawOutput;
  if (isRecord(rawOutput)) {
    for (const key of ["taskId", "TaskId", "conversationId", "ConversationId", "id"]) {
      const value = rawOutput[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  const outputText = extractAntigravityToolOutputText(toolCall);
  const taskMatch = /task\s*id\s*[:=]\s*["']?([A-Za-z0-9/_:-]+)["']?/iu.exec(outputText);
  if (taskMatch?.[1]) {
    return taskMatch[1];
  }
  const conversationMatch = /conversation\s*id\s*[:=]\s*["']?([A-Za-z0-9/_:-]+)["']?/iu.exec(
    outputText,
  );
  if (conversationMatch?.[1]) {
    return conversationMatch[1];
  }
  return undefined;
}

export function extractAntigravitySettledBackgroundTasks(toolCall: AcpToolCallState): {
  readonly settleAllSubagents: boolean;
  readonly externalIds: ReadonlyArray<string>;
} {
  const toolName = normalizedAntigravityToolName(toolCall);
  const rawInput = toolCall.data.rawInput;
  if (!isRecord(rawInput)) {
    return { settleAllSubagents: false, externalIds: [] };
  }
  if (toolName.includes("manage_subagents")) {
    const action = typeof rawInput.Action === "string" ? rawInput.Action.toLowerCase() : "";
    if (action === "kill_all") {
      return { settleAllSubagents: true, externalIds: [] };
    }
    if (action === "kill" && Array.isArray(rawInput.ConversationIds)) {
      return {
        settleAllSubagents: false,
        externalIds: rawInput.ConversationIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ).map((id) => id.trim()),
      };
    }
  }
  if (toolName.includes("manage_task")) {
    const action = typeof rawInput.Action === "string" ? rawInput.Action.toLowerCase() : "";
    const taskId =
      typeof rawInput.TaskId === "string" && rawInput.TaskId.trim().length > 0
        ? rawInput.TaskId.trim()
        : undefined;
    if (action === "kill" && taskId) {
      return { settleAllSubagents: false, externalIds: [taskId] };
    }
    if (action === "status" && taskId && toolCall.status === "completed") {
      const outputText = extractAntigravityToolOutputText(toolCall);
      if (/\b(?:completed|exited|failed|cancelled|canceled|stopped)\b/iu.test(outputText)) {
        return { settleAllSubagents: false, externalIds: [taskId] };
      }
    }
  }
  return { settleAllSubagents: false, externalIds: [] };
}

export function extractAntigravityPlanArtifactMarkdown(
  toolCall: AcpToolCallState,
): string | undefined {
  if (toolCall.kind !== "edit") {
    return undefined;
  }
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  const locations = Array.isArray(toolCall.data.locations) ? toolCall.data.locations : [];
  const locationPath = locations.find(
    (entry): entry is { readonly path: string } =>
      isRecord(entry) && typeof entry.path === "string",
  )?.path;
  const inputPath = typeof rawInput?.Path === "string" ? rawInput.Path : undefined;
  const targetPath = (inputPath ?? locationPath ?? toolCall.detail ?? "").trim();
  if (!/(?:^|[\\/_-])plan\.md$/iu.test(targetPath)) {
    return undefined;
  }
  const rawContent = typeof rawInput?.Content === "string" ? rawInput.Content.trim() : "";
  if (rawContent.length > 0) {
    return rawContent;
  }
  const contentEntries = Array.isArray(toolCall.data.content) ? toolCall.data.content : [];
  for (const entry of contentEntries) {
    if (
      isRecord(entry) &&
      entry.type === "diff" &&
      typeof entry.newText === "string" &&
      entry.newText.trim().length > 0
    ) {
      return entry.newText.trim();
    }
  }
  return undefined;
}

export function shouldIgnoreAntigravityInterrupt(
  requestedTurnId: TurnId | undefined,
  activeTurnId: TurnId | undefined,
): boolean {
  return requestedTurnId !== undefined && requestedTurnId !== activeTurnId;
}

export interface AntigravityAcpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeRuntime?: typeof makeAntigravityAcpRuntime;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface AntigravityBackgroundTaskRecord {
  readonly taskId: string;
  readonly kind: "subagent" | "command" | "workflow" | "schedule";
  readonly turnId: TurnId;
  readonly externalId?: string | undefined;
  readonly description?: string | undefined;
}

interface AntigravityAcpSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly enableComputerControl?: boolean;
  readonly capabilityInput: AgentGatewayCapabilityInput;
  gatewaySessionLease?: AgentGatewaySessionLease;
  gatewayCredentialRetired: boolean;
  gatewayCredentialRenewable: boolean;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  modelOptions?: AntigravityModelOptions | undefined;
  appliedModelSelectionKeys: Set<string>;
  appliedInteractionModeKey: string | undefined;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activePlanResponseText: string;
  activePlanArtifactMarkdown: string | undefined;
  lastContextWindowSize: number | undefined;
  activeTurnContextUsedTokens: number | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeReasoningBlock:
    | { readonly turnId: TurnId; readonly itemId: RuntimeItemId; text: string }
    | undefined;
  reasoningSegmentIndex: number;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  readonly turnToolCallIds: Map<string, TurnId>;
  lastSettledTurnId: TurnId | undefined;
  readonly lastSettledAssistantItemsWithContent: Set<string>;
  readonly activeNestedTaskToolCallIds: Set<string>;
  readonly nestedTaskLifecycleByToolCallId: Map<string, "active" | "completed">;
  /** Background tasks/subagents surviving past their launching tool call / turn. */
  readonly activeBackgroundTasks: Map<string, AntigravityBackgroundTaskRecord>;
  backgroundTaskExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  /** True when the active turn launched a subagent or background command that may run quietly. */
  turnHasNestedWork: boolean;
  totalProcessedTokens: number;
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  readonly teardownComplete: Deferred.Deferred<void>;
  latestSessionCostUsd: number | undefined;
  sessionUpdatesProcessed: number;
  turnStarting: boolean;
  pendingTurnInterrupted: boolean;
  stopped: boolean;
}

const makeAntigravityAcpAdapter = (options?: AntigravityAcpAdapterLiveOptions) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeFactory = options?.makeRuntime ?? makeAntigravityAcpRuntime;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, AntigravityAcpSessionContext>();
    const sessionTeardownGate = makeSessionTeardownGate();
    const withThreadLock = yield* makeAcpThreadLock();
    const discoveryLock = yield* Semaphore.make(1);
    const modelDiscoveryCache = new Map<
      string,
      {
        readonly models: ReadonlyArray<ProviderModelDescriptor>;
        readonly commands: ReadonlyArray<Acp.AvailableCommand>;
        readonly expiresAt: number;
      }
    >();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

    const logNative = (threadId: ThreadId, method: string, payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              threadId,
              createdAt: observedAt,
              method,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: AntigravityAcpSessionContext,
      payload: AcpPlanUpdate,
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId === undefined || !acceptAcpPlanUpdate(ctx, payload)) {
          return;
        }
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const clearBackgroundTaskExpiryTimer = (ctx: AntigravityAcpSessionContext) => {
      if (ctx.backgroundTaskExpiryTimer !== undefined) {
        clearTimeout(ctx.backgroundTaskExpiryTimer);
        ctx.backgroundTaskExpiryTimer = undefined;
      }
    };

    const settleTrackedBackgroundTasks = (
      ctx: AntigravityAcpSessionContext,
      taskIds: ReadonlyArray<string>,
      status: "completed" | "stopped" | "failed",
    ) =>
      Effect.gen(function* () {
        for (const taskId of taskIds) {
          const tracked = ctx.activeBackgroundTasks.get(taskId);
          if (!tracked) {
            continue;
          }
          ctx.activeBackgroundTasks.delete(taskId);
          ctx.activeNestedTaskToolCallIds.delete(taskId);
          ctx.nestedTaskLifecycleByToolCallId.set(taskId, "completed");
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: tracked.turnId,
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(taskId),
              status,
            },
          });
        }
        if (ctx.activeBackgroundTasks.size === 0) {
          clearBackgroundTaskExpiryTimer(ctx);
        }
      });

    const refreshBackgroundTaskExpiryTimer = (ctx: AntigravityAcpSessionContext) => {
      clearBackgroundTaskExpiryTimer(ctx);
      if (ctx.stopped || ctx.activeBackgroundTasks.size === 0) {
        return;
      }
      const timer = setTimeout(() => {
        ctx.backgroundTaskExpiryTimer = undefined;
        if (ctx.stopped || ctx.activeBackgroundTasks.size === 0) {
          return;
        }
        const remaining = Array.from(ctx.activeBackgroundTasks.keys());
        void Effect.runPromise(settleTrackedBackgroundTasks(ctx, remaining, "completed")).catch(
          () => undefined,
        );
      }, ANTIGRAVITY_BACKGROUND_TASK_MAX_SILENT_MS);
      timer.unref?.();
      ctx.backgroundTaskExpiryTimer = timer;
    };

    const emitNestedTaskLifecycle = (
      ctx: AntigravityAcpSessionContext,
      toolCall: AcpToolCallState,
      turnId: TurnId,
    ) =>
      Effect.gen(function* () {
        // Explicit management calls (`manage_task` kill/status, `manage_subagents` kill/kill_all)
        // settle previously tracked background work so idle reaping can resume once done.
        const settled = extractAntigravitySettledBackgroundTasks(toolCall);
        if (settled.settleAllSubagents) {
          const subagentTaskIds = Array.from(ctx.activeBackgroundTasks.values())
            .filter((entry) => entry.kind === "subagent")
            .map((entry) => entry.taskId);
          yield* settleTrackedBackgroundTasks(ctx, subagentTaskIds, "stopped");
        }
        if (settled.externalIds.length > 0) {
          const matchedTaskIds = Array.from(ctx.activeBackgroundTasks.values())
            .filter(
              (entry) =>
                settled.externalIds.includes(entry.taskId) ||
                (entry.externalId !== undefined && settled.externalIds.includes(entry.externalId)),
            )
            .map((entry) => entry.taskId);
          yield* settleTrackedBackgroundTasks(ctx, matchedTaskIds, "completed");
        }

        if (isAntigravityBackgroundCommandToolCall(toolCall)) {
          ctx.turnHasNestedWork = true;
        }

        if (isAntigravityBackgroundCommandLaunched(toolCall)) {
          ctx.turnHasNestedWork = true;
          const externalId = extractAntigravityBackgroundExternalId(toolCall);
          const taskId = externalId ?? toolCall.toolCallId;
          if (!ctx.activeBackgroundTasks.has(taskId)) {
            const toolName = normalizedAntigravityToolName(toolCall);
            const kind = toolName.includes("schedule")
              ? "schedule"
              : toolName.includes("run_workflow")
                ? "workflow"
                : "command";
            const description = toolCall.title ?? toolCall.detail;
            ctx.activeBackgroundTasks.set(taskId, {
              taskId,
              kind,
              turnId,
              ...(externalId ? { externalId } : {}),
              ...(description ? { description } : {}),
            });
            refreshBackgroundTaskExpiryTimer(ctx);
            yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(taskId),
                taskType: kind === "command" ? "background_command" : kind,
                ...(description ? { description } : {}),
              },
            });
          } else {
            refreshBackgroundTaskExpiryTimer(ctx);
          }
          if (!isAntigravityNestedTaskToolCall(toolCall)) {
            return;
          }
        }

        if (!isAntigravityNestedTaskToolCall(toolCall)) {
          return;
        }
        ctx.turnHasNestedWork = true;
        const previous = ctx.nestedTaskLifecycleByToolCallId.get(toolCall.toolCallId);
        const terminal = toolCall.status === "completed" || toolCall.status === "failed";
        if (terminal) {
          // Asynchronous `invoke_subagent` launches return immediately with a
          // `conversationId` while the subagent continues running in the `agy acp`
          // process. Keep it registered as a live background task so Saint's idle
          // reaper and Host Economy do not kill the process underneath it.
          if (isAntigravityAsyncSubagentLaunched(toolCall)) {
            const externalId = extractAntigravityBackgroundExternalId(toolCall);
            const rawInput = toolCall.data.rawInput;
            const description =
              isRecord(rawInput) && typeof rawInput.Role === "string" && rawInput.Role.trim()
                ? rawInput.Role.trim()
                : (toolCall.title ?? toolCall.detail);
            if (previous === undefined) {
              ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "active");
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "task.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: {
                  taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
                  taskType: "subagent",
                  ...(description ? { description } : {}),
                },
              });
            }
            ctx.activeBackgroundTasks.set(toolCall.toolCallId, {
              taskId: toolCall.toolCallId,
              kind: "subagent",
              turnId,
              ...(externalId ? { externalId } : {}),
              ...(description ? { description } : {}),
            });
            refreshBackgroundTaskExpiryTimer(ctx);
            return;
          }
          ctx.activeNestedTaskToolCallIds.delete(toolCall.toolCallId);
          ctx.activeBackgroundTasks.delete(toolCall.toolCallId);
          if (ctx.activeBackgroundTasks.size === 0) {
            clearBackgroundTaskExpiryTimer(ctx);
          }
          if (previous === "completed") {
            return;
          }
          ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "completed");
          yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
              status: toolCall.status === "failed" ? "failed" : "completed",
              ...(toolCall.detail ? { summary: toolCall.detail } : {}),
            },
          });
          return;
        }

        ctx.activeNestedTaskToolCallIds.add(toolCall.toolCallId);
        if (previous !== undefined) {
          return;
        }
        ctx.nestedTaskLifecycleByToolCallId.set(toolCall.toolCallId, "active");
        const rawInput = toolCall.data.rawInput;
        const description =
          isRecord(rawInput) && typeof rawInput.Role === "string" && rawInput.Role.trim()
            ? rawInput.Role.trim()
            : isRecord(rawInput) &&
                typeof rawInput.description === "string" &&
                rawInput.description.trim()
              ? rawInput.description.trim()
              : (toolCall.title ?? toolCall.detail);
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "task.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(toolCall.toolCallId),
            taskType: "subagent",
            ...(description ? { description } : {}),
          },
        });
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AntigravityAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (
      ctx: AntigravityAcpSessionContext,
      stopOptions?: {
        readonly exitKind?: "graceful" | "error";
        readonly reason?: string;
        readonly awaitTermination?: boolean;
      },
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!ctx.stopped) {
            ctx.stopped = true;
            clearBackgroundTaskExpiryTimer(ctx);
            if (ctx.activeBackgroundTasks.size > 0) {
              const remainingTaskIds = Array.from(ctx.activeBackgroundTasks.keys());
              yield* settleTrackedBackgroundTasks(ctx, remainingTaskIds, "stopped");
            }
            yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
            ctx.gatewaySessionLease?.release();
            sessionTeardownGate.track(ctx.threadId, ctx.teardownComplete);
            if (sessions.get(ctx.threadId) === ctx) {
              sessions.delete(ctx.threadId);
            }
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            if (ctx.sessionConfigReady !== undefined) {
              yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
              ctx.sessionConfigReady = undefined;
            }
            if (ctx.notificationFiber) {
              yield* Fiber.interrupt(ctx.notificationFiber);
            }

            const completeTeardown = sessionTeardownGate.complete(
              ctx.threadId,
              ctx.teardownComplete,
            );
            const teardown = Effect.gen(function* () {
              yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "session.exited",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: {
                  exitKind: stopOptions?.exitKind ?? "graceful",
                  ...(stopOptions?.reason ? { reason: stopOptions.reason } : {}),
                },
              });
            }).pipe(Effect.ensuring(completeTeardown));

            yield* teardown.pipe(Effect.forkDetach, Effect.asVoid);
          }

          if (stopOptions?.awaitTermination !== false) {
            yield* restore(Deferred.await(ctx.teardownComplete));
          }
        }),
      );

    const cancelAntigravityPromptWithGrace = (
      ctx: AntigravityAcpSessionContext,
      promptFiber: Fiber.Fiber<void, never> | undefined,
    ) =>
      Effect.gen(function* () {
        const result = yield* cancelTurnAndWait({
          cancel: ctx.acp.cancel,
          promptFiber,
          graceMs: ANTIGRAVITY_CANCEL_GRACE_MS,
        });
        if (result.cancelRequest !== "sent" || result.prompt === "timedOut") {
          yield* Effect.logWarning("antigravity.acp.cancel_escalated", {
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            cancelRequest: result.cancelRequest,
            prompt: result.prompt,
            ...(result.cancelFailure ? { reason: result.cancelFailure } : {}),
          });
        }
        return result;
      });

    const waitForAntigravityQueuedTurnEventsDrained = (ctx: AntigravityAcpSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: ANTIGRAVITY_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
        pollMs: ANTIGRAVITY_TURN_SETTLE_DRAIN_POLL_MS,
      });

    const completeActiveReasoningBlock = (
      ctx: AntigravityAcpSessionContext,
      status: "completed" | "failed" = "completed",
    ) =>
      Effect.gen(function* () {
        const active = ctx.activeReasoningBlock;
        if (!active) {
          return;
        }
        ctx.activeReasoningBlock = undefined;
        const detail = active.text.trim();
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId: active.turnId,
          itemId: active.itemId,
          payload: {
            itemType: "reasoning",
            status,
            title: "Thinking",
            ...(detail.length > 0 ? { detail } : {}),
          },
        });
      });

    const startSession: AntigravityAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          yield* sessionTeardownGate.awaitPending(input.threadId);
          const cwd = resolveAntigravitySessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
            input,
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );
          let ctx!: AntigravityAcpSessionContext;

          const resumeSessionId = extractAntigravityResumeSessionId(input.resumeCursor);
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isAntigravityAcpDebugEnabled(),
            provider: PROVIDER,
            marker: ANTIGRAVITY_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: ANTIGRAVITY_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: () => false,
          });
          const providerAntigravityOptions = input.providerOptions?.antigravity;
          const effectiveSettings: AntigravityAcpRuntimeSettings = {
            ...(providerAntigravityOptions?.binaryPath !== undefined
              ? { binaryPath: providerAntigravityOptions.binaryPath }
              : {}),
            ...(providerAntigravityOptions?.environment !== undefined
              ? { environment: providerAntigravityOptions.environment }
              : {}),
          };

          const acp = yield* runtimeFactory({
            ownerThreadId: input.threadId,
            antigravitySettings: effectiveSettings,
            childProcessSpawner,
            cwd,
            ...(input.additionalDirectories && input.additionalDirectories.length > 0
              ? { additionalDirectories: input.additionalDirectories }
              : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "Saint", version: "0.0.0" },
            ...(agentGatewayCredentials && gatewaySessionLease
              ? {
                  buildMcpServers: (initializeResult: Acp.InitializeResponse) =>
                    buildAcpSaintMcpServers({
                      connection: gatewaySessionLease.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                  computerControlEnabled: ctx?.enableComputerControl === true,
                  activeTurn: ctx?.activeTurnId !== undefined,
                  toolCall: params.toolCall,
                });
                if (policyOutcome !== undefined) {
                  if (policyOutcome.outcome === "selected") {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: policyOutcome.optionId,
                      },
                    };
                  }
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (!isFormElicitationRequest(params)) {
                  return { action: "decline" as const };
                }
                const questions = elicitationQuestionsFromRequest(params);
                if (questions.length === 0) {
                  return { action: "decline" as const };
                }
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });
                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);
                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                });
                return elicitationResponseFromAnswers(params, resolved);
              }),
            );
            const startedOption = yield* acp
              .start()
              .pipe(Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS));
            return yield* Option.match(startedOption, {
              onNone: () => Effect.fail(antigravityAcpTimeoutError("session/start")),
              onSome: Effect.succeed,
            });
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ProviderAdapterRequestError
                ? error
                : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail:
                "Antigravity could not resume the requested conversation. Saint refused the fresh fallback to avoid silently losing conversation context.",
            });
          }

          const sessionConfigReady = yield* Deferred.make<void>();
          const teardownComplete = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const initialRequestedModel = modelSelection?.model ?? DEFAULT_ANTIGRAVITY_ACP_MODEL;
          const session: ProviderSession = {
            provider: PROVIDER,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: initialRequestedModel,
            threadId: input.threadId,
            resumeCursor: started.sessionId,
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            enableComputerControl: input.enableComputerControl === true,
            capabilityInput: captureAgentGatewayCapabilityInput(input),
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            gatewayCredentialRetired: false,
            gatewayCredentialRenewable: false,
            threadId: input.threadId,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            ...(modelSelection?.options ? { modelOptions: modelSelection.options } : {}),
            appliedModelSelectionKeys: new Set(),
            appliedInteractionModeKey: undefined,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activePlanResponseText: "",
            activePlanArtifactMarkdown: undefined,
            lastContextWindowSize: undefined,
            activeTurnContextUsedTokens: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeReasoningBlock: undefined,
            reasoningSegmentIndex: 0,
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            lastSettledTurnId: undefined,
            lastSettledAssistantItemsWithContent: new Set(),
            activeNestedTaskToolCallIds: new Set(),
            nestedTaskLifecycleByToolCallId: new Map(),
            activeBackgroundTasks: new Map(),
            backgroundTaskExpiryTimer: undefined,
            turnHasNestedWork: false,
            totalProcessedTokens: 0,
            sessionConfigReady,
            teardownComplete,
            latestSessionCostUsd: undefined,
            sessionUpdatesProcessed: 0,
            turnStarting: false,
            pendingTurnInterrupted: false,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                }
                switch (event._tag) {
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* completeActiveReasoningBlock(ctx);
                    return;
                  case "AssistantItemCompleted": {
                    const lateTurnId =
                      ctx.activeTurnId === undefined ? ctx.lastSettledTurnId : undefined;
                    if (lateTurnId !== undefined) {
                      const lateScopedItemId = scopeAntigravityRuntimeItemIdForTurn(
                        lateTurnId,
                        event.itemId,
                      );
                      if (!ctx.lastSettledAssistantItemsWithContent.has(lateScopedItemId)) {
                        return;
                      }
                      ctx.lastSettledAssistantItemsWithContent.delete(lateScopedItemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: lateTurnId,
                          itemId: lateScopedItemId,
                          lifecycle: "item.completed",
                        }),
                      );
                      return;
                    }
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId === undefined) {
                      return;
                    }
                    yield* completeActiveReasoningBlock(ctx);
                    const scopedItemId = scopeAntigravityRuntimeItemIdForTurn(
                      activeTurnId,
                      event.itemId,
                    );
                    if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                      return;
                    }
                    ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        itemId: scopedItemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }
                  case "PlanUpdated": {
                    if (ctx.activeTurnId === undefined) {
                      return;
                    }
                    yield* completeActiveReasoningBlock(ctx);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  }
                  case "ToolCallUpdated": {
                    const lateTurnId =
                      ctx.activeTurnId === undefined
                        ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                        : undefined;
                    if (lateTurnId !== undefined) {
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitNestedTaskLifecycle(ctx, event.toolCall, lateTurnId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: lateTurnId,
                          toolCall: scopeAcpToolCallStateForTurn(
                            PROVIDER,
                            lateTurnId,
                            event.toolCall,
                          ),
                          rawPayload: event.rawPayload,
                        }),
                      );
                      return;
                    }
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId === undefined) {
                      return;
                    }
                    yield* completeActiveReasoningBlock(ctx);
                    ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitNestedTaskLifecycle(ctx, event.toolCall, activeTurnId);
                    if (ctx.activeInteractionMode === "plan") {
                      const planArtifact = extractAntigravityPlanArtifactMarkdown(event.toolCall);
                      if (planArtifact !== undefined) {
                        ctx.activePlanArtifactMarkdown = planArtifact;
                      }
                    }
                    const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                    if (failedToolDetail !== undefined) {
                      ctx.activeTurnFailedToolDetail = failedToolDetail;
                    }
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        toolCall: scopeAcpToolCallStateForTurn(
                          PROVIDER,
                          activeTurnId,
                          event.toolCall,
                        ),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ContentDelta": {
                    const lateTurnId =
                      ctx.activeTurnId === undefined ? ctx.lastSettledTurnId : undefined;
                    if (lateTurnId !== undefined) {
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const lateScopedItemId = event.itemId
                        ? scopeAntigravityRuntimeItemIdForTurn(lateTurnId, event.itemId)
                        : event.streamKind === "reasoning_text"
                          ? scopeAntigravityRuntimeItemIdForTurn(
                              lateTurnId,
                              `reasoning-${Math.max(1, ctx.reasoningSegmentIndex)}`,
                            )
                          : undefined;
                      if (
                        isRenderableAntigravityAssistantDelta(event) &&
                        lateScopedItemId !== undefined
                      ) {
                        ctx.lastSettledAssistantItemsWithContent.add(lateScopedItemId);
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: lateTurnId,
                          ...(lateScopedItemId ? { itemId: lateScopedItemId } : {}),
                          text: event.text,
                          ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                          rawPayload: event.rawPayload,
                        }),
                      );
                      return;
                    }
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId === undefined) {
                      return;
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    if (event.streamKind === "reasoning_text") {
                      const requestedItemId = event.itemId
                        ? RuntimeItemId.makeUnsafe(
                            scopeAntigravityRuntimeItemIdForTurn(activeTurnId, event.itemId),
                          )
                        : undefined;
                      if (
                        ctx.activeReasoningBlock &&
                        (ctx.activeReasoningBlock.turnId !== activeTurnId ||
                          (requestedItemId !== undefined &&
                            ctx.activeReasoningBlock.itemId !== requestedItemId))
                      ) {
                        yield* completeActiveReasoningBlock(ctx);
                      }
                      if (!ctx.activeReasoningBlock) {
                        ctx.reasoningSegmentIndex += 1;
                        const reasoningItemId =
                          requestedItemId ??
                          RuntimeItemId.makeUnsafe(
                            scopeAntigravityRuntimeItemIdForTurn(
                              activeTurnId,
                              `reasoning-${ctx.reasoningSegmentIndex}`,
                            ),
                          );
                        ctx.activeReasoningBlock = {
                          turnId: activeTurnId,
                          itemId: reasoningItemId,
                          text: "",
                        };
                        yield* offerRuntimeEvent(input.lifecycleGeneration, {
                          type: "item.started",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: reasoningItemId,
                          payload: {
                            itemType: "reasoning",
                            status: "inProgress",
                            title: "Thinking",
                          },
                        });
                      }
                      ctx.activeReasoningBlock.text += event.text;
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: ctx.activeReasoningBlock.itemId,
                          text: event.text,
                          streamKind: "reasoning_text",
                          rawPayload: event.rawPayload,
                        }),
                      );
                      return;
                    }
                    yield* completeActiveReasoningBlock(ctx);
                    const scopedItemId = event.itemId
                      ? scopeAntigravityRuntimeItemIdForTurn(activeTurnId, event.itemId)
                      : undefined;
                    if (ctx.activeInteractionMode === "plan") {
                      ctx.activePlanResponseText += event.text;
                    }
                    if (isRenderableAntigravityAssistantDelta(event)) {
                      ctx.activeTurnHadAssistantContent = true;
                      if (scopedItemId !== undefined) {
                        ctx.activeAssistantItemsWithContent.add(scopedItemId);
                      }
                    }
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        ...(scopedItemId ? { itemId: scopedItemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "UsageUpdated": {
                    if (event.usage.maxTokens !== undefined) {
                      ctx.lastContextWindowSize = event.usage.maxTokens;
                    }
                    const activeTurnId = ctx.activeTurnId;
                    if (activeTurnId !== undefined && event.usage.usedTokens > 0) {
                      ctx.activeTurnContextUsedTokens = event.usage.usedTokens;
                    }
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    recordAcpSessionCost(ctx, event.cost);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: activeTurnId,
                        usage: event.usage,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
          ).pipe(Effect.forkIn(ctx.scope));

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* Effect.gen(function* () {
            if (started.sessionSetupMethod === "load") {
              yield* acp.awaitLoadReplayReady.pipe(
                Effect.timeoutOption(ANTIGRAVITY_STARTUP_REPLAY_MAX_WAIT_MS),
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/load", cause),
                ),
              );
            }
            const appliedModel = yield* runAntigravityAcpConfigurationAfterReplay({
              runtime: acp,
              threadId: input.threadId,
              effect: applyAntigravityAcpModelSelection({
                runtime: acp,
                model: initialRequestedModel,
                modelOptions: modelSelection?.options,
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              }),
            });
            ctx.session = {
              ...ctx.session,
              model: appliedModel.model,
            };
            ctx.appliedModelSelectionKeys = new Set([
              antigravityModelSelectionKey(initialRequestedModel, modelSelection?.options),
              antigravityModelSelectionKey(appliedModel.model, modelSelection?.options),
            ]);
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (ctx.stopped) {
              return yield* new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                threadId: input.threadId,
              });
            }

            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: {
                message: "Antigravity ACP session started",
                ...(resumeSessionId ? { resume: resumeSessionId } : {}),
              },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "Antigravity ACP session ready" },
            });
            yield* offerRuntimeEvent(input.lifecycleGeneration, {
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignore(stopSessionInternal(ctx)),
            ),
          );

          return ctx.session;
        }).pipe(Effect.scoped),
      );

    const failAntigravityTurnAsTimedOut = (
      ctx: AntigravityAcpSessionContext,
      turnId: TurnId,
      idleMs: number,
    ) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        yield* completeActiveReasoningBlock(ctx, "failed");
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Antigravity stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("antigravity.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        yield* cancelAntigravityPromptWithGrace(ctx, promptFiber);
        yield* stopSessionInternal(ctx, {
          exitKind: "error",
          reason: detail,
          awaitTermination: false,
        });
      });

    const sendTurn: AntigravityAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.turnStarting || ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "An Antigravity turn is already active for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startAntigravityTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startAntigravityTurn = (
      ctx: AntigravityAcpSessionContext,
      input: Parameters<AntigravityAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const requestedModel =
          turnModelSelection?.model ?? ctx.session.model ?? DEFAULT_ANTIGRAVITY_ACP_MODEL;
        const modelOptions = turnModelSelection?.options ?? ctx.modelOptions;
        if (turnModelSelection?.options) {
          ctx.modelOptions = turnModelSelection.options;
        }
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);

        const requestedModelKey = antigravityModelSelectionKey(requestedModel, modelOptions);
        const requestedInteractionModeKey = antigravityInteractionModeKey(
          ctx.session.runtimeMode,
          interactionMode,
        );
        const needsModelUpdate = !ctx.appliedModelSelectionKeys.has(requestedModelKey);
        const needsInteractionModeUpdate =
          ctx.appliedInteractionModeKey !== requestedInteractionModeKey;

        let model = ctx.session.model ?? requestedModel;
        if (needsModelUpdate || needsInteractionModeUpdate) {
          const appliedModel = yield* runAntigravityAcpConfigurationAfterReplay({
            runtime: ctx.acp,
            threadId: input.threadId,
            effect: Effect.gen(function* () {
              const applied = needsModelUpdate
                ? yield* applyAntigravityAcpModelSelection({
                    runtime: ctx.acp,
                    model: requestedModel,
                    modelOptions,
                    mapError: ({ cause, method }) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
                  })
                : { model };
              if (needsInteractionModeUpdate) {
                yield* applyAntigravityAcpInteractionMode({
                  runtime: ctx.acp,
                  runtimeMode: ctx.session.runtimeMode,
                  interactionMode,
                  mapError: ({ cause, method }) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
                });
              }
              return applied;
            }),
          }).pipe(
            Effect.onError((cause) =>
              stopSessionInternal(ctx, {
                exitKind: "error",
                reason: Cause.pretty(cause),
              }),
            ),
          );
          model = appliedModel.model;
          if (needsModelUpdate) {
            ctx.appliedModelSelectionKeys = new Set([
              requestedModelKey,
              antigravityModelSelectionKey(model, modelOptions),
            ]);
          }
          if (needsInteractionModeUpdate) {
            ctx.appliedInteractionModeKey = requestedInteractionModeKey;
          }
        }
        refreshBackgroundTaskExpiryTimer(ctx);

        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: appendProviderReferencesPromptBlock({
            text: input.input?.trim()
              ? withAcpPlanModePrompt({
                  text: input.input.trim(),
                  interactionMode,
                  promptPrefix: ANTIGRAVITY_PLAN_MODE_PROMPT_PREFIX,
                })
              : undefined,
            mentions: input.mentions,
          }),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "turn/start",
            issue: "A prompt or file attachment is required.",
          });
        }
        const harnessPolicy = takeAntigravitySaintHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        ctx.activeTurnId = turnId;
        ctx.activeTurnContextUsedTokens = undefined;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeReasoningBlock = undefined;
        ctx.reasoningSegmentIndex = 0;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.turnToolCallIds.clear();
        ctx.lastSettledTurnId = undefined;
        ctx.lastSettledAssistantItemsWithContent.clear();
        ctx.activeNestedTaskToolCallIds.clear();
        ctx.nestedTaskLifecycleByToolCallId.clear();
        ctx.turnHasNestedWork = false;
        ctx.activeInteractionMode = interactionMode;
        ctx.activePlanResponseText = "";
        ctx.activePlanArtifactMarkdown = undefined;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          model,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });

        const runPrompt = Effect.suspend(() =>
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({ prompt: promptParts }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                yield* waitForAntigravityQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                const settledAssistantItems = [...ctx.activeAssistantItemsWithContent];
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                yield* completeActiveReasoningBlock(ctx, "failed");
                ctx.lastSettledTurnId = turnId;
                ctx.lastSettledAssistantItemsWithContent.clear();
                for (const itemId of settledAssistantItems) {
                  ctx.lastSettledAssistantItemsWithContent.add(itemId);
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  model,
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
                yield* stopSessionInternal(ctx, {
                  exitKind: "error",
                  reason: detail,
                  awaitTermination: false,
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                yield* waitForAntigravityQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                const settledAssistantItems = [...ctx.activeAssistantItemsWithContent];
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                const terminalPlanMarkdown =
                  ctx.activeInteractionMode === "plan" && ctx.lastPlanFingerprint === undefined
                    ? (ctx.activePlanArtifactMarkdown ??
                      extractTerminalPlanMarkdown({
                        interactionMode: ctx.activeInteractionMode,
                        capturedPlanFingerprint: ctx.lastPlanFingerprint,
                        assistantText: ctx.activePlanResponseText,
                      }))
                    : undefined;
                if (terminalPlanMarkdown !== undefined) {
                  ctx.lastPlanFingerprint = terminalPlanMarkdown;
                  yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { planMarkdown: terminalPlanMarkdown },
                    raw: {
                      source: "acp.jsonrpc",
                      method:
                        ctx.activePlanArtifactMarkdown !== undefined
                          ? "saint.antigravity.plan-artifact"
                          : "saint.antigravity.terminal-plan-response",
                      payload: result,
                    },
                  });
                }
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
                yield* completeActiveReasoningBlock(ctx, "completed");
                ctx.lastSettledTurnId = turnId;
                ctx.lastSettledAssistantItemsWithContent.clear();
                for (const itemId of settledAssistantItems) {
                  ctx.lastSettledAssistantItemsWithContent.add(itemId);
                }
                const activeTurnContextUsedTokens = ctx.activeTurnContextUsedTokens;
                ctx.activeTurnContextUsedTokens = undefined;
                const usageSnapshot = buildAntigravityPromptUsageSnapshot({
                  usage: result.usage,
                  model,
                  previousTotalProcessedTokens: ctx.totalProcessedTokens,
                  maxTokens: ctx.lastContextWindowSize,
                  ...(activeTurnContextUsedTokens !== undefined
                    ? { currentContextUsedTokens: activeTurnContextUsedTokens }
                    : {}),
                });
                if (usageSnapshot) {
                  ctx.totalProcessedTokens = usageSnapshot.nextTotalProcessedTokens;
                  yield* offerRuntimeEvent(
                    ctx.lifecycleGeneration,
                    makeAcpTokenUsageEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      usage: usageSnapshot.snapshot,
                      rawPayload: result,
                    }),
                  );
                }
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model,
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning("antigravity.acp.turn_completed_without_content", {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              yield* completeActiveReasoningBlock(ctx, "failed");
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                model,
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );
        ctx.activePromptFiber = yield* runPrompt;

        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS,
          currentIdleTimeoutMs: () =>
            ctx.activeNestedTaskToolCallIds.size > 0 || ctx.turnHasNestedWork
              ? ANTIGRAVITY_NESTED_TASK_IDLE_TIMEOUT_MS
              : ANTIGRAVITY_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: ANTIGRAVITY_TURN_WATCHDOG_INTERVAL_MS,
          onIdleTimeout: (idleMs) => failAntigravityTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          ...(ctx.session.resumeCursor !== undefined
            ? { resumeCursor: ctx.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: AntigravityAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (shouldIgnoreAntigravityInterrupt(turnId, ctx.activeTurnId)) {
          yield* Effect.logWarning("antigravity.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        if (!ctx.turnStarting && ctx.activeTurnId === undefined) {
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        const hadGatewayLease = ctx.gatewaySessionLease !== undefined;
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
            if (hadGatewayLease) {
              ctx.gatewayCredentialRetired = true;
              ctx.gatewayCredentialRenewable = true;
            }
            yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
            const activePromptFiber = ctx.activePromptFiber;
            const cancelResult = yield* cancelAntigravityPromptWithGrace(ctx, activePromptFiber);
            // `agy acp` settles `session/prompt` with `stopReason: "cancelled"` in ~2ms
            // while keeping the session alive for the next turn. Only tear down the
            // process if cancellation failed or timed out.
            if (
              cancelResult.prompt === "timedOut" ||
              (cancelResult.prompt === "notStarted" && cancelResult.cancelRequest === "failed")
            ) {
              yield* stopSessionInternal(ctx, {
                exitKind: "graceful",
                reason: "Antigravity turn cancellation timed out; runtime closed.",
              });
            }
          }),
        );
      });

    const respondToRequest: AntigravityAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: AntigravityAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: AntigravityAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
          turns: snapshotProviderTurns(ctx.turns),
        };
      });

    const readExternalThread: NonNullable<AntigravityAdapterShape["readExternalThread"]> = (
      input,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fallbackCwd =
            resolveAntigravitySessionCwd(input.cwd, serverConfig) ?? process.cwd();
          const providerAntigravityOptions = input.providerOptions?.antigravity;
          const runtime = yield* runtimeFactory({
            antigravitySettings: {
              ...(providerAntigravityOptions?.binaryPath !== undefined
                ? { binaryPath: providerAntigravityOptions.binaryPath }
                : {}),
              ...(providerAntigravityOptions?.environment !== undefined
                ? { environment: providerAntigravityOptions.environment }
                : {}),
            },
            childProcessSpawner,
            cwd: fallbackCwd,
            resumeSessionId: input.externalThreadId,
            sessionSetupMode: "load-only",
            clientInfo: { name: "Saint Thread Import", version: "0.0.0" },
          });

          const replayedTurns: Array<{
            id: TurnId;
            items: Array<{ type: "antigravityMessage"; role: "user" | "assistant"; text: string }>;
          }> = [];
          let currentUserText = "";
          let currentUserMessageId: string | undefined;
          let currentAssistantText = "";
          let currentAssistantMessageId: string | undefined;
          let sawAssistantActivity = false;
          const flushTurn = () => {
            const items: Array<{
              type: "antigravityMessage";
              role: "user" | "assistant";
              text: string;
            }> = [];
            if (currentUserText.trim().length > 0) {
              items.push({ type: "antigravityMessage", role: "user", text: currentUserText });
            }
            if (currentAssistantText.trim().length > 0) {
              items.push({
                type: "antigravityMessage",
                role: "assistant",
                text: currentAssistantText,
              });
            }
            if (items.length > 0) {
              replayedTurns.push({
                id: TurnId.makeUnsafe(
                  `antigravity:${input.externalThreadId}:${replayedTurns.length}`,
                ),
                items,
              });
            }
            currentUserText = "";
            currentUserMessageId = undefined;
            currentAssistantText = "";
            currentAssistantMessageId = undefined;
            sawAssistantActivity = false;
          };

          yield* runtime.handleSessionUpdate((notification) =>
            Effect.sync(() => {
              if (notification.sessionId !== input.externalThreadId) {
                return;
              }
              const update = notification.update;
              if (update.sessionUpdate === "user_message_chunk") {
                const messageId =
                  typeof update.messageId === "string" && update.messageId.trim().length > 0
                    ? update.messageId.trim()
                    : undefined;
                if (
                  sawAssistantActivity ||
                  (currentUserText.length > 0 &&
                    (messageId !== undefined || currentUserMessageId !== undefined) &&
                    messageId !== currentUserMessageId)
                ) {
                  flushTurn();
                }
                currentUserMessageId = messageId;
                if (update.content.type === "text") {
                  currentUserText += update.content.text;
                }
                return;
              }
              if (update.sessionUpdate === "agent_message_chunk") {
                sawAssistantActivity = true;
                const messageId =
                  typeof update.messageId === "string" && update.messageId.trim().length > 0
                    ? update.messageId.trim()
                    : undefined;
                if (
                  currentAssistantText.length > 0 &&
                  (messageId !== undefined || currentAssistantMessageId !== undefined) &&
                  messageId !== currentAssistantMessageId
                ) {
                  flushTurn();
                }
                currentAssistantMessageId = messageId;
                if (update.content.type === "text") {
                  currentAssistantText += update.content.text;
                }
                return;
              }
              if (
                update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update" ||
                update.sessionUpdate === "plan"
              ) {
                sawAssistantActivity = true;
              }
            }),
          );

          const started = yield* runtime
            .start()
            .pipe(Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS));
          const startedResult = yield* Option.match(started, {
            onNone: () => Effect.fail(antigravityAcpTimeoutError("session/load")),
            onSome: Effect.succeed,
          });

          return yield* Effect.gen(function* () {
            yield* runtime.awaitLoadReplayReady.pipe(
              Effect.timeoutOption(ANTIGRAVITY_STARTUP_REPLAY_MAX_WAIT_MS),
            );
            flushTurn();

            let resolvedCwd = input.cwd?.trim() || undefined;
            if (
              !resolvedCwd &&
              startedResult.initializeResult.agentCapabilities?.sessionCapabilities?.list != null
            ) {
              const listResult = yield* runtime.request("session/list", {}).pipe(
                Effect.timeoutOption(5_000),
                Effect.map(Option.getOrUndefined),
                Effect.catch(() => Effect.succeed(undefined)),
              );
              if (isRecord(listResult) && Array.isArray(listResult.sessions)) {
                const match = listResult.sessions.find(
                  (entry) =>
                    isRecord(entry) &&
                    entry.sessionId === input.externalThreadId &&
                    typeof entry.cwd === "string" &&
                    entry.cwd.trim().length > 0,
                );
                if (isRecord(match) && typeof match.cwd === "string") {
                  resolvedCwd = match.cwd.trim();
                }
              }
            }

            return {
              threadId: ThreadId.makeUnsafe(input.externalThreadId),
              ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
              turns: replayedTurns,
            } satisfies ProviderThreadSnapshot;
          }).pipe(
            Effect.ensuring(
              startedResult.initializeResult.agentCapabilities?.sessionCapabilities?.close != null
                ? runtime.closeSession().pipe(Effect.ignore)
                : Effect.void,
            ),
          );
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/read",
                detail:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to load Antigravity session '${input.externalThreadId}'.`,
                cause,
              }),
        ),
      );

    const rollbackThread: AntigravityAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            "Antigravity does not expose a native rewind cursor; rollback must restart the session with retained transcript context.",
        });
      });

    const forkThread: NonNullable<AntigravityAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        const sourceCwd = resolveAntigravitySessionCwd(input.sourceCwd ?? input.cwd, serverConfig);
        const targetCwd = resolveAntigravitySessionCwd(input.cwd ?? input.sourceCwd, serverConfig);
        if (!sourceCwd || !targetCwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "A source and target cwd are required to fork an Antigravity session.",
          });
        }

        const forkRuntime = (runtime: AcpSessionRuntimeShape) =>
          forkViaAcpRuntime({
            provider: PROVIDER,
            runtime,
            targetCwd,
            unsupportedIssue:
              "This Antigravity ACP version does not advertise session/fork; Saint will rebuild the fork from its retained transcript.",
            requestTimeoutMs: ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS,
            timeoutError: antigravityAcpTimeoutError,
          });

        const activeSource = sessions.get(input.sourceThreadId);
        if (activeSource?.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue:
              "The source Antigravity session has a turn in flight; Saint will rebuild the fork from its retained transcript.",
          });
        }

        const forked = activeSource
          ? yield* forkRuntime(activeSource.acp)
          : yield* Effect.gen(function* () {
              const sourceSessionId = extractAntigravityResumeSessionId(input.sourceResumeCursor);
              if (!sourceSessionId) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "forkThread",
                  issue: "The source Antigravity session has no resumable native cursor.",
                });
              }
              const runtime = yield* runtimeFactory({
                antigravitySettings: {
                  ...(input.providerOptions?.antigravity?.binaryPath
                    ? { binaryPath: input.providerOptions.antigravity.binaryPath }
                    : {}),
                  ...(input.providerOptions?.antigravity?.environment
                    ? { environment: input.providerOptions.antigravity.environment }
                    : {}),
                },
                childProcessSpawner,
                cwd: sourceCwd,
                resumeSessionId: sourceSessionId,
                clientInfo: { name: "Saint Fork", version: "0.0.0" },
              });
              yield* runtime.start().pipe(
                Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(antigravityAcpTimeoutError("session/resume")),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              return yield* forkRuntime(runtime);
            }).pipe(Effect.scoped);

        return {
          threadId: input.threadId,
          resumeCursor: forked.sessionId,
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ProviderAdapterRequestError ||
          cause instanceof ProviderAdapterProcessError ||
          cause instanceof ProviderAdapterSessionClosedError ||
          cause instanceof ProviderAdapterSessionNotFoundError ||
          cause instanceof ProviderAdapterValidationError
            ? cause
            : mapAcpToAdapterError(PROVIDER, input.sourceThreadId, "session/fork", cause),
        ),
      );

    const stopSession: AntigravityAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx !== undefined && !ctx.stopped) {
            yield* stopSessionInternal(ctx);
            return;
          }
          if (sessionTeardownGate.isPending(threadId)) {
            yield* sessionTeardownGate.awaitPending(threadId);
            return;
          }
        }),
      );

    const listSessions: AntigravityAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: AntigravityAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const getComposerCapabilities: NonNullable<
      AntigravityAdapterShape["getComposerCapabilities"]
    > = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: true,
      } satisfies ProviderComposerCapabilities);

    const mapAcpCommands = (commands: ReadonlyArray<Acp.AvailableCommand>) =>
      commands.map((command) => ({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
      }));

    const listCommands: NonNullable<AntigravityAdapterShape["listCommands"]> = (input) =>
      Effect.gen(function* () {
        const ctx = input.threadId ? sessions.get(ThreadId.makeUnsafe(input.threadId)) : undefined;
        if (!ctx || ctx.stopped) {
          const { cacheKey } = resolveAntigravityDiscoveryCacheKey(input);
          const readCached = () => {
            const cached = modelDiscoveryCache.get(cacheKey);
            return cached && cached.expiresAt > Date.now() ? cached.commands : undefined;
          };
          // The cache is in-memory and expires, so after a server restart (models
          // come from the persisted catalog) or 5 minutes, rerun discovery to refill it.
          let commands = readCached();
          const fromCache = commands !== undefined;
          if (commands === undefined) {
            yield* listModels({
              provider: PROVIDER,
              cwd: input.cwd,
              ...(input.instanceId ? { instanceId: input.instanceId } : {}),
              ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
              ...(input.environment ? { environment: input.environment } : {}),
            }).pipe(Effect.ignore);
            commands = readCached() ?? [];
          }
          return {
            commands: mapAcpCommands(commands),
            source: "antigravity.acp",
            cached: fromCache,
          } satisfies ProviderListCommandsResult;
        }
        const commands = yield* ctx.acp.getAvailableCommands.pipe(
          Effect.mapError((cause) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "listCommands", cause),
          ),
        );
        return {
          commands: mapAcpCommands(commands),
          source: "antigravity.acp",
          cached: false,
        } satisfies ProviderListCommandsResult;
      });

    const listModels: NonNullable<AntigravityAdapterShape["listModels"]> = (input) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const { configuredBinaryPath, cacheKey } = resolveAntigravityDiscoveryCacheKey(input);
          const cached = modelDiscoveryCache.get(cacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            return {
              models: [...cached.models],
              source: "antigravity.acp",
              cached: true,
            } satisfies ProviderListModelsResult;
          }

          const cwd = resolveAntigravitySessionCwd(input.cwd, serverConfig) ?? process.cwd();
          const discovered = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* runtimeFactory({
                antigravitySettings: {
                  ...(configuredBinaryPath !== undefined
                    ? { binaryPath: configuredBinaryPath }
                    : {}),
                  ...(input.environment ? { environment: input.environment } : {}),
                },
                childProcessSpawner,
                cwd,
                clientInfo: { name: "Saint Model Discovery", version: "0.0.0" },
              });
              const started = yield* runtime.start();
              return yield* Effect.gen(function* () {
                const configOptions = yield* runtime.getConfigOptions;
                const setupResultRecord: Record<string, unknown> | undefined = isRecord(
                  started.sessionSetupResult,
                )
                  ? started.sessionSetupResult
                  : undefined;
                const setupModels =
                  setupResultRecord && isRecord(setupResultRecord.models)
                    ? setupResultRecord.models.availableModels
                    : undefined;
                const availableModels = Array.isArray(setupModels)
                  ? setupModels.filter(
                      (entry): entry is AntigravityAcpModelInfo =>
                        isRecord(entry) && typeof entry.name === "string",
                    )
                  : undefined;
                const commands = yield* readDiscoveryAvailableCommands(runtime);
                return {
                  models: parseAntigravityAcpConfigModels(configOptions, availableModels),
                  commands,
                };
              }).pipe(
                Effect.ensuring(
                  started.initializeResult.agentCapabilities?.sessionCapabilities?.close != null
                    ? runtime.closeSession().pipe(Effect.ignore)
                    : Effect.void,
                ),
              );
            }),
          ).pipe(
            Effect.timeoutOption(ANTIGRAVITY_MODEL_DISCOVERY_TIMEOUT_MS),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(antigravityAcpTimeoutError("model/list")),
                onSome: Effect.succeed,
              }),
            ),
            Effect.mapError((cause) =>
              cause instanceof ProviderAdapterRequestError
                ? cause
                : mapAcpToAdapterError(
                    PROVIDER,
                    ThreadId.makeUnsafe("model-discovery"),
                    "model/list",
                    cause,
                  ),
            ),
          );

          if (modelDiscoveryCache.size >= ANTIGRAVITY_DISCOVERY_CACHE_MAX_ENTRIES) {
            const oldestKey = modelDiscoveryCache.keys().next().value;
            if (oldestKey !== undefined) {
              modelDiscoveryCache.delete(oldestKey);
            }
          }
          modelDiscoveryCache.set(cacheKey, {
            models: discovered.models,
            commands: discovered.commands,
            expiresAt: Date.now() + ANTIGRAVITY_MODEL_DISCOVERY_CACHE_MS,
          });

          return {
            models: [...discovered.models],
            source: "antigravity.acp",
            cached: false,
          } satisfies ProviderListModelsResult;
        }),
      );

    const agentGatewayCredentialRetired: NonNullable<
      AntigravityAdapterShape["agentGatewayCredentialRetired"]
    > = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped && ctx.gatewayCredentialRetired === true;
      });

    /**
     * Rotate the retired Agent Gateway bearer on the already-running `agy acp`
     * process via ACP `session/resume` / `session/load` so stopping a turn does
     * not kill the process or its background subagents/commands.
     */
    const renewAgentGatewayCredential: NonNullable<
      AntigravityAdapterShape["renewAgentGatewayCredential"]
    > = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (
            !ctx ||
            ctx.stopped ||
            ctx.activeTurnId !== undefined ||
            ctx.turnStarting ||
            ctx.pendingApprovals.size > 0 ||
            ctx.pendingUserInputs.size > 0
          ) {
            return false;
          }
          // When no Agent Gateway credential was issued for this runtime, no bearer
          // rotation is needed to keep the live process warm.
          if (ctx.gatewaySessionLease === undefined && agentGatewayCredentials === undefined) {
            return true;
          }
          if (
            !ctx.gatewayCredentialRetired ||
            !ctx.gatewayCredentialRenewable ||
            agentGatewayCredentials === undefined ||
            ctx.acp.reloadSession === undefined
          ) {
            return false;
          }
          ctx.gatewayCredentialRenewable = false;
          ctx.gatewaySessionLease?.release();
          const replacement = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            threadId,
            PROVIDER,
            ctx.capabilityInput,
          );
          if (!replacement) {
            return false;
          }
          const reloaded = yield* ctx.acp
            .reloadSession((initializeResult) =>
              buildAcpSaintMcpServers({
                connection: replacement.connection,
                initializeResult,
                stdioProxy: agentGatewayCredentials.stdioProxy,
              }),
            )
            .pipe(
              Effect.timeoutOption(ANTIGRAVITY_ACP_REQUEST_TIMEOUT_MS),
              Effect.map(Option.getOrElse(() => false)),
              Effect.catch(() => Effect.succeed(false)),
            );
          if (!reloaded || ctx.stopped) {
            replacement.release();
            return false;
          }
          ctx.gatewaySessionLease = replacement;
          ctx.gatewayCredentialRetired = false;
          ctx.appliedModelSelectionKeys = new Set();
          ctx.appliedInteractionModeKey = undefined;
          yield* startAgentGatewaySessionLeaseExitWatcher(replacement, ctx.acp.awaitExit);
          return true;
        }),
      );

    const stopAll: AntigravityAdapterShape["stopAll"] = () =>
      settleConcurrentTeardowns(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx));

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ignore, Effect.andThen(PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renewAgentGatewayCredential,
      agentGatewayCredentialRetired,
      listSessions,
      hasSession,
      readThread,
      readExternalThread,
      rollbackThread,
      forkThread,
      stopAll,
      getComposerCapabilities,
      listCommands,
      listModels,
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies AntigravityAdapterShape;
  });

export const AntigravityAcpAdapterLive = Layer.effect(
  AntigravityAdapter,
  makeAntigravityAcpAdapter(),
);

export function makeAntigravityAcpAdapterLive(options?: AntigravityAcpAdapterLiveOptions) {
  return Layer.effect(AntigravityAdapter, makeAntigravityAcpAdapter(options));
}
