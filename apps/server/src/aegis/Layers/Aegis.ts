import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  AegisAlert,
  AegisSettings,
  CommandId,
  type AegisLayerStatus,
  type AegisStatus,
  type ThreadId,
} from "@saint/contracts";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { setProviderEgressProxyEnvironment } from "../../providerChildEnvironment.ts";
import { startEgressProxy, type EgressProxy } from "../egressProxy.ts";
import {
  DEFAULT_EGRESS_ALLOWLIST,
  SENSITIVE_PATH_PATTERNS,
  autonomyAtLeast,
  autonomyLocks,
  egressVerdict,
  runtimeModeCap,
  scanForTripwire,
} from "../rules.ts";
import { detectSandbox, prepareDecoys, proxyEnv, sandboxArgv } from "../sandbox.ts";
import { Aegis, AegisError, type AegisShape } from "../Services/Aegis.ts";

const AlertJson = Schema.fromJsonString(AegisAlert);
const SettingsJson = Schema.fromJsonString(AegisSettings);
const decodeAlert = Schema.decodeUnknownEffect(AlertJson);
const encodeAlert = Schema.encodeEffect(AlertJson);
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const toError = (message: string) => (cause: unknown) =>
  cause instanceof AegisError ? cause : new AegisError({ message, cause });

export const DEFAULT_AEGIS_SETTINGS: AegisSettings = {
  autonomy: "L1",
  unattendedSignedOffBy: null,
  egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
  egressDenylist: [],
  rules: [],
};
/** Tool output is scanned up to this size; credentials are short. */
const TRIPWIRE_SCAN_CHARS = 64_000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
  const sandboxKind = detectSandbox();
  const scratchRoot = path.join(config.stateDir, "aegis");
  const decoys = yield* Effect.sync(() => {
    try {
      return prepareDecoys(path.join(scratchRoot, "decoys"));
    } catch {
      return { files: [], canaries: [] };
    }
  });
  const killHandlers: Array<(threadId: ThreadId) => Effect.Effect<void>> = [];
  let proxy: EgressProxy | null = null;
  // Settings change rarely and the proxy decides on every connection, so keep them in memory.
  let cached: AegisSettings | null = null;

  const settings: AegisShape["settings"] = () =>
    cached
      ? Effect.succeed(cached)
      : sql<{ valueJson: string }>`
          SELECT value_json AS "valueJson" FROM aegis_settings WHERE setting_key = 'settings'
        `.pipe(
          Effect.flatMap((rows) =>
            rows[0] ? decodeSettings(rows[0].valueJson) : Effect.succeed(DEFAULT_AEGIS_SETTINGS),
          ),
          Effect.tap((value) => Effect.sync(() => (cached = value))),
          Effect.mapError(toError("Could not read the security settings.")),
        );

  const saveSettings = (value: AegisSettings) =>
    encodeSettings(value).pipe(
      Effect.flatMap(
        (valueJson) => sql`
          INSERT INTO aegis_settings (setting_key, value_json, updated_at)
          VALUES ('settings', ${valueJson}, ${new Date().toISOString()})
          ON CONFLICT (setting_key) DO UPDATE SET value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `,
      ),
      Effect.tap(() => Effect.sync(() => (cached = value))),
      Effect.mapError(toError("Could not save the security settings.")),
    );

  const saveAlert = (alert: AegisAlert) =>
    encodeAlert(alert).pipe(
      Effect.flatMap(
        (recordJson) => sql`
          INSERT INTO aegis_alerts (alert_id, kind, state, created_at, record_json)
          VALUES (${alert.id}, ${alert.kind}, ${alert.state}, ${alert.createdAt}, ${recordJson})
          ON CONFLICT (alert_id) DO UPDATE SET state = excluded.state, record_json = excluded.record_json
        `,
      ),
      Effect.as(alert),
      Effect.mapError(toError("Could not save the alert.")),
    );

  const alerts: AegisShape["alerts"] = (includeResolved) =>
    sql<{ recordJson: string }>`
      SELECT record_json AS "recordJson" FROM aegis_alerts
      ORDER BY created_at DESC LIMIT 500
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeAlert(row.recordJson))),
      Effect.map((all) => (includeResolved ? all : all.filter((alert) => alert.state === "open"))),
      Effect.mapError(toError("Could not read the alerts.")),
    );

  const raise: AegisShape["raise"] = (input) =>
    Effect.gen(function* () {
      // One open alert per question: a domain asked for twice is still one decision.
      const open = yield* alerts(false);
      const same = open.find(
        (alert) =>
          alert.kind === input.kind &&
          alert.domain === (input.domain ?? null) &&
          alert.threadId === (input.threadId ?? null) &&
          alert.nodeId === (input.nodeId ?? null),
      );
      if (same) return same;
      const now = new Date().toISOString();
      return yield* saveAlert({
        id: `al-${randomUUID().slice(0, 8)}`,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        detail: input.detail,
        why: [...input.why],
        flowId: input.flowId ?? null,
        nodeId: input.nodeId ?? null,
        threadId: input.threadId ?? null,
        domain: input.domain ?? null,
        state: input.decidable === false ? "noted" : "open",
        decidedBy: null,
        createdAt: now,
        updatedAt: now,
      });
    });

  const egressOn = (value: AegisSettings) => autonomyAtLeast(value.autonomy, "L2");

  const syncProxy = (value: AegisSettings) =>
    Effect.promise(async () => {
      if (egressOn(value) && !proxy) {
        proxy = await startEgressProxy({
          decide: (host) => egressVerdict(cached ?? value, host),
          onUnknown: (host) =>
            Effect.runFork(
              raise({
                kind: "new_domain",
                severity: "medium",
                title: `New domain: ${host}`,
                detail: `An agent tried to reach ${host}, which is not on the egress allowlist. It was refused.`,
                why: [
                  "egress proxy",
                  `host ${host} matched no allow or deny entry`,
                  "default deny",
                ],
                domain: host,
              }).pipe(Effect.ignore),
            ),
        }).catch(() => null);
        setProviderEgressProxyEnvironment(proxy ? proxyEnv(proxy.url) : null);
      } else if (!egressOn(value) && proxy) {
        setProviderEgressProxyEnvironment(null);
        await proxy.close();
        proxy = null;
      }
    });

  const status: AegisShape["status"] = () =>
    Effect.gen(function* () {
      const value = yield* settings();
      const tripwires = decoys.canaries.length + SENSITIVE_PATH_PATTERNS.length;
      const locks = autonomyLocks({
        sandboxAvailable: sandboxKind !== null,
        tripwires,
        signedOff: value.unattendedSignedOffBy !== null,
      });
      const layers: AegisLayerStatus[] = [
        {
          id: "sandbox",
          enabled: egressOn(value) && sandboxKind !== null,
          available: sandboxKind !== null,
          detail: sandboxKind
            ? `${sandboxKind} wraps flow gate commands from L2.`
            : "No OS sandbox on this host.",
        },
        {
          id: "egress",
          enabled: proxy !== null,
          available: true,
          detail: proxy
            ? `Proxy ${proxy.url}; ${value.egressAllowlist.length} allowed hosts.`
            : "Off below L2.",
        },
        {
          id: "policy",
          enabled: value.rules.length > 0,
          available: true,
          detail: `${value.rules.length} permit/forbid rules.`,
        },
        {
          id: "tripwire",
          enabled: tripwires > 0,
          available: true,
          detail: `${decoys.canaries.length} canary values, ${SENSITIVE_PATH_PATTERNS.length} credential paths watched on flow steps.`,
        },
        {
          id: "ledger",
          enabled: true,
          available: true,
          detail: "Hash-chained, signed flow ledger.",
        },
        {
          id: "capabilities",
          enabled: credentials?.setCapabilityCeiling !== undefined,
          available: true,
          detail: "Child agents never get more capabilities than their parent.",
        },
      ];
      const openAlerts = (yield* alerts(false)).length;
      return {
        settings: value,
        layers,
        locked: locks as Record<string, string>,
        openAlerts,
        egressProxyUrl: proxy?.url ?? null,
      } satisfies AegisStatus;
    });

  const update: AegisShape["update"] = (input, by) =>
    Effect.gen(function* () {
      const current = yield* settings();
      const next: AegisSettings = {
        ...current,
        ...(input.egressAllowlist ? { egressAllowlist: input.egressAllowlist } : {}),
        ...(input.egressDenylist ? { egressDenylist: input.egressDenylist } : {}),
        ...(input.rules ? { rules: input.rules } : {}),
        ...(input.signOffUnattended !== undefined
          ? { unattendedSignedOffBy: input.signOffUnattended ? by : null }
          : {}),
      };
      if (input.autonomy) {
        const locks = autonomyLocks({
          sandboxAvailable: sandboxKind !== null,
          tripwires: decoys.canaries.length + SENSITIVE_PATH_PATTERNS.length,
          signedOff: next.unattendedSignedOffBy !== null,
        });
        const lock = locks[input.autonomy];
        if (lock) return yield* new AegisError({ message: lock });
      }
      const saved = { ...next, ...(input.autonomy ? { autonomy: input.autonomy } : {}) };
      yield* saveSettings(saved);
      yield* syncProxy(saved);
      return yield* status();
    });

  const resolve: AegisShape["resolve"] = (ids, decision, by) =>
    Effect.gen(function* () {
      const all = yield* alerts(true);
      const chosen = all.filter((alert) => ids.includes(alert.id));
      const domains = chosen.flatMap((alert) =>
        alert.kind === "new_domain" && alert.domain ? [alert.domain] : [],
      );
      if (domains.length > 0 && decision !== "note") {
        const current = yield* settings();
        const key = decision === "allow" ? "egressAllowlist" : "egressDenylist";
        yield* saveSettings({ ...current, [key]: [...new Set([...current[key], ...domains])] });
      }
      const state = decision === "allow" ? "allowed" : decision === "deny" ? "denied" : "noted";
      return yield* Effect.forEach(chosen, (alert) =>
        saveAlert({ ...alert, state, decidedBy: by, updatedAt: new Date().toISOString() }),
      );
    });

  const capRuntimeMode: AegisShape["capRuntimeMode"] = (requested) =>
    settings().pipe(Effect.map((value) => runtimeModeCap(value.autonomy, requested)));

  const gateSandbox: AegisShape["gateSandbox"] = ({ cwd, command }) =>
    Effect.gen(function* () {
      const value = yield* settings();
      if (!sandboxKind || !autonomyAtLeast(value.autonomy, "L2")) return null;
      const scratch = path.join(scratchRoot, "scratch");
      yield* Effect.sync(() => mkdirSync(scratch, { recursive: true }));
      const proxyPort = proxy?.port ?? null;
      const { file, args } = sandboxArgv({
        kind: sandboxKind,
        cwd,
        home: process.env.HOME ?? cwd,
        scratch,
        decoys: decoys.files,
        command,
        proxyPort,
      });
      return {
        file,
        args,
        env: proxyPort === null ? {} : proxyEnv(`http://127.0.0.1:${proxyPort}`),
      };
    });

  const trip = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      const hit = scanForTripwire(text.slice(0, TRIPWIRE_SCAN_CHARS), decoys.canaries);
      if (!hit) return;
      credentials?.setCapabilityCeiling?.(threadId, []);
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(`aegis:tripwire:${threadId}:${Date.now()}`),
          threadId,
          requestedBy: "system",
          createdAt: new Date().toISOString(),
        })
        .pipe(Effect.ignore);
      yield* Effect.forEach(killHandlers, (handler) => handler(threadId), { discard: true });
      yield* raise({
        kind: "tripwire",
        severity: "critical",
        title: hit.kind === "canary" ? "Decoy credential used" : "Credential path touched",
        detail: `An agent touched ${hit.match}. Its turn was stopped, its Saint tools revoked, and its flow cancelled.`,
        why: [
          `thread ${threadId}`,
          hit.kind === "canary"
            ? "a planted canary value appeared in tool activity"
            : `tool activity named ${hit.match}`,
          "tripwire → kill",
        ],
        threadId,
        decidable: false,
      }).pipe(Effect.ignore);
    });

  const start: AegisShape["start"] = () =>
    Effect.gen(function* () {
      const value = yield* settings().pipe(Effect.orElseSucceed(() => DEFAULT_AEGIS_SETTINGS));
      yield* syncProxy(value);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          setProviderEgressProxyEnvironment(null);
          await proxy?.close();
          proxy = null;
        }),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.activity-appended") return Effect.void;
          const { threadId, activity } = event.payload;
          // Flow steps run unattended; from L3 every thread does.
          const watched =
            threadId.startsWith("flow-") || autonomyAtLeast((cached ?? value).autonomy, "L3");
          if (!watched || activity.kind === "context-window.updated") return Effect.void;
          return trip(threadId, JSON.stringify(activity.payload ?? null)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("aegis tripwire check failed", { cause: Cause.pretty(cause) }),
            ),
          );
        }),
      );
    });

  return {
    status,
    settings,
    update,
    alerts,
    raise,
    resolve,
    capRuntimeMode,
    gateSandbox,
    onKill: (handler) => {
      killHandlers.push(handler);
    },
    start,
  } satisfies AegisShape;
});

export const AegisLive = Layer.effect(Aegis, make);
