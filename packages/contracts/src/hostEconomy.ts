// FILE: hostEconomy.ts
// Purpose: Host economy contracts — memory samples, agent processes, hibernated agents,
//          admission control thresholds, and the opt-in MCP Hub.
// Layer: Shared contracts (server, web)

import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/** ok: admit · warn: hibernate early and queue new flow steps · critical: refuse new steps. */
export const EconomyLevel = Schema.Literals(["ok", "warn", "critical"]);
export type EconomyLevel = typeof EconomyLevel.Type;

export const EconomySample = Schema.Struct({
  at: IsoDateTime,
  totalMb: NonNegativeInt,
  usedMb: NonNegativeInt,
  /** Linux PSI `some avg10` (percent of time stalled on memory); null where the host has none. */
  stallPct: Schema.NullOr(Schema.Number),
  /** RSS of every process under the Saint server, agents included. */
  agentRssMb: NonNegativeInt,
  level: EconomyLevel,
});
export type EconomySample = typeof EconomySample.Type;

export const EconomyProcess = Schema.Struct({
  pid: NonNegativeInt,
  /** The thread whose provider process this is, or runs under; null for shared ones. */
  threadId: Schema.NullOr(ThreadId),
  label: Schema.String,
  rssMb: NonNegativeInt,
  cpuPct: Schema.Number,
});
export type EconomyProcess = typeof EconomyProcess.Type;

export const EconomyAgentState = Schema.Literals(["active", "idle", "hibernated"]);
export type EconomyAgentState = typeof EconomyAgentState.Type;

export const EconomyAgent = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.String,
  state: EconomyAgentState,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  hibernatedAt: Schema.NullOr(IsoDateTime),
  /** False when the provider left no resume cursor, so the agent is never hibernated. */
  resumable: Schema.Boolean,
  /** Its own process tree; null when the provider shares one process across threads. */
  rssMb: Schema.NullOr(NonNegativeInt),
  cpuPct: Schema.NullOr(Schema.Number),
});
export type EconomyAgent = typeof EconomyAgent.Type;

export const McpHubServer = Schema.Struct({
  /** The server's command line, the key it is matched and opted in by. */
  command: TrimmedNonEmptyString,
  /** The MCP server name agents see for the shared copy (`<name>_hub`). */
  name: TrimmedNonEmptyString,
  instances: NonNegativeInt,
  rssMb: NonNegativeInt,
  shared: Schema.Boolean,
  /** Agent sessions connected to the shared copy. */
  sessions: NonNegativeInt,
});
export type McpHubServer = typeof McpHubServer.Type;

export const EconomySettings = Schema.Struct({
  idleMinutes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  warnUsedPct: Schema.Number,
  criticalUsedPct: Schema.Number,
  /** Live agent sessions allowed at once; null for no cap. */
  seatCap: Schema.NullOr(NonNegativeInt),
  /** MCP Hub opt-in: commands of the servers to share. */
  hubShared: Schema.Array(TrimmedNonEmptyString),
});
export type EconomySettings = typeof EconomySettings.Type;

export const EconomyStatus = Schema.Struct({
  settings: EconomySettings,
  latest: Schema.NullOr(EconomySample),
  /** Ring buffer, oldest first: one sample a minute for eight hours. */
  samples: Schema.Array(EconomySample),
  seatsUsed: NonNegativeInt,
  /** Null when a new flow step would start now. */
  admission: Schema.NullOr(Schema.String),
  agents: Schema.Array(EconomyAgent),
  processes: Schema.Array(EconomyProcess),
  hub: Schema.Array(McpHubServer),
});
export type EconomyStatus = typeof EconomyStatus.Type;

export const EconomyStatusInput = Schema.Struct({});
export const EconomyAgentInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["hibernate", "wake"]),
});
export const EconomyUpdateInput = Schema.Struct({
  idleMinutes: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(1))),
  warnUsedPct: Schema.optional(Schema.Number),
  criticalUsedPct: Schema.optional(Schema.Number),
  seatCap: Schema.optional(Schema.NullOr(NonNegativeInt)),
  hubShared: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
