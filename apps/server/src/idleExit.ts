/**
 * IdleExit - Opt-in graceful shutdown for a server nobody is using.
 *
 * A remote (SSH-launched) server sets `SAINT_IDLE_EXIT_MS`; once the server has
 * been continuously not-busy for that long it requests the normal graceful
 * stop, so provider sessions are stopped and the database is closed by the
 * usual finalizers. Unset/invalid disables the feature (local desktop and CLI).
 *
 * Busy means any of: an open RPC WebSocket client, a thread with an active
 * turn, a terminal doing work, a provider-native background task, or an
 * enabled automation with a scheduled run. The decision is a pure fold over a
 * periodic sample; domain events also reset the idle clock between samples.
 */
import { Clock, Duration, Effect, Ref, Scope, Stream } from "effect";

import { AutomationRepository } from "./persistence/Services/AutomationRepository";
import { applySessionEvent, seedActiveThreads } from "./keepAwake";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import { isServerGroupsEnabled } from "./projectAgent/groupsBetaGate";
import { ProviderService } from "./provider/Services/ProviderService";
import { TerminalManager } from "./terminal/Services/Manager";

export const IDLE_EXIT_ENV = "SAINT_IDLE_EXIT_MS";

const MIN_CHECK_INTERVAL_MS = 1_000;
const MAX_CHECK_INTERVAL_MS = 30_000;

/** Parses `SAINT_IDLE_EXIT_MS`; anything but a positive number disables idle exit. */
export function parseIdleExitMs(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value) > 0 ? Math.floor(value) : undefined;
}

/** Sample often enough to exit close to the deadline, but at most every 30s. */
export function idleExitCheckIntervalMs(idleExitMs: number): number {
  return Math.min(
    MAX_CHECK_INTERVAL_MS,
    Math.max(MIN_CHECK_INTERVAL_MS, Math.floor(idleExitMs / 4)),
  );
}

export type IdleExitBusyReason =
  | "websocket-client"
  | "active-turn"
  | "terminal"
  | "provider-task"
  | "automation";

export interface IdleExitSignals {
  readonly webSocketClients: number;
  readonly activeTurns: number;
  readonly terminalBusy: boolean;
  readonly providerTasksLive: boolean;
  readonly automationScheduled: boolean;
}

export function idleExitBusyReason(signals: IdleExitSignals): IdleExitBusyReason | null {
  if (signals.webSocketClients > 0) return "websocket-client";
  if (signals.activeTurns > 0) return "active-turn";
  if (signals.terminalBusy) return "terminal";
  if (signals.providerTasksLive) return "provider-task";
  if (signals.automationScheduled) return "automation";
  return null;
}

/** Busy clears the idle clock; the first not-busy sample starts it. */
export function advanceIdleSince(
  idleSince: number | null,
  busy: boolean,
  now: number,
): number | null {
  if (busy) return null;
  return idleSince ?? now;
}

export function isIdleExitDue(idleSince: number | null, now: number, idleExitMs: number): boolean {
  return idleSince !== null && now - idleSince >= idleExitMs;
}

/** Read-only probes for the busy signals that are not tracked from domain events. */
export interface IdleExitProbes {
  readonly webSocketClients: () => number;
  readonly terminalBusy: Effect.Effect<boolean>;
  readonly providerTasksLive: Effect.Effect<boolean>;
  readonly automationScheduled: Effect.Effect<boolean>;
}

export interface IdleExitOptions {
  readonly idleExitMs: number;
  readonly checkIntervalMs?: number;
  readonly orchestrationEngine: Pick<
    OrchestrationEngineShape,
    "subscribeDomainEvents" | "getReadModel"
  >;
  readonly probes: IdleExitProbes;
  readonly requestStop: Effect.Effect<boolean>;
}

/**
 * Samples the busy signals until the idle deadline passes, then requests a
 * graceful stop once. Runs in the caller's scope and ends with it.
 */
export const startIdleExit = (options: IdleExitOptions): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { idleExitMs, probes } = options;
    const checkIntervalMs = options.checkIntervalMs ?? idleExitCheckIntervalMs(idleExitMs);
    const activeThreadsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
    const idleSinceRef = yield* Ref.make<number | null>(yield* Clock.currentTimeMillis);

    // Subscribe before seeding so no session transition slips between them.
    const domainEvents = yield* options.orchestrationEngine.subscribeDomainEvents;
    yield* Ref.set(
      activeThreadsRef,
      seedActiveThreads(yield* options.orchestrationEngine.getReadModel()),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(domainEvents, (event) =>
        Effect.gen(function* () {
          // Any domain event is activity: restart the idle clock from now.
          yield* Ref.set(idleSinceRef, null);
          yield* Ref.update(activeThreadsRef, (active) => applySessionEvent(active, event));
        }),
      ),
    );

    // The automation query is the only non-trivial probe; run it last and only when idle.
    const sampleBusyReason = Effect.gen(function* () {
      const reason = idleExitBusyReason({
        webSocketClients: probes.webSocketClients(),
        activeTurns: (yield* Ref.get(activeThreadsRef)).size,
        terminalBusy: yield* probes.terminalBusy,
        providerTasksLive: yield* probes.providerTasksLive,
        automationScheduled: false,
      });
      if (reason !== null) return reason;
      return (yield* probes.automationScheduled) ? ("automation" as const) : null;
    });

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(checkIntervalMs));
          const reason = yield* sampleBusyReason;
          const now = yield* Clock.currentTimeMillis;
          // Atomic so a domain-event reset that lands mid-sample is not overwritten.
          const idleSince = yield* Ref.updateAndGet(idleSinceRef, (previous) =>
            advanceIdleSince(previous, reason !== null, now),
          );
          if (isIdleExitDue(idleSince, now, idleExitMs)) {
            yield* Effect.logInfo("idle exit: no clients or work; stopping server", {
              idleExitMs,
              idleForMs: now - (idleSince ?? now),
            });
            yield* options.requestStop;
            return;
          }
        }
      }),
    );
  });

/**
 * Builds the live probes from server services and starts idle exit. The
 * WebSocket client count comes from the server-owned connection registry.
 */
export const startServerIdleExit = Effect.fn(function* (input: {
  readonly idleExitMs: number;
  readonly webSocketClients: () => number;
  readonly requestStop: Effect.Effect<boolean>;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const terminalManager = yield* TerminalManager;
  const providerService = yield* ProviderService;
  const automationRepository = yield* AutomationRepository;

  const automationScheduled = Effect.suspend(() =>
    automationRepository.getEarliestNextRunAt({
      now: new Date().toISOString(),
      // Mirror the scheduler: project-managed automations only fire with Groups enabled.
      excludeProjectManaged: !isServerGroupsEnabled(),
    }),
  ).pipe(
    Effect.map((nextRunAt) => nextRunAt !== null),
    Effect.catch((error) =>
      // Stay up when the schedule cannot be read; exiting could drop a run.
      Effect.logWarning("idle exit could not read automation schedule; staying up", {
        cause: error,
      }).pipe(Effect.as(true)),
    ),
  );

  yield* Effect.logInfo("idle exit enabled", { idleExitMs: input.idleExitMs });
  yield* startIdleExit({
    idleExitMs: input.idleExitMs,
    orchestrationEngine,
    requestStop: input.requestStop,
    probes: {
      webSocketClients: input.webSocketClients,
      terminalBusy: terminalManager.hasActiveWork,
      providerTasksLive: providerService.hasAnyLiveRuntimeTasks ?? Effect.succeed(false),
      automationScheduled,
    },
  });
});
