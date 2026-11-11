import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { type ProviderRuntimeEvent, ThreadId, TurnId } from "@saint/contracts";
import { Deferred, Effect, Fiber, Layer, Option, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { SAINT_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { ServerConfig } from "../../config.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";
import {
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

        // Rejects non-full-access runtimeMode
        const validationFailure = yield* Effect.flip(
          adapter.startSession({
            threadId,
            provider: "antigravity",
            runtimeMode: "approval-required",
            cwd: "/tmp/workspace",
          }),
        );
        expect(validationFailure.message).toContain("Select Full access");

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
});
