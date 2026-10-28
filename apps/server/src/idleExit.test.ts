import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ThreadId,
  TurnId,
} from "@saint/contracts";
import { Duration, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  advanceIdleSince,
  idleExitBusyReason,
  idleExitCheckIntervalMs,
  type IdleExitSignals,
  isIdleExitDue,
  parseIdleExitMs,
  startIdleExit,
  startServerIdleExit,
} from "./idleExit";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { AutomationRepository } from "./persistence/Services/AutomationRepository";
import { ProviderService } from "./provider/Services/ProviderService";
import { TerminalManager } from "./terminal/Services/Manager";

const NOW = "2026-10-27T10:00:00.000Z";
const IDLE_EXIT_MS = 60_000;

const IDLE: IdleExitSignals = {
  webSocketClients: 0,
  activeTurns: 0,
  terminalBusy: false,
  providerTasksLive: false,
  automationScheduled: false,
};

function sessionSetEvent(input: {
  readonly threadId: string;
  readonly activeTurnId: string | null;
  readonly sequence: number;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe(input.threadId),
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    type: "thread.session-set",
    payload: {
      threadId: ThreadId.makeUnsafe(input.threadId),
      session: {
        threadId: ThreadId.makeUnsafe(input.threadId),
        status: input.activeTurnId === null ? "idle" : "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: input.activeTurnId === null ? null : TurnId.makeUnsafe(input.activeTurnId),
        lastError: null,
        updatedAt: NOW,
      },
    },
  } as OrchestrationEvent;
}

describe("idle exit pure helpers", () => {
  it("parseIdleExitMs accepts only positive numbers", () => {
    expect(parseIdleExitMs(undefined)).toBeUndefined();
    expect(parseIdleExitMs("")).toBeUndefined();
    expect(parseIdleExitMs("   ")).toBeUndefined();
    expect(parseIdleExitMs("soon")).toBeUndefined();
    expect(parseIdleExitMs("10m")).toBeUndefined();
    expect(parseIdleExitMs("0")).toBeUndefined();
    expect(parseIdleExitMs("-1000")).toBeUndefined();
    expect(parseIdleExitMs("0.5")).toBeUndefined();
    expect(parseIdleExitMs("Infinity")).toBeUndefined();
    expect(parseIdleExitMs("1800000")).toBe(1_800_000);
    expect(parseIdleExitMs(" 90000 ")).toBe(90_000);
    expect(parseIdleExitMs("1500.7")).toBe(1_500);
  });

  it("checks every quarter of the deadline, clamped to 1s..30s", () => {
    expect(idleExitCheckIntervalMs(100)).toBe(1_000);
    expect(idleExitCheckIntervalMs(60_000)).toBe(15_000);
    expect(idleExitCheckIntervalMs(30 * 60_000)).toBe(30_000);
  });

  it("idleExitBusyReason reports any busy signal", () => {
    expect(idleExitBusyReason(IDLE)).toBeNull();
    expect(idleExitBusyReason({ ...IDLE, webSocketClients: 1 })).toBe("websocket-client");
    expect(idleExitBusyReason({ ...IDLE, activeTurns: 2 })).toBe("active-turn");
    expect(idleExitBusyReason({ ...IDLE, terminalBusy: true })).toBe("terminal");
    expect(idleExitBusyReason({ ...IDLE, providerTasksLive: true })).toBe("provider-task");
    expect(idleExitBusyReason({ ...IDLE, automationScheduled: true })).toBe("automation");
  });

  it("busy resets the idle clock and the deadline is measured from the first idle sample", () => {
    expect(advanceIdleSince(null, false, 1_000)).toBe(1_000);
    expect(advanceIdleSince(1_000, false, 5_000)).toBe(1_000);
    expect(advanceIdleSince(1_000, true, 5_000)).toBeNull();
    expect(isIdleExitDue(null, 10_000, 1_000)).toBe(false);
    expect(isIdleExitDue(1_000, 1_999, 1_000)).toBe(false);
    expect(isIdleExitDue(1_000, 2_000, 1_000)).toBe(true);
  });
});

interface HarnessState {
  webSocketClients: number;
  terminalBusy: boolean;
  providerTasksLive: boolean;
  automationScheduled: boolean;
  automationQueries: number;
  stopRequests: number;
}

const runHarness = (
  input: {
    readonly initialActiveThreads?: ReadonlyArray<string>;
    readonly state?: Partial<HarnessState>;
  },
  body: (harness: {
    readonly state: HarnessState;
    readonly publish: (event: OrchestrationEvent) => Effect.Effect<void>;
    readonly advance: (millis: number) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const state: HarnessState = {
      webSocketClients: 0,
      terminalBusy: false,
      providerTasksLive: false,
      automationScheduled: false,
      automationQueries: 0,
      stopRequests: 0,
      ...input.state,
    };
    const eventsPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
    const readModel = {
      threads: (input.initialActiveThreads ?? []).map((id) => ({
        id,
        session: { status: "running", activeTurnId: `turn-${id}` },
      })),
    } as unknown as OrchestrationReadModel;
    yield* startIdleExit({
      idleExitMs: IDLE_EXIT_MS,
      orchestrationEngine: {
        subscribeDomainEvents: PubSub.subscribe(eventsPubSub).pipe(
          Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
        ),
        getReadModel: () => Effect.succeed(readModel),
      },
      probes: {
        webSocketClients: () => state.webSocketClients,
        terminalBusy: Effect.sync(() => state.terminalBusy),
        providerTasksLive: Effect.sync(() => state.providerTasksLive),
        automationScheduled: Effect.sync(() => {
          state.automationQueries += 1;
          return state.automationScheduled;
        }),
      },
      requestStop: Effect.sync(() => {
        state.stopRequests += 1;
        return state.stopRequests === 1;
      }),
    });
    yield* body({
      state,
      publish: (event) =>
        PubSub.publish(eventsPubSub, event).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.yieldNow),
        ),
      advance: (millis) => TestClock.adjust(Duration.millis(millis)),
    });
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.runPromise);

describe("startIdleExit", () => {
  it("requests one stop once the server has been idle for the deadline", async () => {
    await runHarness({}, ({ state, advance }) =>
      Effect.gen(function* () {
        yield* advance(IDLE_EXIT_MS - 15_000);
        expect(state.stopRequests).toBe(0);
        yield* advance(15_000);
        expect(state.stopRequests).toBe(1);
        // The loop ends after the first request.
        yield* advance(10 * IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(1);
      }),
    );
  });

  it("stays up while a WebSocket client is connected and restarts the clock on disconnect", async () => {
    await runHarness({ state: { webSocketClients: 1 } }, ({ state, advance }) =>
      Effect.gen(function* () {
        yield* advance(10 * IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(0);
        // Busy samples skip the automation query entirely.
        expect(state.automationQueries).toBe(0);
        state.webSocketClients = 0;
        yield* advance(IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(0);
        yield* advance(15_000);
        expect(state.stopRequests).toBe(1);
      }),
    );
  });

  it("stays up while a turn is active and exits after the turn settles", async () => {
    await runHarness({ initialActiveThreads: ["t1"] }, ({ state, advance, publish }) =>
      Effect.gen(function* () {
        yield* advance(10 * IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(0);
        yield* publish(sessionSetEvent({ threadId: "t1", activeTurnId: null, sequence: 1 }));
        yield* advance(IDLE_EXIT_MS + 15_000);
        expect(state.stopRequests).toBe(1);
      }),
    );
  });

  it("tracks turns that start after startup", async () => {
    await runHarness({}, ({ state, advance, publish }) =>
      Effect.gen(function* () {
        yield* publish(sessionSetEvent({ threadId: "t2", activeTurnId: "turn-1", sequence: 1 }));
        yield* advance(10 * IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(0);
      }),
    );
  });

  it("a domain event resets the idle clock between samples", async () => {
    await runHarness({}, ({ state, advance, publish }) =>
      Effect.gen(function* () {
        yield* advance(45_000);
        yield* publish({
          ...sessionSetEvent({ threadId: "t-3", activeTurnId: null, sequence: 1 }),
        });
        yield* advance(30_000);
        expect(state.stopRequests).toBe(0);
        yield* advance(IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(1);
      }),
    );
  });

  it.each([
    ["a running terminal", { terminalBusy: true }],
    ["a live provider background task", { providerTasksLive: true }],
    ["an enabled automation", { automationScheduled: true }],
  ] as const)("stays up while there is %s", async (_label, busy) => {
    await runHarness({ state: busy }, ({ state, advance }) =>
      Effect.gen(function* () {
        yield* advance(10 * IDLE_EXIT_MS);
        expect(state.stopRequests).toBe(0);
      }),
    );
  });
});

describe("startServerIdleExit", () => {
  const makeLayer = (input: {
    readonly terminalBusy: boolean;
    readonly providerTasksLive?: boolean;
    readonly nextRunAt: string | null | "error";
  }) =>
    Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, {
        subscribeDomainEvents: Effect.succeed(Stream.never),
        getReadModel: () => Effect.succeed({ threads: [] } as unknown as OrchestrationReadModel),
      } as unknown as OrchestrationEngineService["Service"]),
      Layer.succeed(TerminalManager, {
        hasActiveWork: Effect.succeed(input.terminalBusy),
      } as unknown as TerminalManager["Service"]),
      Layer.succeed(
        ProviderService,
        (input.providerTasksLive === undefined
          ? {}
          : {
              hasAnyLiveRuntimeTasks: Effect.succeed(input.providerTasksLive),
            }) as unknown as ProviderService["Service"],
      ),
      Layer.succeed(AutomationRepository, {
        getEarliestNextRunAt: () =>
          input.nextRunAt === "error"
            ? Effect.fail(new Error("db closed"))
            : Effect.succeed(input.nextRunAt),
      } as unknown as AutomationRepository["Service"]),
    );

  const stopsAfterIdle = (layer: ReturnType<typeof makeLayer>) =>
    Effect.gen(function* () {
      let stops = 0;
      yield* startServerIdleExit({
        idleExitMs: IDLE_EXIT_MS,
        webSocketClients: () => 0,
        requestStop: Effect.sync(() => {
          stops += 1;
          return true;
        }),
      });
      yield* TestClock.adjust(Duration.millis(10 * IDLE_EXIT_MS));
      return stops > 0;
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(layer, TestClock.layer())),
      Effect.runPromise,
    );

  it("stops when every live probe is idle, including providers without the task accessor", async () => {
    expect(await stopsAfterIdle(makeLayer({ terminalBusy: false, nextRunAt: null }))).toBe(true);
    expect(
      await stopsAfterIdle(
        makeLayer({ terminalBusy: false, providerTasksLive: false, nextRunAt: null }),
      ),
    ).toBe(true);
  });

  it("reads terminals, provider tasks and the automation schedule from the live services", async () => {
    expect(await stopsAfterIdle(makeLayer({ terminalBusy: true, nextRunAt: null }))).toBe(false);
    expect(
      await stopsAfterIdle(
        makeLayer({ terminalBusy: false, providerTasksLive: true, nextRunAt: null }),
      ),
    ).toBe(false);
    expect(
      await stopsAfterIdle(makeLayer({ terminalBusy: false, nextRunAt: "2026-10-28T00:00:00Z" })),
    ).toBe(false);
  });

  it("stays up when the automation schedule cannot be read", async () => {
    expect(await stopsAfterIdle(makeLayer({ terminalBusy: false, nextRunAt: "error" }))).toBe(
      false,
    );
  });
});
