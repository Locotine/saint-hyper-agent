import type { EconomySample } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ECONOMY_SETTINGS,
  SAMPLE_RING_SIZE,
  admissionReason,
  admissionRefuses,
  attributeOwners,
  descendants,
  economyLevel,
  hubServers,
  idleThresholdMs,
  parseMacFreePct,
  parseProcStat,
  parsePs,
  parsePsi,
  parseWindowsProcesses,
  pushSample,
  readHost,
} from "./hostMetrics.ts";

describe("host readings", () => {
  it("parses Linux PSI and macOS memory_pressure", () => {
    expect(parsePsi("some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=0.00")).toBe(12.5);
    expect(parsePsi("")).toBeNull();
    expect(parseMacFreePct("System-wide memory free percentage: 37%")).toBe(37);
    expect(parseMacFreePct("nothing")).toBeNull();
  });

  it("parses /proc stat with spaces and parentheses in the name", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
    fields[0] = "S"; // field 3, state
    const stat = parseProcStat(`42 (node (worker) x) ${fields.join(" ")}`);
    expect(stat).toEqual({ pid: 42, ppid: 4, rssKb: 24 * 4, cpu: 14 + 15 });
  });

  it("parses ps rows and walks the tree below a root", () => {
    const rows = parsePs(
      "  10     1  2048  1.5 saint-server\n  11    10  4096  0.0 claude --x\n  12    11  1024 2.0 npx mcp-server-git\n  13     1   512 0.0 other\n",
    );
    expect(rows.map((row) => row.pid)).toEqual([10, 11, 12, 13]);
    expect(descendants(rows, 10).map((row) => row.pid)).toEqual([11, 12]);
  });

  it("parses Win32_Process rows", () => {
    const encoded = Buffer.from('node "C:\\x y\\mcp.js"').toString("base64");
    expect(parseWindowsProcesses(`40\t4\t2097152\t5000000\t${encoded}\r\nbad row`)).toEqual([
      { pid: 40, ppid: 4, rssKb: 2048, cpu: 50, label: 'node "C:\\x y\\mcp.js"' },
    ]);
  });

  it("reads this host", async () => {
    const reading = await readHost();
    expect(reading.totalMb).toBeGreaterThan(0);
    expect(reading.usedMb).toBeLessThanOrEqual(reading.totalMb);
  });
});

describe("economy rules", () => {
  const settings = DEFAULT_ECONOMY_SETTINGS;

  it("levels by used memory and by stalls", () => {
    expect(economyLevel(50, null, settings)).toBe("ok");
    expect(economyLevel(86, null, settings)).toBe("warn");
    expect(economyLevel(50, 12, settings)).toBe("warn");
    expect(economyLevel(96, 0, settings)).toBe("critical");
    expect(economyLevel(10, 45, settings)).toBe("critical");
  });

  it("hibernates sooner as pressure rises", () => {
    expect(idleThresholdMs(settings, "ok")).toBe(10 * 60_000);
    expect(idleThresholdMs(settings, "warn")).toBe(5 * 60_000);
    expect(idleThresholdMs(settings, "critical")).toBe(60_000);
  });

  it("admits, queues and refuses", () => {
    expect(admissionReason("ok", 3, null)).toBeNull();
    expect(admissionReason("ok", 3, 3)).toMatch(/seats/);
    expect(admissionReason("warn", 0, null)).toMatch(/queued/);
    expect(admissionReason("critical", 0, null)).toMatch(/refused/);
  });

  it("refuses only on critical memory or full seats", () => {
    expect(admissionRefuses("warn", 0, null)).toBe(false);
    expect(admissionRefuses("critical", 0, null)).toBe(true);
    expect(admissionRefuses("ok", 2, 2)).toBe(true);
  });

  it("attributes child processes to the thread of their owned ancestor", () => {
    const rows = parsePs(
      "  11    10  4096  0.0 claude\n  12    11  1024 0.0 npx mcp-server-git\n  13    10   512 0.0 codex app-server\n",
    );
    const owners = attributeOwners(rows, new Map([[11, "thread-a"]]));
    expect([...owners]).toEqual([
      [11, "thread-a"],
      [12, "thread-a"],
    ]);
  });

  it("keeps eight hours of samples", () => {
    const ring: EconomySample[] = [];
    for (let index = 0; index < SAMPLE_RING_SIZE + 5; index += 1) {
      pushSample(ring, {
        at: new Date(index * 60_000).toISOString(),
        totalMb: 100,
        usedMb: index % 100,
        stallPct: null,
        agentRssMb: 0,
        level: "ok",
      });
    }
    expect(ring).toHaveLength(SAMPLE_RING_SIZE);
    expect(ring[0]!.at).toBe(new Date(5 * 60_000).toISOString());
  });

  it("groups MCP servers across agents and marks the shared ones", () => {
    const hub = hubServers(
      [
        { pid: 1, threadId: null, label: "npx mcp-server-git", rssMb: 60, cpuPct: 0 },
        { pid: 2, threadId: null, label: "npx mcp-server-git", rssMb: 55, cpuPct: 0 },
        { pid: 3, threadId: null, label: "claude --print", rssMb: 300, cpuPct: 0 },
        { pid: 4, threadId: null, label: "uvx linear-mcp", rssMb: 40, cpuPct: 0 },
      ],
      ["uvx linear-mcp", "npx @acme/notes-mcp"],
      (command) => (command === "uvx linear-mcp" ? 3 : 0),
    );
    expect(hub).toEqual([
      {
        command: "npx mcp-server-git",
        name: "mcp_server_git_hub",
        instances: 2,
        rssMb: 115,
        shared: false,
        sessions: 0,
      },
      {
        command: "uvx linear-mcp",
        name: "linear_mcp_hub",
        instances: 1,
        rssMb: 40,
        shared: true,
        sessions: 3,
      },
      {
        command: "npx @acme/notes-mcp",
        name: "notes_mcp_hub",
        instances: 0,
        rssMb: 0,
        shared: true,
        sessions: 0,
      },
    ]);
  });
});
