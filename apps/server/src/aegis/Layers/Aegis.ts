import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  AegisAlert,
  AegisFrozenWorktree,
  AegisSettings,
  CommandId,
  ThreadId,
  type AegisLayerStatus,
  type AegisStatus,
  type PolicyV1,
} from "@saint/contracts";
import { Cause, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { FLOW_ALWAYS_PROTECTED, protectedPathPattern } from "../../flow/gateRunner.ts";
import { Ledger } from "../../ledger/Services/Ledger.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProviderChildKind } from "../../providerChildEnvironment.ts";
import { startEgressProxy, type EgressProxy } from "../egressProxy.ts";
import { freezeWorktree, killProcessTrees, unfreezeWorktree } from "../killSwitch.ts";
import {
  egressVerdict,
  evaluateCedar,
  validateCedarPolicies,
  type PolicyPrincipal,
} from "../policy.ts";
import {
  providerProcessIds,
  setProviderLaunchPlanner,
  type ProviderLaunch,
  type ProviderLaunchInput,
} from "../providerLaunch.ts";
import {
  DEFAULT_EGRESS_ALLOWLIST,
  SENSITIVE_PATH_PATTERNS,
  autonomyAtLeast,
  autonomyLocks,
  runtimeModeCap,
  scanForTripwire,
} from "../rules.ts";
import {
  SANDBOX_RELAY_SCRIPT,
  detectSandbox,
  gitCommonDir,
  prepareDecoyHome,
  prepareDecoys,
  proxyEnv,
  sandboxLauncher,
  type RelayedPort,
} from "../sandbox.ts";
import {
  Aegis,
  AegisError,
  type AegisFlowPrincipal,
  type AegisPrincipalResolver,
  type AegisShape,
} from "../Services/Aegis.ts";

const AlertJson = Schema.fromJsonString(AegisAlert);
const SettingsJson = Schema.fromJsonString(AegisSettings);
const ThreadListJson = Schema.fromJsonString(Schema.Array(ThreadId));
const FrozenListJson = Schema.fromJsonString(Schema.Array(AegisFrozenWorktree));
const decodeAlert = Schema.decodeUnknownEffect(AlertJson);
const encodeAlert = Schema.encodeEffect(AlertJson);
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);
const toError = (message: string) => (cause: unknown) =>
  cause instanceof AegisError ? cause : new AegisError({ message, cause });

export const DEFAULT_POLICY: PolicyV1 = {
  version: 1,
  cedar: "",
  egressAllowlist: [...DEFAULT_EGRESS_ALLOWLIST],
  egressDenylist: [],
  protectedZones: [],
};
export const DEFAULT_AEGIS_SETTINGS: AegisSettings = {
  autonomy: "L1",
  unattendedSignedOffBy: null,
  policy: DEFAULT_POLICY,
  unsandboxedThreads: [],
};

/** Settings saved before PolicyV1 (P8's first cut) kept the egress lists at the top level. */
export function upgradeLegacySettings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || "policy" in raw) return raw;
  const legacy = raw as Record<string, unknown>;
  return {
    autonomy: legacy.autonomy ?? "L1",
    unattendedSignedOffBy: legacy.unattendedSignedOffBy ?? null,
    policy: {
      ...DEFAULT_POLICY,
      egressAllowlist: legacy.egressAllowlist ?? DEFAULT_POLICY.egressAllowlist,
      egressDenylist: legacy.egressDenylist ?? [],
    },
    unsandboxedThreads: [],
  };
}

/** Tool output is scanned up to this size; credentials are short. */
const TRIPWIRE_SCAN_CHARS = 64_000;
/** Protected-zone expansion stops here; the gate's git check still covers the rest. */
const PROTECTED_SCAN_LIMIT = 5_000;
const PROTECTED_SCAN_SKIP = new Set([".git", "node_modules"]);

/** Provider state dirs (relative to HOME) a sandboxed session keeps writing to. */
const PROVIDER_STATE_DIRS: Record<ProviderChildKind, ReadonlyArray<string>> = {
  // ACP carries Cursor, Droid, Grok, Devin and OMP.
  acp: [".cursor", ".config/cursor", ".factory", ".grok", ".devin", ".codeium", ".omp"],
  antigravity: [".gemini", ".antigravity"],
  claude: [".claude", ".claude.json", ".config/claude"],
  codex: [".codex"],
  cursor: [".cursor", ".config/cursor"],
  devin: [".devin", ".codeium"],
  droid: [".factory"],
  grok: [".grok"],
  opencode: [
    ".config/opencode",
    ".local/share/opencode",
    ".local/state/opencode",
    ".cache/opencode",
  ],
  pi: [".pi"],
  omp: [".omp"],
};
const HOME_OVERRIDE_KEY = /(_HOME|_CONFIG_DIR|_DATA_DIR|_STATE_DIR)$/;

interface EgressSession {
  readonly key: string;
  readonly dir: string;
  readonly proxy: EgressProxy | null;
  readonly servers: Array<net.Server>;
  refs: number;
  /** Set for sessions shared by a thread's short-lived processes (Pi runs one per command). */
  reuseKey?: string;
  ports?: ReadonlyArray<RelayedPort>;
  readOnly?: { readonly files: ReadonlyArray<string>; readonly at: number };
  linger?: ReturnType<typeof setTimeout>;
}

/** A shared session outlives its last process this long, for the thread's next command. */
const SESSION_LINGER_MS = 30_000;
/** Protected files found for a shared session are reused this long. */
const READ_ONLY_SCAN_TTL_MS = 30_000;

// Relay servers keep the sockets they bridge; closing them first lets close() finish at once
// instead of waiting on a provider's keep-alive connection.
const relaySockets = new WeakMap<net.Server, Set<net.Socket>>();
const trackSockets = (server: net.Server) => {
  const sockets = new Set<net.Socket>();
  relaySockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return server;
};
const closeServer = (server: net.Server) =>
  new Promise<void>((resolve) => {
    for (const socket of relaySockets.get(server) ?? []) socket.destroy();
    server.close(() => resolve());
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
  const ledger = Option.getOrUndefined(yield* Effect.serviceOption(Ledger));
  const sandboxKind = detectSandbox();
  const home = process.env.HOME ?? config.homeDir;
  const scratchRoot = path.join(config.stateDir, "aegis");
  const sessionsRoot = path.join(scratchRoot, "s");
  const freezeRoot = path.join(scratchRoot, "freeze");
  const relayScript = path.join(scratchRoot, "sandbox-relay.mjs");
  const decoys = yield* Effect.sync(() => {
    try {
      mkdirSync(freezeRoot, { recursive: true });
      // Session dirs from a previous run hold stale sockets and decoy homes.
      rmSync(sessionsRoot, { recursive: true, force: true });
      mkdirSync(sessionsRoot, { recursive: true });
      writeFileSync(relayScript, SANDBOX_RELAY_SCRIPT);
      return prepareDecoys(path.join(scratchRoot, "decoys"));
    } catch {
      return { files: [], canaries: [] };
    }
  });
  const raiseLock = yield* Semaphore.make(1);
  const killHandlers: Array<(threadId: ThreadId) => Effect.Effect<void>> = [];
  let resolvePrincipal: AegisPrincipalResolver = () => Effect.succeed(null);
  const sessions = new Map<string, EgressSession>();
  const reusableSessions = new Map<string, EgressSession>();
  // Settings change rarely and the proxy decides on every connection, so keep them in memory.
  let cached: AegisSettings | null = null;
  let revoked: ReadonlyArray<ThreadId> = [];
  let frozen: ReadonlyArray<AegisFrozenWorktree> = [];

  const readKey = (key: string) =>
    sql<{ valueJson: string }>`
      SELECT value_json AS "valueJson" FROM aegis_settings WHERE setting_key = ${key}
    `.pipe(Effect.map((rows) => rows[0]?.valueJson ?? null));
  const writeKey = (key: string, valueJson: string) =>
    sql`
      INSERT INTO aegis_settings (setting_key, value_json, updated_at)
      VALUES (${key}, ${valueJson}, ${new Date().toISOString()})
      ON CONFLICT (setting_key) DO UPDATE SET value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid);

  const settings: AegisShape["settings"] = () =>
    cached
      ? Effect.succeed(cached)
      : readKey("settings").pipe(
          Effect.flatMap((valueJson) =>
            valueJson
              ? decodeSettings(JSON.stringify(upgradeLegacySettings(JSON.parse(valueJson))))
              : Effect.succeed(DEFAULT_AEGIS_SETTINGS),
          ),
          Effect.tap((value) => Effect.sync(() => (cached = value))),
          Effect.mapError(toError("Could not read the security settings.")),
        );

  const saveSettings = (value: AegisSettings) =>
    encodeSettings(value).pipe(
      Effect.flatMap((valueJson) => writeKey("settings", valueJson)),
      Effect.tap(() => Effect.sync(() => (cached = value))),
      Effect.mapError(toError("Could not save the security settings.")),
    );

  const saveRevoked = (next: ReadonlyArray<ThreadId>) =>
    writeKey("revoked", JSON.stringify(next)).pipe(
      Effect.tap(() => Effect.sync(() => (revoked = next))),
      Effect.mapError(toError("Could not save the revoked capabilities.")),
    );
  const saveFrozen = (next: ReadonlyArray<AegisFrozenWorktree>) =>
    writeKey("frozen", JSON.stringify(next)).pipe(
      Effect.tap(() => Effect.sync(() => (frozen = next))),
      Effect.mapError(toError("Could not save the frozen worktrees.")),
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

  // Serialized: two agents asking for one domain at once still make one alert.
  const raise: AegisShape["raise"] = (input) =>
    Effect.gen(function* () {
      // One open alert per question: a domain asked for twice is still one decision.
      const open = yield* alerts(false);
      // A new domain is one decision whichever agent asked for it.
      const same = open.find(
        (alert) =>
          alert.kind === input.kind &&
          alert.domain === (input.domain ?? null) &&
          (input.kind === "new_domain" ||
            (alert.threadId === (input.threadId ?? null) &&
              alert.nodeId === (input.nodeId ?? null))),
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
    }).pipe(raiseLock.withPermit);

  const egressOn = (value: AegisSettings) => autonomyAtLeast(value.autonomy, "L2");

  // A thread's flow step never changes; cache it briefly so a busy agent's tool calls and
  // connections do not each read the flow tables.
  const principalCache = new Map<string, { step: AegisFlowPrincipal | null; at: number }>();
  const PRINCIPAL_CACHE_MS = 30_000;
  const resolveCached = (threadId: string) => {
    const hit = principalCache.get(threadId);
    if (hit && Date.now() - hit.at < PRINCIPAL_CACHE_MS) return Effect.succeed(hit.step);
    return resolvePrincipal(threadId).pipe(
      Effect.orElseSucceed(() => null),
      Effect.tap((step) =>
        Effect.sync(() => {
          if (principalCache.size >= 2_000) principalCache.clear();
          principalCache.set(threadId, { step, at: Date.now() });
        }),
      ),
    );
  };
  const principalFor = (threadId: string) =>
    resolveCached(threadId).pipe(
      Effect.map((step): { principal: PolicyPrincipal; step: AegisFlowPrincipal | null } =>
        step
          ? {
              principal: { kind: "node", flowId: step.flowId, nodeId: step.nodeId, threadId },
              step,
            }
          : { principal: { kind: "thread", threadId }, step: null },
      ),
    );

  const flowIdOf = (principal: PolicyPrincipal) =>
    principal.kind === "node" ? (principal.flowId as AegisAlert["flowId"]) : null;

  /** Absolute protected files in a workspace this principal may not write (read-only mounts). */
  /** Async, so a large workspace never stalls the server while a sandboxed process starts. */
  const readOnlyFiles = async (value: AegisSettings, cwd: string, principal: PolicyPrincipal) => {
    const patterns = [...FLOW_ALWAYS_PROTECTED, ...value.policy.protectedZones].map(
      protectedPathPattern,
    );
    const found: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      if (found.length >= PROTECTED_SCAN_LIMIT) return;
      let entries: Array<{ name: string; isDirectory(): boolean }>;
      try {
        entries = await readdir(path.join(cwd, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!PROTECTED_SCAN_SKIP.has(entry.name)) await walk(child);
        } else if (patterns.some((pattern) => pattern.test(child))) {
          found.push(child);
        }
      }
    };
    await walk("");
    return found
      .filter(
        (file) =>
          evaluateCedar(value.policy.cedar, principal, { action: "write", path: file }).decision !==
          "permit",
      )
      .map((file) => path.join(cwd, file));
  };

  const gatewayPort = () => {
    try {
      const url = credentials?.mcpEndpointUrl;
      return url ? Number(new URL(url).port) || null : null;
    } catch {
      return null;
    }
  };

  const closeSession = (session: EgressSession) => {
    sessions.delete(session.key);
    if (session.reuseKey) reusableSessions.delete(session.reuseKey);
    void Promise.all([session.proxy?.close(), ...session.servers.map(closeServer)]).finally(() =>
      rmSync(session.dir, { recursive: true, force: true }),
    );
  };

  const releaseSession = (session: EgressSession) => {
    session.refs -= 1;
    if (session.refs > 0) return;
    if (!session.reuseKey) return closeSession(session);
    clearTimeout(session.linger);
    session.linger = setTimeout(() => {
      if (session.refs === 0) closeSession(session);
    }, SESSION_LINGER_MS);
    session.linger.unref();
  };

  /** One proxy port and one scratch dir per provider process; the port identifies the principal. */
  const openSession = async (
    threadId: string,
    principal: PolicyPrincipal,
    withProxy: boolean,
  ): Promise<EgressSession> => {
    const key = `${threadId}:${randomUUID().slice(0, 6)}`;
    const dir = path.join(sessionsRoot, randomUUID().slice(0, 8));
    mkdirSync(path.join(dir, "tmp"), { recursive: true });
    mkdirSync(path.join(dir, "r"), { recursive: true });
    const proxy = withProxy
      ? await startEgressProxy({
          decide: (host) =>
            egressVerdict((cached ?? DEFAULT_AEGIS_SETTINGS).policy, host, principal),
          onUnknown: (host) =>
            Effect.runFork(
              raise({
                kind: "new_domain",
                severity: "medium",
                title: `New domain: ${host}`,
                detail: `An agent tried to reach ${host}, which is not on the egress allowlist. It was refused.`,
                why: [
                  principal.kind === "node"
                    ? `flow step ${principal.nodeId}`
                    : `thread ${principal.threadId}`,
                  "egress proxy",
                  `host ${host} matched no allow, deny or Cedar entry`,
                  "default deny",
                ],
                domain: host,
                threadId: ThreadId.makeUnsafe(threadId),
                flowId: flowIdOf(principal),
                nodeId: principal.kind === "node" ? principal.nodeId : null,
              }).pipe(Effect.ignore),
            ),
        })
      : null;
    const session: EgressSession = { key, dir, proxy, servers: [], refs: 0 };
    sessions.set(key, session);
    return session;
  };

  /** Host ends of the bwrap socket relay. */
  const bridgePorts = async (
    session: EgressSession,
    outbound: ReadonlyArray<number>,
    inbound: ReadonlyArray<number>,
  ): Promise<RelayedPort[]> => {
    const pipe = (left: net.Socket, right: net.Socket) => {
      left.pipe(right);
      right.pipe(left);
      left.on("error", () => right.destroy());
      right.on("error", () => left.destroy());
    };
    const ports: RelayedPort[] = [];
    for (const port of outbound) {
      const socketPath = path.join(session.dir, "r", `o${port}.sock`);
      const server = trackSockets(
        net.createServer((client) => pipe(client, net.connect(port, "127.0.0.1"))),
      );
      await new Promise<void>((resolve, reject) =>
        server.once("error", reject).listen(socketPath, resolve),
      );
      session.servers.push(server);
      ports.push({ port, socketPath, direction: "out" });
    }
    for (const port of inbound) {
      const socketPath = path.join(session.dir, "r", `i${port}.sock`);
      const server = trackSockets(
        net.createServer((client) => pipe(client, net.connect(socketPath))),
      );
      await new Promise<void>((resolve, reject) =>
        server.once("error", reject).listen(port, "127.0.0.1", resolve),
      );
      session.servers.push(server);
      ports.push({ port, socketPath, direction: "in" });
    }
    return ports;
  };

  const planLaunch = async (input: ProviderLaunchInput): Promise<ProviderLaunch> => {
    const value = cached ?? DEFAULT_AEGIS_SETTINGS;
    const { principal, step } = await Effect.runPromise(principalFor(input.threadId));
    const required = egressOn(value) || step?.autopilot === true;
    const sandboxed =
      sandboxKind !== null &&
      required &&
      !value.unsandboxedThreads.includes(input.threadId as ThreadId);
    const withProxy = egressOn(value);
    if (!sandboxed && !withProxy) return { sandbox: undefined, env: {}, attach: () => undefined };
    // Processes that serve no port of their own share one session per thread, workspace and
    // provider, so a command-per-process provider does not open a proxy and relay each time.
    const reuseKey =
      (input.inboundPorts ?? []).length === 0
        ? `${input.threadId}\0${input.cwd ?? ""}\0${input.provider}\0${withProxy}`
        : null;
    const reusable = reuseKey ? reusableSessions.get(reuseKey) : undefined;
    const session = reusable ?? (await openSession(input.threadId, principal, withProxy));
    if (reuseKey && !reusable) {
      session.reuseKey = reuseKey;
      reusableSessions.set(reuseKey, session);
    }
    clearTimeout(session.linger);
    session.refs += 1;
    let attached = false;
    const attach: ProviderLaunch["attach"] = (child) => {
      attached = true;
      if (child.pid === undefined) return releaseSession(session);
      child.once("exit", () => releaseSession(session));
    };
    // A launch that never spawns must not leak its session.
    setTimeout(() => {
      if (!attached) releaseSession(session);
    }, 60_000).unref();
    const env: Record<string, string> = session.proxy ? proxyEnv(session.proxy.url) : {};
    if (!sandboxed || !sandboxKind || !input.cwd) {
      return { sandbox: undefined, env, attach };
    }
    const writable = [
      ...PROVIDER_STATE_DIRS[input.provider].map((dir) => path.join(home, dir)),
      ...Object.entries(input.env).flatMap(([key, dir]) =>
        HOME_OVERRIDE_KEY.test(key) && dir && path.isAbsolute(dir) && dir !== home ? [dir] : [],
      ),
      ...(gitCommonDir(input.cwd) ? [gitCommonDir(input.cwd)!] : []),
      ...(input.writable ?? []),
    ];
    const outbound = [session.proxy?.port, gatewayPort()].filter(
      (port): port is number => typeof port === "number",
    );
    const inbound = input.inboundPorts ?? [];
    const ports =
      session.ports ??
      (sandboxKind === "bwrap"
        ? await bridgePorts(session, outbound, inbound)
        : [
            ...outbound.map((port) => ({ port, socketPath: "", direction: "out" as const })),
            ...inbound.map((port) => ({ port, socketPath: "", direction: "in" as const })),
          ]);
    if (session.reuseKey) session.ports = ports;
    const readOnly =
      session.readOnly && Date.now() - session.readOnly.at < READ_ONLY_SCAN_TTL_MS
        ? session.readOnly.files
        : await readOnlyFiles(value, input.cwd, principal);
    if (session.reuseKey) session.readOnly = { files: readOnly, at: Date.now() };
    const decoyHome = path.join(session.dir, "home");
    if (sandboxKind === "sandbox-exec") prepareDecoyHome(home, decoyHome, decoys.files);
    const sandbox = sandboxLauncher({
      kind: sandboxKind,
      home,
      cwd: input.cwd,
      sessionDir: session.dir,
      writable,
      readOnly,
      decoys: decoys.files,
      ports,
      relay: { command: process.execPath, args: [relayScript] },
    });
    return {
      sandbox,
      env: {
        ...env,
        TMPDIR: path.join(session.dir, "tmp"),
        ...(sandboxKind === "sandbox-exec" ? { HOME: decoyHome } : {}),
      },
      attach,
    };
  };

  const status: AegisShape["status"] = () =>
    Effect.gen(function* () {
      const value = yield* settings();
      const tripwires = decoys.canaries.length + SENSITIVE_PATH_PATTERNS.length;
      const locks = autonomyLocks({
        sandboxAvailable: sandboxKind !== null,
        tripwires,
        signedOff: value.unattendedSignedOffBy !== null,
      });
      const cedarErrors = validateCedarPolicies(value.policy.cedar);
      const layers: AegisLayerStatus[] = [
        {
          id: "sandbox",
          enabled: sandboxKind !== null && egressOn(value),
          available: sandboxKind !== null,
          detail: sandboxKind
            ? `${sandboxKind} wraps provider processes and gates from L2 and on autopilot steps; ${value.unsandboxedThreads.length} threads run without it.`
            : "No OS sandbox on this host; L2+ and auto-approve stay locked.",
        },
        {
          id: "egress",
          enabled: egressOn(value),
          available: true,
          detail: egressOn(value)
            ? `${sessions.size} sessions, one proxy port each; ${value.policy.egressAllowlist.length} allowed hosts.`
            : "Off below L2.",
        },
        {
          id: "policy",
          enabled: value.policy.cedar.trim() !== "" && cedarErrors.length === 0,
          available: true,
          detail:
            cedarErrors.length > 0
              ? `Cedar policy does not parse: ${cedarErrors[0]}`
              : `Cedar on gateway tools, egress and ${value.policy.protectedZones.length} protected zones.`,
        },
        {
          id: "tripwire",
          enabled: tripwires > 0,
          available: true,
          detail: `${decoys.canaries.length} canary values in the decoy HOME, ${SENSITIVE_PATH_PATTERNS.length} credential paths watched.`,
        },
        {
          id: "ledger",
          enabled: ledger !== undefined,
          available: true,
          detail: "Hash-chained, signed ledger; kills are recorded.",
        },
        {
          id: "capabilities",
          enabled: credentials?.setCapabilityCeiling !== undefined,
          available: true,
          detail: `Child agents never get more capabilities than their parent; ${revoked.length} threads revoked.`,
        },
      ];
      const openAlerts = (yield* alerts(false)).length;
      return {
        settings: value,
        layers,
        locked: locks as Record<string, string>,
        openAlerts,
        egressSessions: [...sessions.values()].filter((session) => session.proxy).length,
        revokedThreads: [...revoked],
        frozen: [...frozen],
      } satisfies AegisStatus;
    });

  const update: AegisShape["update"] = (input, by) =>
    Effect.gen(function* () {
      const current = yield* settings();
      const patch = Object.fromEntries(
        Object.entries(input.policy ?? {}).filter(([, value]) => value !== undefined),
      ) as Partial<PolicyV1>;
      const policy: PolicyV1 = { ...current.policy, ...patch, version: 1 };
      const cedarErrors = validateCedarPolicies(policy.cedar);
      if (cedarErrors.length > 0) {
        return yield* new AegisError({
          message: `The Cedar policy does not parse: ${cedarErrors.join("; ")}`,
        });
      }
      const exemption = input.runWithoutSandbox;
      const next: AegisSettings = {
        ...current,
        policy,
        ...(exemption
          ? {
              unsandboxedThreads: exemption.enabled
                ? [...new Set([...current.unsandboxedThreads, exemption.threadId])]
                : current.unsandboxedThreads.filter((id) => id !== exemption.threadId),
            }
          : {}),
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
      if (exemption?.enabled) {
        yield* raise({
          kind: "capability_denied",
          severity: "high",
          title: "Thread runs without the sandbox",
          detail: `${by} chose "Run without sandbox" for this thread. Its next provider session can read and write anything the user can.`,
          why: ["Run without sandbox", `chosen by ${by}`],
          threadId: exemption.threadId,
          decidable: false,
        }).pipe(Effect.ignore);
      }
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
        yield* saveSettings({
          ...current,
          policy: {
            ...current.policy,
            [key]: [...new Set([...current.policy[key], ...domains])],
          },
        });
      }
      const state = decision === "allow" ? "allowed" : decision === "deny" ? "denied" : "noted";
      return yield* Effect.forEach(chosen, (alert) =>
        saveAlert({ ...alert, state, decidedBy: by, updatedAt: new Date().toISOString() }),
      );
    });

  const capRuntimeMode: AegisShape["capRuntimeMode"] = (requested) =>
    settings().pipe(Effect.map((value) => runtimeModeCap(value.autonomy, requested)));

  const gateSandbox: AegisShape["gateSandbox"] = ({ cwd, command, threadId }) =>
    Effect.gen(function* () {
      const value = yield* settings();
      const resolved = threadId ? yield* principalFor(threadId) : null;
      const required = egressOn(value) || resolved?.step?.autopilot === true;
      if (!sandboxKind || !required) return null;
      const launch = yield* Effect.promise(() =>
        planLaunch({ threadId: threadId ?? `gate-${randomUUID()}`, provider: "acp", cwd, env: {} }),
      );
      if (!launch.sandbox) return null;
      return {
        file: launch.sandbox.command,
        args: [...launch.sandbox.args, "/bin/sh", "-c", command],
        env: { ...launch.env },
        attach: launch.attach,
      };
    });

  const authorizeTool: AegisShape["authorizeTool"] = ({ threadId, tool }) =>
    Effect.gen(function* () {
      const value = yield* settings().pipe(Effect.orElseSucceed(() => DEFAULT_AEGIS_SETTINGS));
      if (value.policy.cedar.trim() === "") return { allowed: true, reason: "" };
      const { principal } = yield* principalFor(threadId);
      const decided = evaluateCedar(value.policy.cedar, principal, { action: "tool", tool });
      if (decided.decision !== "forbid") return { allowed: true, reason: "" };
      const reason = `Cedar policy ${decided.policies.join(", ") || "(unparseable)"} forbids ${tool}.`;
      yield* raise({
        kind: "capability_denied",
        severity: "medium",
        title: `Tool refused: ${tool}`,
        detail: reason,
        why: [
          principal.kind === "node" ? `flow step ${principal.nodeId}` : `thread ${threadId}`,
          `gateway tool ${tool}`,
          ...decided.policies.map((id) => `forbid ${id}`),
        ],
        threadId: ThreadId.makeUnsafe(threadId),
        flowId: flowIdOf(principal),
        nodeId: principal.kind === "node" ? principal.nodeId : null,
        decidable: false,
      }).pipe(Effect.ignore);
      return { allowed: false, reason };
    });

  const unpermittedWrites: AegisShape["unpermittedWrites"] = ({ threadId, paths }) =>
    Effect.gen(function* () {
      const value = yield* settings().pipe(Effect.orElseSucceed(() => DEFAULT_AEGIS_SETTINGS));
      const { principal } = yield* principalFor(threadId);
      return paths.filter(
        (file) =>
          evaluateCedar(value.policy.cedar, principal, { action: "write", path: file }).decision !==
          "permit",
      );
    });

  const kill: AegisShape["kill"] = (input) =>
    Effect.gen(function* () {
      const startedAt = performance.now();
      const now = new Date().toISOString();
      // Capabilities first: a process still alive for a few hundred ms can no longer act.
      if (input.revoke !== false) {
        for (const threadId of input.threadIds) credentials?.setCapabilityCeiling?.(threadId, []);
        yield* saveRevoked([...new Set([...revoked, ...input.threadIds])]);
      }
      const pids = input.threadIds.flatMap((threadId) => providerProcessIds(threadId));
      const [trees] = yield* Effect.all(
        [
          Effect.promise(() => killProcessTrees(pids)),
          Effect.forEach(
            input.threadIds,
            (threadId) =>
              orchestrationEngine
                .dispatch({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.makeUnsafe(`aegis:kill:${threadId}:${Date.now()}`),
                  threadId,
                  requestedBy: "system",
                  createdAt: now,
                })
                .pipe(Effect.ignore),
            { discard: true, concurrency: "unbounded" },
          ),
        ],
        { concurrency: "unbounded" },
      );
      const stopMs = performance.now() - startedAt;
      const frozenNow: AegisFrozenWorktree[] = [];
      for (const worktree of new Set(input.worktrees ?? [])) {
        if (!existsSync(worktree) || frozen.some((entry) => entry.path === worktree)) continue;
        const id = `fz-${randomUUID().slice(0, 8)}`;
        const result = yield* Effect.tryPromise(() =>
          freezeWorktree(worktree, path.join(freezeRoot, `${id}.json`)),
        ).pipe(Effect.orElseSucceed(() => null));
        if (!result) continue;
        frozenNow.push({
          id,
          path: worktree,
          threadId: input.threadIds[0] ?? null,
          flowId: input.flowId ?? null,
          files: result.files,
          frozenAt: now,
        });
      }
      if (frozenNow.length > 0) yield* saveFrozen([...frozen, ...frozenNow]);
      yield* Effect.forEach(
        input.threadIds,
        (threadId) =>
          Effect.forEach(killHandlers, (handler) => handler(threadId), { discard: true }),
        { discard: true },
      );
      const totalMs = performance.now() - startedAt;
      const report = {
        threads: input.threadIds.length,
        processes: pids.length,
        forced: trees.forced,
        frozen: frozenNow.map((entry) => entry.path),
        stopMs: Math.round(stopMs),
        totalMs: Math.round(totalMs),
      };
      if (ledger) {
        yield* ledger
          .append({
            kind: "aegis.kill",
            actor: input.by,
            flowId: input.flowId ?? null,
            payload: {
              reason: input.reason,
              threadIds: input.threadIds,
              survivors: trees.survivors,
              ...report,
            },
          })
          .pipe(Effect.ignore);
      }
      return report;
    });

  const unfreeze: AegisShape["unfreeze"] = (id, by) =>
    Effect.gen(function* () {
      const entry = frozen.find((candidate) => candidate.id === id);
      if (!entry) return yield* new AegisError({ message: "That worktree is not frozen." });
      yield* Effect.tryPromise(() => unfreezeWorktree(path.join(freezeRoot, `${id}.json`))).pipe(
        Effect.mapError(toError(`Could not unfreeze ${entry.path}.`)),
      );
      yield* saveFrozen(frozen.filter((candidate) => candidate.id !== id));
      if (ledger) {
        yield* ledger
          .append({
            kind: "aegis.unfreeze",
            actor: by,
            flowId: entry.flowId,
            payload: { path: entry.path, files: entry.files },
          })
          .pipe(Effect.ignore);
      }
      return yield* status();
    });

  const trip = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      // A killed thread can still emit the activity of its last tool call; it trips once.
      if (revoked.includes(threadId)) return;
      const hit = scanForTripwire(text.slice(0, TRIPWIRE_SCAN_CHARS), decoys.canaries);
      if (!hit) return;
      const { step } = yield* principalFor(threadId);
      const report = yield* kill({
        threadIds: [threadId],
        flowId: (step?.flowId ?? null) as AegisAlert["flowId"],
        reason: `tripwire: ${hit.kind}`,
        by: "aegis:tripwire",
        worktrees: step?.worktree ? [step.worktree] : [],
      }).pipe(Effect.orElseSucceed(() => null));
      yield* raise({
        kind: "tripwire",
        severity: "critical",
        title: hit.kind === "canary" ? "Decoy credential used" : "Credential path touched",
        detail: `An agent touched ${hit.match}. ${report ? `Its processes were killed in ${report.stopMs} ms, its Saint tools revoked, ${report.frozen.length > 0 || frozen.some((entry) => entry.path === step?.worktree) ? "its worktree frozen read-only" : "its folder left writable (not a Saint worktree)"}, and its flow cancelled.` : "The kill switch failed; stop the agent by hand."}`,
        why: [
          `thread ${threadId}`,
          hit.kind === "canary"
            ? "a planted canary value appeared in tool activity"
            : `tool activity named ${hit.match}`,
          "tripwire → kill",
        ],
        threadId,
        flowId: (step?.flowId ?? null) as AegisAlert["flowId"],
        nodeId: step?.nodeId ?? null,
        decidable: false,
      }).pipe(Effect.ignore);
    });

  const start: AegisShape["start"] = () =>
    Effect.gen(function* () {
      const value = yield* settings().pipe(Effect.orElseSucceed(() => DEFAULT_AEGIS_SETTINGS));
      revoked = yield* readKey("revoked").pipe(
        Effect.flatMap((json) =>
          json ? Schema.decodeUnknownEffect(ThreadListJson)(json) : Effect.succeed([]),
        ),
        Effect.orElseSucceed(() => []),
      );
      frozen = yield* readKey("frozen").pipe(
        Effect.flatMap((json) =>
          json ? Schema.decodeUnknownEffect(FrozenListJson)(json) : Effect.succeed([]),
        ),
        Effect.orElseSucceed(() => []),
      );
      // A kill outlives a restart: revoked threads get no Saint tools back.
      for (const threadId of revoked) credentials?.setCapabilityCeiling?.(threadId, []);
      cached = value;
      setProviderLaunchPlanner(planLaunch);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          setProviderLaunchPlanner(null);
          await Promise.all(
            [...sessions.values()].flatMap((session) => [
              session.proxy?.close(),
              ...session.servers.map(closeServer),
            ]),
          );
          sessions.clear();
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
    authorizeTool,
    unpermittedWrites,
    kill,
    unfreeze,
    onKill: (handler) => {
      killHandlers.push(handler);
    },
    setPrincipalResolver: (resolver) => {
      resolvePrincipal = resolver;
    },
    start,
  } satisfies AegisShape;
});

export const AegisLive = Layer.effect(Aegis, make);
