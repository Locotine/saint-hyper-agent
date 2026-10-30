import {
  EconomySettings,
  type EconomySettings as EconomySettingsValue,
  type EconomyAgent,
  type EconomyLevel,
  type EconomyProcess,
  type EconomySample,
  type EconomyStatus,
  type ThreadId,
} from "@saint/contracts";
import { Cause, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  DEFAULT_ECONOMY_SETTINGS,
  admissionReason,
  admissionRefuses,
  attributeOwners,
  cpuPercents,
  economyLevel,
  hubServers,
  idleThresholdMs,
  pushSample,
  readHost,
} from "../hostMetrics.ts";
import { agentProcessOwners } from "../agentProcesses.ts";
import { sharedMcpHub } from "../mcpHub.ts";
import { Economy, EconomyError, setFlowAdmission, type EconomyShape } from "../Services/Economy.ts";

const SettingsJson = Schema.fromJsonString(EconomySettings);
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const toError = (message: string) => (cause: unknown) =>
  cause instanceof EconomyError ? cause : new EconomyError({ message, cause });
const SAMPLE_INTERVAL = Duration.minutes(1);
/** An agent seen within this window counts as active rather than idle. */
const ACTIVE_WINDOW_MS = 60_000;
/** Events that mean someone is talking to the thread again. */
const WAKE_EVENTS = new Set(["thread.message-sent", "thread.turn-start-requested"]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const samples: EconomySample[] = [];
  let processes: EconomyProcess[] = [];
  let cpuTicks = new Map<number, number>();
  let lastReadAt = 0;
  let cached: typeof DEFAULT_ECONOMY_SETTINGS | null = null;
  const hibernated = new Map<string, string>();

  const settings = () =>
    cached
      ? Effect.succeed(cached)
      : sql<{ valueJson: string }>`
          SELECT value_json AS "valueJson" FROM economy_settings WHERE setting_key = 'settings'
        `.pipe(
          Effect.flatMap((rows) =>
            rows[0] ? decodeSettings(rows[0].valueJson) : Effect.succeed(DEFAULT_ECONOMY_SETTINGS),
          ),
          Effect.tap((value) =>
            Effect.sync(() => {
              cached = value;
              sharedMcpHub.setShared(value.hubShared);
            }),
          ),
          Effect.mapError(toError("Could not read the economy settings.")),
        );

  const liveBindings = directory.listBindings().pipe(
    Effect.map((bindings) => bindings.filter((binding) => binding.status !== "stopped")),
    Effect.mapError(toError("Could not read the provider sessions.")),
  );

  const level = (): EconomyLevel => samples.at(-1)?.level ?? "ok";

  const refreshAdmission = Effect.gen(function* () {
    const value = yield* settings();
    const seats = (yield* liveBindings).length;
    setFlowAdmission(
      admissionReason(level(), seats, value.seatCap),
      admissionRefuses(level(), seats, value.seatCap),
    );
  });

  const sample = Effect.gen(function* () {
    const value = yield* settings();
    const reading = yield* Effect.promise(() => readHost());
    const now = Date.now();
    const cpu = cpuPercents(reading.processes, cpuTicks, now - lastReadAt);
    cpuTicks = new Map(reading.processes.map((row) => [row.pid, row.cpu]));
    lastReadAt = now;
    const owners = attributeOwners(
      reading.processes,
      agentProcessOwners(new Set(reading.processes.map((row) => row.pid))),
    );
    processes = reading.processes
      .map((row) => ({
        pid: row.pid,
        threadId: (owners.get(row.pid) as ThreadId | undefined) ?? null,
        label: row.label,
        rssMb: Math.round(row.rssKb / 1024),
        cpuPct: cpu.get(row.pid) ?? 0,
      }))
      .toSorted((a, b) => b.rssMb - a.rssMb);
    const usedPct = reading.totalMb > 0 ? (reading.usedMb / reading.totalMb) * 100 : 0;
    pushSample(samples, {
      at: new Date(now).toISOString(),
      totalMb: reading.totalMb,
      usedMb: reading.usedMb,
      stallPct: reading.stallPct,
      agentRssMb: processes.reduce((sum, row) => sum + row.rssMb, 0),
      level: economyLevel(usedPct, reading.stallPct, value),
    });
  });

  /** Threads a flow message is still waiting for: hibernating them would strand it. */
  const threadsWithPendingMessages = sql<{ threadId: string }>`
    SELECT DISTINCT n.thread_id AS "threadId"
    FROM sap_messages m
    JOIN flow_nodes n ON n.flow_id = m.flow_id AND n.node_id = m.to_node
    WHERE m.state = 'pending' AND n.thread_id IS NOT NULL
  `.pipe(
    Effect.map((rows) => new Set(rows.map((row) => row.threadId))),
    Effect.mapError(toError("Could not read pending flow messages.")),
  );

  const hibernate = (binding: ProviderRuntimeBinding, reason: string, idleSince?: string) =>
    Effect.gen(function* () {
      if (!providerService.stopRuntimeSession) {
        return yield* new EconomyError({ message: "This server cannot stop provider sessions." });
      }
      if (binding.resumeCursor == null) {
        return yield* new EconomyError({
          message: "This agent's provider left no resume cursor, so it cannot be woken later.",
        });
      }
      const busy = providerService.hasLiveRuntimeTasks
        ? yield* providerService.hasLiveRuntimeTasks({ threadId: binding.threadId })
        : false;
      if (busy) {
        return yield* new EconomyError({ message: "The agent has background tasks running." });
      }
      // The session owner revalidates idleness under its lifecycle lock.
      yield* providerService
        .stopRuntimeSession({
          threadId: binding.threadId,
          ...(idleSince ? { onlyIfIdleSince: idleSince } : { onlyIfNoActiveTurn: true }),
        })
        .pipe(Effect.mapError(toError("Could not stop the agent's session.")));
      const after = yield* directory.getBinding(binding.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (after && after.status !== "stopped") return false;
      const at = new Date().toISOString();
      yield* sql`
        INSERT INTO economy_hibernation (thread_id, provider, reason, hibernated_at)
        VALUES (${binding.threadId}, ${binding.provider}, ${reason}, ${at})
        ON CONFLICT (thread_id) DO UPDATE SET reason = excluded.reason,
          hibernated_at = excluded.hibernated_at
      `.pipe(Effect.mapError(toError("Could not record the hibernation.")));
      hibernated.set(binding.threadId, at);
      return true;
    });

  const wake = (threadId: string) =>
    sql`DELETE FROM economy_hibernation WHERE thread_id = ${threadId}`.pipe(
      Effect.tap(() => Effect.sync(() => hibernated.delete(threadId))),
      Effect.mapError(toError("Could not wake the agent.")),
    );

  const sweep = Effect.gen(function* () {
    const value = yield* settings();
    const thresholdMs = idleThresholdMs(value, level());
    const idleSince = new Date(Date.now() - thresholdMs).toISOString();
    const pending = yield* threadsWithPendingMessages;
    for (const binding of yield* liveBindings) {
      if (!binding.lastSeenAt || binding.lastSeenAt > idleSince) continue;
      if (pending.has(binding.threadId) || binding.resumeCursor == null) continue;
      const thread = yield* snapshotQuery.getThreadShellById(binding.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (thread?.session?.activeTurnId != null) continue;
      yield* hibernate(
        binding,
        `idle over ${Math.round(thresholdMs / 60_000)} min (${level()})`,
        idleSince,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("economy skipped hibernating an agent", {
            threadId: binding.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const usage = (threadId: string) => {
    const own = processes.filter((row) => row.threadId === threadId);
    return own.length === 0
      ? { rssMb: null, cpuPct: null }
      : {
          rssMb: own.reduce((sum, row) => sum + row.rssMb, 0),
          cpuPct: Math.round(own.reduce((sum, row) => sum + row.cpuPct, 0) * 10) / 10,
        };
  };

  const status: EconomyShape["status"] = () =>
    Effect.gen(function* () {
      const value = yield* settings();
      const bindings = yield* liveBindings;
      const now = Date.now();
      const agents: EconomyAgent[] = bindings.map((binding) => ({
        threadId: binding.threadId,
        provider: binding.provider,
        state:
          binding.lastSeenAt && now - Date.parse(binding.lastSeenAt) < ACTIVE_WINDOW_MS
            ? "active"
            : "idle",
        lastSeenAt: binding.lastSeenAt ?? null,
        hibernatedAt: null,
        resumable: binding.resumeCursor != null,
        ...usage(binding.threadId),
      }));
      const rows = yield* sql<{ threadId: ThreadId; provider: string; hibernatedAt: string }>`
        SELECT thread_id AS "threadId", provider, hibernated_at AS "hibernatedAt"
        FROM economy_hibernation ORDER BY hibernated_at DESC
      `.pipe(Effect.mapError(toError("Could not read hibernated agents.")));
      for (const row of rows) {
        if (agents.some((agent) => agent.threadId === row.threadId)) continue;
        agents.push({
          threadId: row.threadId,
          provider: row.provider,
          state: "hibernated",
          lastSeenAt: null,
          hibernatedAt: row.hibernatedAt,
          resumable: true,
          rssMb: null,
          cpuPct: null,
        });
      }
      return {
        settings: value,
        latest: samples.at(-1) ?? null,
        samples: [...samples],
        seatsUsed: bindings.length,
        admission: admissionReason(level(), bindings.length, value.seatCap),
        agents,
        processes,
        hub: hubServers(
          processes,
          value.hubShared,
          (command) => sharedMcpHub.server(command)?.sessions.size ?? 0,
        ),
      } satisfies EconomyStatus;
    });

  const agent: EconomyShape["agent"] = (threadId, action) =>
    Effect.gen(function* () {
      if (action === "wake") {
        // The binding still holds the resume cursor; the next message restarts the session.
        yield* wake(threadId);
        return yield* status();
      }
      const binding = yield* directory
        .getBinding(threadId)
        .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(toError("Unknown agent.")));
      if (!binding || binding.status === "stopped") {
        return yield* new EconomyError({ message: "The agent has no live session." });
      }
      const done = yield* hibernate(binding, "hibernated by hand");
      if (!done) return yield* new EconomyError({ message: "The agent is busy; try again." });
      yield* refreshAdmission;
      return yield* status();
    });

  const update: EconomyShape["update"] = (input) =>
    Effect.gen(function* () {
      const defined = Object.fromEntries(
        Object.entries(input).filter(([, entry]) => entry !== undefined),
      ) as Partial<EconomySettingsValue>;
      const next: EconomySettingsValue = { ...(yield* settings()), ...defined };
      if (next.warnUsedPct > next.criticalUsedPct) {
        return yield* new EconomyError({ message: "The warn threshold must not exceed critical." });
      }
      yield* encodeSettings(next).pipe(
        Effect.flatMap(
          (valueJson) => sql`
            INSERT INTO economy_settings (setting_key, value_json, updated_at)
            VALUES ('settings', ${valueJson}, ${new Date().toISOString()})
            ON CONFLICT (setting_key) DO UPDATE SET value_json = excluded.value_json,
              updated_at = excluded.updated_at
          `,
        ),
        Effect.mapError(toError("Could not save the economy settings.")),
      );
      cached = next;
      sharedMcpHub.setShared(next.hubShared);
      yield* refreshAdmission;
      return yield* status();
    });

  const start: EconomyShape["start"] = () =>
    Effect.gen(function* () {
      const rows = yield* sql<{ threadId: string; hibernatedAt: string }>`
        SELECT thread_id AS "threadId", hibernated_at AS "hibernatedAt" FROM economy_hibernation
      `.pipe(Effect.orElseSucceed(() => []));
      for (const row of rows) hibernated.set(row.threadId, row.hibernatedAt);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          setFlowAdmission(null);
          sharedMcpHub.stopAll();
        }),
      );
      yield* settings().pipe(Effect.ignore);
      yield* Effect.forkScoped(
        Effect.forever(
          sample.pipe(
            Effect.andThen(sweep),
            Effect.andThen(refreshAdmission),
            Effect.catchCause((cause) =>
              Effect.logWarning("economy sample failed", { cause: Cause.pretty(cause) }),
            ),
            Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (!WAKE_EVENTS.has(event.type) || !("threadId" in event.payload)) return Effect.void;
          const threadId = event.payload.threadId as string;
          return hibernated.has(threadId) ? wake(threadId).pipe(Effect.ignore) : Effect.void;
        }),
      );
    });

  return { status, agent, update, start } satisfies EconomyShape;
});

export const EconomyLive = Layer.effect(Economy, make);
