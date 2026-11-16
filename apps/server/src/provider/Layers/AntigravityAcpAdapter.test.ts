import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { type ProviderRuntimeEvent, ThreadId, TurnId } from "@saint/contracts";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { SAINT_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { buildAntigravityAcpSpawnInput } from "../acp/AntigravityAcpSupport.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";
import {
  extractAntigravityPlanArtifactMarkdown,
  extractAntigravityResumeSessionId,
  isAntigravityBackgroundCommandToolCall,
  isAntigravityNestedTaskToolCall,
  isRenderableAntigravityAssistantDelta,
  makeAntigravityAcpAdapterLive,
  scopeAntigravityRuntimeItemIdForTurn,
  shouldIgnoreAntigravityInterrupt,
  takeAntigravitySaintHarnessPolicyTextPart,
} from "./AntigravityAcpAdapter.ts";

const TEST_SERVER_CONFIG = {
  cwd: "/tmp/workspace",
  homeDir: "/tmp/home",
  attachmentsDir: "/tmp/attachments",
  logProviderEvents: false,
} as unknown as ServerConfig["Service"];

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
      { value: "auto", name: "Auto" },
      { value: "plan", name: "Plan" },
    ],
  },
];

describe("AntigravityAcpAdapter helpers", () => {
  it("delivers private scoped harness policy once per session", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeAntigravitySaintHarnessPolicyTextPart(state, true)?.text).toContain(
      SAINT_HARNESS_POLICY_MARKER,
    );
    expect(takeAntigravitySaintHarnessPolicyTextPart(state, true)).toBeNull();
  });

  it("extracts resume session id from print-mode strings and object cursors", () => {
    expect(extractAntigravityResumeSessionId("conv-print-123")).toBe("conv-print-123");
    expect(extractAntigravityResumeSessionId({ conversationId: "conv-obj-456" })).toBe(
      "conv-obj-456",
    );
    expect(extractAntigravityResumeSessionId({ sessionId: "sess-789" })).toBe("sess-789");
    expect(extractAntigravityResumeSessionId("")).toBeUndefined();
    expect(extractAntigravityResumeSessionId(null)).toBeUndefined();
  });

  it("identifies subagent and background command tool calls for extended idle budgets", () => {
    expect(
      isAntigravityNestedTaskToolCall({
        toolCallId: "sub-1",
        kind: "agent",
        data: { toolCallId: "sub-1", tool: "task" },
      }),
    ).toBe(true);
    expect(
      isAntigravityBackgroundCommandToolCall({
        toolCallId: "cmd-1",
        kind: "execute",
        data: {
          toolCallId: "cmd-1",
          rawInput: { CommandLine: "sleep 5", WaitMsBeforeAsync: 500 },
        },
      }),
    ).toBe(true);
    expect(
      isRenderableAntigravityAssistantDelta({
        streamKind: "assistant_text",
        text: "hello",
      }),
    ).toBe(true);
    expect(
      isRenderableAntigravityAssistantDelta({
        streamKind: "reasoning_text",
        text: "thinking",
      }),
    ).toBe(false);
    expect(scopeAntigravityRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-1"), "item-1")).toBe(
      "antigravity:turn-1:item-1",
    );
    expect(
      shouldIgnoreAntigravityInterrupt(
        TurnId.makeUnsafe("turn-stale"),
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toBe(true);
  });
});

describe("AntigravityAcpAdapter session lifecycle", () => {
  it("keeps one long-lived ACP session across turns, switches models in-session, and survives cancel", async () => {
    let runtimeCreations = 0;
    const configOptionCalls: Array<{ configId: string; value: string | boolean }> = [];
    const modeCalls: string[] = [];
    let currentConfigOptions = [...SAMPLE_CONFIG_OPTIONS];
    let currentModeId = "default";
    let cancelSignal: Deferred.Deferred<void> | undefined;

    const eventQueue = await Effect.runPromise(Queue.unbounded<AcpParsedSessionEvent>());
    let enqueuedCount = 0;
    const emitAcpEvent = (event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        enqueuedCount += 1;
        yield* Queue.offer(eventQueue, event);
      });

    const mockRuntime: AcpSessionRuntimeShape = {
      handleRequestPermission: () => Effect.void,
      handleElicitation: () => Effect.void,
      handleReadTextFile: () => Effect.void,
      handleWriteTextFile: () => Effect.void,
      handleCreateTerminal: () => Effect.void,
      handleTerminalOutput: () => Effect.void,
      handleTerminalWaitForExit: () => Effect.void,
      handleTerminalKill: () => Effect.void,
      handleTerminalRelease: () => Effect.void,
      handleSessionUpdate: () => Effect.void,
      handleElicitationComplete: () => Effect.void,
      handleExtRequest: () => Effect.void,
      handleExtNotification: () => Effect.void,
      start: () =>
        Effect.succeed({
          sessionId: "conv-legacy-123",
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            sessionId: "conv-legacy-123",
            configOptions: [...currentConfigOptions],
          },
          modelConfigId: "model",
          sessionSetupMethod: "resume" as const,
        }),
      prompt: ({ prompt }) =>
        Effect.gen(function* () {
          const textBlocks = prompt
            .filter(
              (block): block is Extract<Acp.ContentBlock, { type: "text" }> =>
                block.type === "text",
            )
            .map((block) => block.text)
            .join("\n");
          if (textBlocks.includes("WAIT_FOR_CANCEL")) {
            cancelSignal = yield* Deferred.make<void>();
            yield* Deferred.await(cancelSignal);
            return { stopReason: "cancelled" as const };
          }
          yield* emitAcpEvent({
            _tag: "ContentDelta",
            itemId: "thought-1",
            text: "Thinking...",
            streamKind: "reasoning_text",
            rawPayload: {},
          });
          yield* emitAcpEvent({
            _tag: "ToolCallUpdated",
            toolCall: {
              toolCallId: "subagent-1",
              kind: "agent",
              title: "Research Helper",
              status: "inProgress",
              data: {
                toolCallId: "subagent-1",
                kind: "agent",
                tool: "task",
                prompt: "Check files",
                rawInput: { Role: "Research Helper", Prompt: "Check files" },
              },
            },
            rawPayload: {},
          });
          yield* emitAcpEvent({
            _tag: "ToolCallUpdated",
            toolCall: {
              toolCallId: "subagent-1",
              kind: "agent",
              title: "Research Helper",
              status: "completed",
              data: {
                toolCallId: "subagent-1",
                kind: "agent",
                tool: "task",
                prompt: "Check files",
              },
            },
            rawPayload: {},
          });
          yield* emitAcpEvent({
            _tag: "ContentDelta",
            itemId: "msg-1",
            text: "Hello from ACP",
            streamKind: "assistant_text",
            rawPayload: {},
          });
          yield* emitAcpEvent({
            _tag: "AssistantItemCompleted",
            itemId: "msg-1",
          });
          return {
            stopReason: "end_turn" as const,
            usage: {
              inputTokens: 500,
              cachedReadTokens: 100,
              cachedWriteTokens: 0,
              outputTokens: 80,
              thoughtTokens: 20,
              totalTokens: 700,
            },
          };
        }),
      cancel: Effect.gen(function* () {
        if (cancelSignal) {
          yield* Deferred.succeed(cancelSignal, undefined);
        }
      }),
      setMode: (modeId) =>
        Effect.sync(() => {
          currentModeId = modeId;
          modeCalls.push(modeId);
          return {};
        }),
      setModel: () => Effect.void,
      setConfigOption: (configId, value) =>
        Effect.sync(() => {
          configOptionCalls.push({ configId, value });
          currentConfigOptions = currentConfigOptions.map((opt) =>
            opt.id === configId && opt.type === "select" && typeof value === "string"
              ? { ...opt, currentValue: value }
              : opt,
          );
          if (configId === "model" && value === "claude-sonnet-4-6") {
            currentConfigOptions = currentConfigOptions.filter((opt) => opt.id !== "thought_level");
          }
          return { configOptions: [...currentConfigOptions] };
        }),
      getEvents: () => Stream.fromQueue(eventQueue),
      getAvailableCommands: Effect.succeed([
        { name: "help", description: "Show help", input: { hint: "[topic]" } },
      ]),
      getConfigOptions: Effect.sync(() => [...currentConfigOptions]),
      getModeState: Effect.sync(() => ({
        currentModeId,
        availableModes: [
          { id: "default", name: "Default" },
          { id: "auto", name: "Auto" },
          { id: "plan", name: "Plan" },
        ],
      })),
      sessionUpdatesEnqueuedCount: Effect.sync(() => enqueuedCount),
      awaitLoadReplayReady: Effect.void,
      awaitExit: Effect.never,
      supportsSessionFork: Effect.succeed(false),
      supportsSessionRecovery: Effect.succeed(true),
      getSessionEpoch: () =>
        Effect.succeed({ generation: 1, activeSessionId: Option.some("conv-legacy-123") }),
      getPendingSessionNotificationCount: () => Effect.succeed(0),
      forkSession: () =>
        Effect.die("forkSession should not be called when supportsSessionFork is false"),
      closeSession: () => Effect.void,
      request: () => Effect.die("unexpected request"),
      notify: () => Effect.void,
    };

    const testLayer = makeAntigravityAcpAdapterLive({
      makeRuntime: (input) =>
        Effect.sync(() => {
          runtimeCreations += 1;
          expect(input.resumeSessionId).toBe("conv-legacy-123");
          return mockRuntime;
        }),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, TEST_SERVER_CONFIG)),
      Layer.provideMerge(NodeServices.layer),
    );

    const threadId = ThreadId.makeUnsafe("thread-acp-1");

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const collectedEvents: ProviderRuntimeEvent[] = [];
        const collectorFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collectedEvents.push(event);
          }),
        ).pipe(Effect.forkScoped);

        // Starts session with print-mode string resumeCursor and default model
        const session = yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          runtimeMode: "full-access",
          cwd: "/tmp/workspace",
          resumeCursor: "conv-legacy-123",
          modelSelection: {
            provider: "antigravity",
            model: "Gemini 3.5 Flash",
          },
        });
        expect(session.resumeCursor).toBe("conv-legacy-123");
        expect(session.model).toBe("Gemini 3.8 Flash");
        expect(runtimeCreations).toBe(1);

        // Turn 1: streams thinking, subagent task, assistant text, and usage
        const turn1 = yield* adapter.sendTurn({
          threadId,
          input: "Run turn 1",
        });
        expect(turn1.resumeCursor).toBe("conv-legacy-123");

        // Wait for turn 1 to complete
        while (
          !collectedEvents.some(
            (event) => event.type === "turn.completed" && event.turnId === turn1.turnId,
          )
        ) {
          yield* Effect.sleep(10);
        }

        // Turn 2: cancel mid-turn and verify process stays alive
        const turn2 = yield* adapter.sendTurn({
          threadId,
          input: "WAIT_FOR_CANCEL",
        });
        while (!cancelSignal) {
          yield* Effect.sleep(5);
        }
        yield* adapter.interruptTurn(threadId, turn2.turnId);
        while (
          !collectedEvents.some(
            (event) => event.type === "turn.completed" && event.turnId === turn2.turnId,
          )
        ) {
          yield* Effect.sleep(10);
        }
        const turn2Completed = collectedEvents.find(
          (event) => event.type === "turn.completed" && event.turnId === turn2.turnId,
        );
        expect(turn2Completed?.payload).toMatchObject({
          state: "cancelled",
          stopReason: "cancelled",
        });
        expect(yield* adapter.hasSession(threadId)).toBe(true);

        // Turn 3: switch model in-session to Claude Sonnet 4.6 on the SAME runtime
        const turn3 = yield* adapter.sendTurn({
          threadId,
          input: "Run turn 3 after cancel",
          modelSelection: {
            provider: "antigravity",
            model: "Claude Sonnet 4.6",
          },
          interactionMode: "plan",
        });
        while (
          !collectedEvents.some(
            (event) => event.type === "turn.completed" && event.turnId === turn3.turnId,
          )
        ) {
          yield* Effect.sleep(10);
        }

        expect(runtimeCreations).toBe(1);
        expect(configOptionCalls).toContainEqual({
          configId: "model",
          value: "gemini-3.8-flash",
        });
        expect(configOptionCalls).toContainEqual({
          configId: "model",
          value: "claude-sonnet-4-6",
        });
        expect(modeCalls).toContain("plan");

        expect(collectedEvents.some((e) => e.type === "task.started")).toBe(true);
        expect(collectedEvents.some((e) => e.type === "task.completed")).toBe(true);
        expect(collectedEvents.some((e) => e.type === "thread.token-usage.updated")).toBe(true);

        const commands = yield* adapter.listCommands!({
          provider: "antigravity",
          cwd: "/tmp/workspace",
          threadId,
        });
        expect(commands.commands).toEqual([
          { name: "help", description: "Show help", argumentHint: "[topic]" },
        ]);

        yield* Fiber.interrupt(collectorFiber);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });

  it("closes discovery session, caches slash commands, and resolves fallback binary path when omitted", async () => {
    let closeCalls = 0;
    let commandReads = 0;
    const seenSettings: Array<{ binaryPath?: string | undefined }> = [];
    const baseRuntime = makeFakeAcpSessionRuntime();
    const discoveryRuntime: AcpSessionRuntimeShape = {
      ...baseRuntime,
      start: () =>
        Effect.succeed({
          sessionId: "disc-1",
          initializeResult: {
            protocolVersion: 1,
            agentCapabilities: { sessionCapabilities: { close: {} } },
          } as Acp.InitializeResponse,
          sessionSetupResult: {
            sessionId: "disc-1",
            models: {
              currentModelId: "gemini-4-hydrogen-medium",
              availableModels: [
                { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
                { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
              ],
            },
          } as Acp.NewSessionResponse,
          modelConfigId: "model",
          sessionSetupMethod: "new",
        }),
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-4-hydrogen",
          options: [{ value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" }],
        },
      ]),
      // Simulates `agy acp` emitting `available_commands_update` shortly after `session/new` returns.
      getAvailableCommands: Effect.sync(() => {
        commandReads += 1;
        return commandReads >= 2 ? [{ name: "swarm", description: "Run a swarm" }] : [];
      }),
      closeSession: () =>
        Effect.sync(() => {
          closeCalls += 1;
        }),
    };

    const spawnWithoutOverride = buildAntigravityAcpSpawnInput(undefined, "/tmp/workspace", {
      PATH: "/nonexistent-bin",
      HOME: "/tmp/nonexistent-home",
    });
    expect(spawnWithoutOverride.command).toBe("agy");

    const testLayer = makeAntigravityAcpAdapterLive({
      makeRuntime: (input) =>
        Effect.sync(() => {
          seenSettings.push({ binaryPath: input.antigravitySettings?.binaryPath });
          return discoveryRuntime;
        }),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, TEST_SERVER_CONFIG)),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const modelsResult = yield* adapter.listModels!({
          provider: "antigravity",
          binaryPath: "   ",
        });
        expect(seenSettings).toEqual([{ binaryPath: undefined }]);
        expect(closeCalls).toBe(1);
        expect(modelsResult.models[0]?.supportedReasoningEfforts).toEqual([
          { value: "low", label: "Low" },
          { value: "xhigh", label: "XHigh" },
        ]);

        const commandsResult = yield* adapter.listCommands!({
          provider: "antigravity",
          cwd: "/tmp/workspace",
        });
        expect(commandsResult.cached).toBe(true);
        expect(commandsResult.commands).toEqual([{ name: "swarm", description: "Run a swarm" }]);
        expect(seenSettings).toHaveLength(1);

        // A cache miss (another binary, a server restart, or expiry) runs discovery
        // for that binary instead of reusing another key's commands or returning nothing.
        const differentBinaryCommands = yield* adapter.listCommands!({
          provider: "antigravity",
          cwd: "/tmp/workspace",
          binaryPath: "/custom/bin/agy",
        });
        expect(seenSettings).toEqual([
          { binaryPath: undefined },
          { binaryPath: "/custom/bin/agy" },
        ]);
        expect(differentBinaryCommands.cached).toBe(false);
        expect(differentBinaryCommands.commands).toEqual([
          { name: "swarm", description: "Run a swarm" },
        ]);

        const differentEnvCommands = yield* adapter.listCommands!({
          provider: "antigravity",
          cwd: "/tmp/workspace",
          environment: { HOME: "/tmp/other-home" },
        });
        expect(seenSettings).toHaveLength(3);
        expect(differentEnvCommands.cached).toBe(false);

        const repeatedEnvCommands = yield* adapter.listCommands!({
          provider: "antigravity",
          cwd: "/tmp/workspace",
          environment: { HOME: "/tmp/other-home" },
        });
        expect(seenSettings).toHaveLength(3);
        expect(repeatedEnvCommands.cached).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });

  it("supports approval-required permission cards and full-access auto-approval", async () => {
    let permissionHandler:
      | Parameters<AcpSessionRuntimeShape["handleRequestPermission"]>[0]
      | undefined;
    let approvalOutcomeInPrompt: unknown;
    let fullAccessOutcomeInPrompt: unknown;
    let activeThreadRole: "approval" | "full-access" = "approval";
    const baseRuntime = makeFakeAcpSessionRuntime({
      prompt: () =>
        Effect.gen(function* () {
          const outcome = yield* permissionHandler!({
            sessionId: "acp-test-session",
            toolCall: { toolCallId: "tc-1", kind: "execute", title: "echo ok" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
            ],
          });
          if (activeThreadRole === "approval") {
            approvalOutcomeInPrompt = outcome;
          } else {
            fullAccessOutcomeInPrompt = outcome;
          }
          return { stopReason: "end_turn" as const };
        }),
    });
    const runtime: AcpSessionRuntimeShape = {
      ...baseRuntime,
      handleRequestPermission: (handler) =>
        Effect.sync(() => {
          permissionHandler = handler;
        }),
      getModeState: Effect.succeed({
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "auto", name: "Auto" },
          { id: "plan", name: "Plan" },
        ],
      }),
    };

    const testLayer = makeAntigravityAcpAdapterLive({
      makeRuntime: () => Effect.succeed(runtime),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, TEST_SERVER_CONFIG)),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const collectedEvents: ProviderRuntimeEvent[] = [];
        const collectorFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collectedEvents.push(event);
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const approvalThreadId = ThreadId.makeUnsafe("thread-approval");
        yield* adapter.startSession({
          threadId: approvalThreadId,
          provider: "antigravity",
          runtimeMode: "approval-required",
          cwd: "/tmp/workspace",
        });

        activeThreadRole = "approval";
        const approvalTurn = yield* adapter.sendTurn({
          threadId: approvalThreadId,
          input: "Run shell",
        });

        let openedEvent: Extract<ProviderRuntimeEvent, { type: "request.opened" }> | undefined;
        for (let i = 0; i < 40; i += 1) {
          openedEvent = collectedEvents.find(
            (e): e is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
              e.type === "request.opened" && e.threadId === approvalThreadId,
          );
          if (openedEvent) break;
          yield* Effect.sleep(5);
        }
        expect(openedEvent).toBeDefined();

        yield* adapter.respondToRequest(
          approvalThreadId,
          openedEvent!.requestId as unknown as Parameters<typeof adapter.respondToRequest>[1],
          "accept",
        );
        while (
          !collectedEvents.some(
            (e) => e.type === "turn.completed" && e.turnId === approvalTurn.turnId,
          )
        ) {
          yield* Effect.sleep(5);
        }
        expect(approvalOutcomeInPrompt).toEqual({
          outcome: { outcome: "selected", optionId: "allow-once" },
        });

        const fullAccessThreadId = ThreadId.makeUnsafe("thread-full-access");
        yield* adapter.startSession({
          threadId: fullAccessThreadId,
          provider: "antigravity",
          runtimeMode: "full-access",
          cwd: "/tmp/workspace",
        });
        activeThreadRole = "full-access";
        const fullAccessTurn = yield* adapter.sendTurn({
          threadId: fullAccessThreadId,
          input: "Run shell without prompt",
        });
        while (
          !collectedEvents.some(
            (e) => e.type === "turn.completed" && e.turnId === fullAccessTurn.turnId,
          )
        ) {
          yield* Effect.sleep(5);
        }
        expect(fullAccessOutcomeInPrompt).toEqual({
          outcome: { outcome: "selected", optionId: "allow-once" },
        });

        yield* Fiber.interrupt(collectorFiber);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });

  it("emits UsageUpdated outside turns, captures plan proposals once per plan turn, forwards additionalDirectories, and reads external threads", async () => {
    const eventQueue = await Effect.runPromise(Queue.unbounded<AcpParsedSessionEvent>());
    let enqueuedCount = 0;
    const emitAcpEvent = (event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        enqueuedCount += 1;
        yield* Queue.offer(eventQueue, event);
      });

    const recordedAdditionalDirs: Array<ReadonlyArray<string> | undefined> = [];
    let sessionUpdateHandler:
      | Parameters<AcpSessionRuntimeShape["handleSessionUpdate"]>[0]
      | undefined;
    let loadCloseCalls = 0;

    const planArtifact = extractAntigravityPlanArtifactMarkdown({
      toolCallId: "plan-edit-1",
      kind: "edit",
      detail: "/tmp/brain/plan.md",
      data: {
        rawInput: {
          Path: "/tmp/brain/plan.md",
          Content: "# Plan Title\n\n- Step 1\n",
        },
      },
    });
    expect(planArtifact).toBe("# Plan Title\n\n- Step 1");
    // Live agy 1.5.9 names the artifact implementation_plan.md.
    expect(
      extractAntigravityPlanArtifactMarkdown({
        toolCallId: "plan-edit-2",
        kind: "edit",
        detail: "/tmp/brain/implementation_plan.md",
        data: { rawInput: { Path: "/tmp/brain/implementation_plan.md", Content: "# Impl\n" } },
      }),
    ).toBe("# Impl");
    expect(
      extractAntigravityPlanArtifactMarkdown({
        toolCallId: "plan-edit-3",
        kind: "edit",
        detail: "/tmp/workspace/airplan.md",
        data: { rawInput: { Path: "/tmp/workspace/airplan.md", Content: "x" } },
      }),
    ).toBeUndefined();

    const testLayer = makeAntigravityAcpAdapterLive({
      makeRuntime: (input) =>
        Effect.sync(() => {
          recordedAdditionalDirs.push(input.additionalDirectories);
          const base = makeFakeAcpSessionRuntime({
            prompt: ({ prompt }) =>
              Effect.gen(function* () {
                const text = prompt
                  .filter(
                    (b): b is Extract<Acp.ContentBlock, { type: "text" }> => b.type === "text",
                  )
                  .map((b) => b.text)
                  .join("\n");
                if (text.includes("PLAN_TURN")) {
                  yield* emitAcpEvent({
                    _tag: "ToolCallUpdated",
                    toolCall: {
                      toolCallId: "plan-call-1",
                      kind: "edit",
                      status: "completed",
                      detail: "/tmp/brain/plan.md",
                      data: {
                        rawInput: {
                          Path: "/tmp/brain/plan.md",
                          Content: "# Artifact Plan\n\n1. Step A\n",
                        },
                      },
                    },
                    rawPayload: {},
                  });
                  yield* emitAcpEvent({
                    _tag: "ContentDelta",
                    itemId: "plan-msg",
                    text: "Created plan artifact.",
                    streamKind: "assistant_text",
                    rawPayload: {},
                  });
                } else {
                  yield* emitAcpEvent({
                    _tag: "ContentDelta",
                    itemId: "normal-msg",
                    text: "Normal response",
                    streamKind: "assistant_text",
                    rawPayload: {},
                  });
                }
                return {
                  stopReason: "end_turn" as const,
                  usage: {
                    inputTokens: 100,
                    outputTokens: 50,
                    totalTokens: 150,
                  },
                };
              }),
          });
          if (input.sessionSetupMode === "load-only") {
            return {
              ...base,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdateHandler = handler;
                }),
              start: () =>
                Effect.gen(function* () {
                  yield* sessionUpdateHandler!({
                    sessionId: "ext-agy-1",
                    update: {
                      sessionUpdate: "user_message_chunk",
                      content: { type: "text", text: "Hello agy" },
                    },
                  });
                  yield* sessionUpdateHandler!({
                    sessionId: "ext-agy-1",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Hi from agy" },
                    },
                  });
                  return {
                    sessionId: "ext-agy-1",
                    initializeResult: {
                      protocolVersion: 1,
                      loadSession: true,
                      sessionCapabilities: { close: {}, list: {} },
                      agentCapabilities: {
                        loadSession: true,
                        sessionCapabilities: { close: {}, list: {} },
                      },
                    } as Acp.InitializeResponse,
                    sessionSetupResult: { sessionId: "ext-agy-1" } as Acp.LoadSessionResponse,
                    modelConfigId: undefined,
                    sessionSetupMethod: "load" as const,
                  };
                }),
              request: (method) =>
                method === "session/list"
                  ? Effect.succeed({
                      sessions: [{ sessionId: "ext-agy-1", cwd: "/tmp/cli-project" }],
                    })
                  : Effect.succeed({}),
              closeSession: () =>
                Effect.sync(() => {
                  loadCloseCalls += 1;
                }),
            } satisfies AcpSessionRuntimeShape;
          }
          return {
            ...base,
            getEvents: () => Stream.fromQueue(eventQueue),
            sessionUpdatesEnqueuedCount: Effect.sync(() => enqueuedCount),
            getModeState: Effect.succeed({
              currentModeId: "default",
              availableModes: [
                { id: "default", name: "Default" },
                { id: "plan", name: "Plan" },
              ],
            }),
          } satisfies AcpSessionRuntimeShape;
        }),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, TEST_SERVER_CONFIG)),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const caps = yield* adapter.getComposerCapabilities!();
        expect(caps.supportsThreadImport).toBe(true);

        const external = yield* adapter.readExternalThread!({ externalThreadId: "ext-agy-1" });
        expect(external.cwd).toBe("/tmp/cli-project");
        expect(external.turns).toHaveLength(1);
        expect(external.turns[0]?.items).toEqual([
          { type: "antigravityMessage", role: "user", text: "Hello agy" },
          { type: "antigravityMessage", role: "assistant", text: "Hi from agy" },
        ]);
        expect(loadCloseCalls).toBe(1);

        const collectedEvents: ProviderRuntimeEvent[] = [];
        const collectorFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            collectedEvents.push(event);
          }),
        ).pipe(Effect.forkScoped);

        const threadId = ThreadId.makeUnsafe("thread-plan-usage");
        yield* adapter.startSession({
          threadId,
          provider: "antigravity",
          runtimeMode: "full-access",
          cwd: "/tmp/workspace",
          additionalDirectories: ["/tmp/extra-dir"],
        });
        expect(recordedAdditionalDirs).toContainEqual(["/tmp/extra-dir"]);

        // Out-of-turn UsageUpdated emits with turnId undefined and sets maxTokens window
        yield* emitAcpEvent({
          _tag: "UsageUpdated",
          usage: { usedTokens: 0, maxTokens: 524_288, compactsAutomatically: true },
          rawPayload: {},
        });
        while (
          !collectedEvents.some(
            (e) => e.type === "thread.token-usage.updated" && e.turnId === undefined,
          )
        ) {
          yield* Effect.sleep(5);
        }

        const planTurn = yield* adapter.sendTurn({
          threadId,
          input: "PLAN_TURN",
          interactionMode: "plan",
        });
        while (
          !collectedEvents.some((e) => e.type === "turn.completed" && e.turnId === planTurn.turnId)
        ) {
          yield* Effect.sleep(5);
        }

        const planProposals = collectedEvents.filter(
          (e) => e.type === "turn.proposed.completed" && e.turnId === planTurn.turnId,
        );
        expect(planProposals).toHaveLength(1);
        if (planProposals[0]?.type === "turn.proposed.completed") {
          expect(planProposals[0].payload.planMarkdown).toBe("# Artifact Plan\n\n1. Step A");
        }
        const promptUsage = collectedEvents.findLast(
          (e) => e.type === "thread.token-usage.updated" && e.turnId === planTurn.turnId,
        );
        if (promptUsage?.type === "thread.token-usage.updated") {
          expect(promptUsage.payload.usage.maxTokens).toBe(524_288);
        }

        const normalTurn = yield* adapter.sendTurn({
          threadId,
          input: "NORMAL_TURN",
          interactionMode: "default",
        });
        while (
          !collectedEvents.some(
            (e) => e.type === "turn.completed" && e.turnId === normalTurn.turnId,
          )
        ) {
          yield* Effect.sleep(5);
        }
        expect(
          collectedEvents.some(
            (e) => e.type === "turn.proposed.completed" && e.turnId === normalTurn.turnId,
          ),
        ).toBe(false);

        yield* Fiber.interrupt(collectorFiber);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });

  it("splits replayed external user messages on messageId boundaries and assistant activity while keeping import text-only", async () => {
    let sessionUpdateHandler:
      | Parameters<AcpSessionRuntimeShape["handleSessionUpdate"]>[0]
      | undefined;

    const testLayer = makeAntigravityAcpAdapterLive({
      makeRuntime: () =>
        Effect.sync(() => {
          const base = makeFakeAcpSessionRuntime();
          return {
            ...base,
            handleSessionUpdate: (handler) =>
              Effect.sync(() => {
                sessionUpdateHandler = handler;
              }),
            start: () =>
              Effect.gen(function* () {
                // Consecutive user messages with distinct messageIds and no assistant reply in between
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "u1",
                    content: { type: "text", text: "First " },
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "u1",
                    content: { type: "text", text: "prompt" },
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "u2",
                    content: { type: "image", data: "AAAA", mimeType: "image/png" },
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "u2",
                    content: { type: "text", text: "Second prompt" },
                  },
                });
                // Thought/tool activity without assistant text still splits the next user message
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "agent_thought_chunk",
                    content: { type: "text", text: "Thinking..." },
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "tc-1",
                    title: "Read file",
                    kind: "read",
                    status: "completed",
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "user_message_chunk",
                    content: { type: "text", text: "Third prompt" },
                  },
                });
                yield* sessionUpdateHandler!({
                  sessionId: "ext-boundary-1",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "Final reply" },
                  },
                });
                return {
                  sessionId: "ext-boundary-1",
                  initializeResult: {
                    protocolVersion: 1,
                    loadSession: true,
                    agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
                  } as Acp.InitializeResponse,
                  sessionSetupResult: { sessionId: "ext-boundary-1" } as Acp.LoadSessionResponse,
                  modelConfigId: undefined,
                  sessionSetupMethod: "load" as const,
                };
              }),
          } satisfies AcpSessionRuntimeShape;
        }),
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, TEST_SERVER_CONFIG)),
      Layer.provideMerge(NodeServices.layer),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AntigravityAdapter;
        const external = yield* adapter.readExternalThread!({
          externalThreadId: "ext-boundary-1",
          cwd: "/tmp/workspace",
        });
        expect(external.turns).toHaveLength(3);
        expect(external.turns[0]?.items).toEqual([
          { type: "antigravityMessage", role: "user", text: "First prompt" },
        ]);
        expect(external.turns[1]?.items).toEqual([
          { type: "antigravityMessage", role: "user", text: "Second prompt" },
        ]);
        expect(external.turns[2]?.items).toEqual([
          { type: "antigravityMessage", role: "user", text: "Third prompt" },
          { type: "antigravityMessage", role: "assistant", text: "Final reply" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });
});
