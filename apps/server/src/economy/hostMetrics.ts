// FILE: hostMetrics.ts
// Purpose: Reads host memory, memory pressure and the RSS/CPU of every process under the Saint
//          server, plus the pure rules built on them: pressure level, idle threshold, admission,
//          the sample ring and MCP Hub grouping.
// Layer: Server economy

import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";

import type {
  EconomyLevel,
  EconomyProcess,
  EconomySample,
  EconomySettings,
  McpHubServer,
} from "@saint/contracts";

import { runProcess } from "../processRunner.ts";

const MB = 1024 * 1024;
/** One sample a minute for eight hours. */
export const SAMPLE_RING_SIZE = 8 * 60;
/** PSI `some avg10` at which memory stalls start to hurt, and at which they are severe. */
const STALL_WARN_PCT = 10;
const STALL_CRITICAL_PCT = 40;
const LINUX_CLOCK_TICKS = 100;
const LABEL_CHARS = 160;

export const DEFAULT_ECONOMY_SETTINGS: EconomySettings = {
  idleMinutes: 10,
  warnUsedPct: 85,
  criticalUsedPct: 95,
  seatCap: null,
  hubShared: [],
};

export interface RawProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  /** Cumulative CPU ticks (Linux) or an instant percentage (ps). */
  readonly cpu: number;
  readonly label: string;
}

/** `some avg10=1.23 …` from /proc/pressure/memory. */
export function parsePsi(text: string): number | null {
  const match = /^some\s+avg10=([\d.]+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `System-wide memory free percentage: 63%` from macOS `memory_pressure`. */
export function parseMacFreePct(text: string): number | null {
  const match = /free percentage:\s*(\d+)%/i.exec(text);
  return match ? Number(match[1]) : null;
}

/** One /proc/<pid>/stat line; the command name may hold spaces and parentheses. */
export function parseProcStat(text: string): Omit<RawProcess, "label"> | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const pid = Number.parseInt(text, 10);
  // Fields after the name start at field 3 (state); ppid is 4, utime 14, stime 15, rss 24.
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const field = (n: number) => Number(rest[n - 3]);
  if (!Number.isFinite(pid) || rest.length < 22) return null;
  return {
    pid,
    ppid: field(4),
    rssKb: field(24) * 4,
    cpu: field(14) + field(15),
  };
}

/** `ps -axo pid=,ppid=,rss=,pcpu=,command=` rows. */
export function parsePs(text: string): RawProcess[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            rssKb: Number(match[3]),
            cpu: Number(match[4]),
            label: match[5]!.slice(0, LABEL_CHARS),
          },
        ]
      : [];
  });
}

/** Every process below `root`, the root excluded. */
export function descendants(rows: ReadonlyArray<RawProcess>, root: number): RawProcess[] {
  const children = new Map<number, RawProcess[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const out: RawProcess[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    out.push(next);
    queue.push(...(children.get(next.pid) ?? []));
  }
  return out;
}

function readLinuxProcesses(): RawProcess[] {
  return readdirSync("/proc").flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
      if (!stat) return [];
      const label = readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .replaceAll("\0", " ")
        .trim()
        .slice(0, LABEL_CHARS);
      return [{ ...stat, label }];
    } catch {
      return []; // The process exited between listing and reading.
    }
  });
}

export interface HostReading {
  readonly totalMb: number;
  readonly usedMb: number;
  readonly stallPct: number | null;
  readonly processes: ReadonlyArray<RawProcess>;
}

/** Reads the host now. Processes are the descendants of this server. */
export async function readHost(): Promise<HostReading> {
  const totalMb = Math.round(os.totalmem() / MB);
  let usedMb = Math.round((os.totalmem() - os.freemem()) / MB);
  let stallPct: number | null = null;
  let all: RawProcess[] = [];
  if (process.platform === "linux") {
    try {
      stallPct = parsePsi(readFileSync("/proc/pressure/memory", "utf8"));
    } catch {
      stallPct = null; // Kernel without PSI.
    }
    all = readLinuxProcesses();
  } else if (process.platform === "darwin") {
    // os.freemem() leaves out reclaimable memory on macOS; memory_pressure counts it.
    const pressure = await runProcess("memory_pressure", ["-Q"], {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
    }).catch(() => null);
    const freePct = pressure ? parseMacFreePct(pressure.stdout) : null;
    if (freePct !== null) usedMb = Math.round((totalMb * (100 - freePct)) / 100);
    const ps = await runProcess("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,command="], {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
      maxBufferBytes: 8 * MB,
      outputMode: "truncate",
    }).catch(() => null);
    all = ps ? parsePs(ps.stdout) : [];
  }
  // ponytail: Windows reports host memory only; per-process rows need a WMI query.
  return { totalMb, usedMb, stallPct, processes: descendants(all, process.pid) };
}

/** CPU percent per pid: Linux ticks are cumulative, so compare with the previous reading. */
export function cpuPercents(
  current: ReadonlyArray<RawProcess>,
  previous: ReadonlyMap<number, number>,
  elapsedMs: number,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const row of current) {
    if (process.platform !== "linux") {
      out.set(row.pid, row.cpu);
      continue;
    }
    const before = previous.get(row.pid);
    const seconds = elapsedMs / 1000;
    out.set(
      row.pid,
      before === undefined || seconds <= 0
        ? 0
        : Math.round(((row.cpu - before) / LINUX_CLOCK_TICKS / seconds) * 1000) / 10,
    );
  }
  return out;
}

export function economyLevel(
  usedPct: number,
  stallPct: number | null,
  settings: EconomySettings,
): EconomyLevel {
  const stall = stallPct ?? 0;
  if (usedPct >= settings.criticalUsedPct || stall >= STALL_CRITICAL_PCT) return "critical";
  if (usedPct >= settings.warnUsedPct || stall >= STALL_WARN_PCT) return "warn";
  return "ok";
}

/** Idle time before an agent is hibernated; shorter as pressure rises. */
export function idleThresholdMs(settings: EconomySettings, level: EconomyLevel): number {
  const base = settings.idleMinutes * 60_000;
  if (level === "critical") return Math.min(base, 60_000);
  if (level === "warn") return base / 2;
  return base;
}

/** Why a new flow step must wait, or null to start it now. */
export function admissionReason(
  level: EconomyLevel,
  seatsUsed: number,
  seatCap: number | null,
): string | null {
  if (level === "critical") {
    return "Host memory is critical; new flow steps are refused until it recovers.";
  }
  if (seatCap !== null && seatsUsed >= seatCap) {
    return `All ${seatCap} agent seats are in use; this step starts when one frees up.`;
  }
  if (level === "warn") return "Host memory is under pressure; this step is queued.";
  return null;
}

export function pushSample(ring: EconomySample[], sample: EconomySample): void {
  ring.push(sample);
  if (ring.length > SAMPLE_RING_SIZE) ring.splice(0, ring.length - SAMPLE_RING_SIZE);
}

/** MCP server processes under agents, one row per command line. */
export function hubServers(
  processes: ReadonlyArray<EconomyProcess>,
  shared: ReadonlyArray<string>,
): McpHubServer[] {
  const byCommand = new Map<string, { instances: number; rssMb: number }>();
  for (const row of processes) {
    if (!/\bmcp\b|mcp-server|server-[\w-]+mcp|-mcp\b/i.test(row.label)) continue;
    const entry = byCommand.get(row.label) ?? { instances: 0, rssMb: 0 };
    byCommand.set(row.label, { instances: entry.instances + 1, rssMb: entry.rssMb + row.rssMb });
  }
  return [...byCommand]
    .map(([command, entry]) => ({ command, ...entry, shared: shared.includes(command) }))
    .toSorted((a, b) => b.rssMb - a.rssMb);
}
