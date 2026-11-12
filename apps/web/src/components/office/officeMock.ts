// FILE: officeMock.ts
// Purpose: Development-only mock office that recreates the asset pack's reference image: a
//          root supervisor, a nested "explore" supervisor, four specialists and three agents
//          at the coffee bar, treadmill and WC. Only reachable behind import.meta.env.DEV.
// Layer: Web office logic (pure)
// Exports: mockOffice, DemoActivity

import type { ProviderKind, ThreadId } from "@saint/contracts";

import type { IdleActivity } from "./officeBehavior.logic";
import type { OfficeAssignment, OfficeThread } from "./officeModel.logic";

/** An idle activity the mock pins an agent to; "fresh" sips coffee at the desk. */
export type DemoActivity = IdleActivity | "fresh";

type MockState = "working" | "approval" | "error" | "idle";

function mockThread(input: {
  readonly id: string;
  readonly title: string;
  readonly provider: ProviderKind;
  readonly state: MockState;
  readonly now: number;
  readonly parent?: string;
  readonly role?: string;
  readonly finishedAgoMs?: number;
}): OfficeThread {
  const at = (ago: number) => new Date(input.now - ago).toISOString();
  const live = input.state === "working" || input.state === "approval";
  return {
    id: input.id as ThreadId,
    title: input.title,
    session: live
      ? ({
          provider: input.provider,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: "turn-1",
          createdAt: at(60_000),
          updatedAt: at(0),
        } as OfficeThread["session"])
      : null,
    modelSelection: { provider: input.provider, model: "mock" } as OfficeThread["modelSelection"],
    latestTurn: {
      turnId: "turn-1",
      state: live ? "running" : input.state === "error" ? "error" : "completed",
      requestedAt: at(120_000),
      startedAt: at(120_000),
      completedAt: live ? null : at(input.finishedAgoMs ?? 600_000),
      assistantMessageId: null,
    } as OfficeThread["latestTurn"],
    updatedAt: at(input.finishedAgoMs ?? 0),
    createdAt: at(600_000),
    parentThreadId: (input.parent ?? null) as ThreadId | null,
    archivedAt: null,
    interactionMode: "default",
    lastVisitedAt: at(0),
    hasPendingApprovals: input.state === "approval",
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    subagentRole: input.role ?? null,
    subagentNickname: null,
  } as OfficeThread;
}

const ids = (list: readonly string[]) => list.map((id) => id as ThreadId);

export function mockOffice(now: number): {
  readonly threads: readonly OfficeThread[];
  readonly coordinatorThreadIds: ReadonlySet<string>;
  /** Desk order matching the reference image. */
  readonly seating: OfficeAssignment;
  readonly activities: ReadonlyMap<string, DemoActivity>;
  /** Agents pinned at an amenity; they hold no desk, so no empty desks pile up. */
  readonly roaming: ReadonlySet<string>;
} {
  const t = (input: Omit<Parameters<typeof mockThread>[0], "now">) => mockThread({ ...input, now });
  const threads = [
    t({ id: "mock-root", title: "supervisor", provider: "claudeAgent", state: "approval" }),
    t({
      id: "mock-nested",
      title: "Explore the repo",
      provider: "codex",
      state: "working",
      parent: "mock-root",
      role: "explore",
    }),
    t({
      id: "mock-file",
      title: "file agent",
      provider: "claudeAgent",
      state: "working",
      parent: "mock-nested",
    }),
    t({
      id: "mock-browser",
      title: "browser qa",
      provider: "antigravity",
      state: "idle",
      parent: "mock-nested",
    }),
    t({
      id: "mock-app",
      title: "ui layout",
      provider: "cursor",
      state: "idle",
      parent: "mock-nested",
      finishedAgoMs: 5_000,
    }),
    t({
      id: "mock-build",
      title: "fix build",
      provider: "grok",
      state: "error",
      parent: "mock-nested",
      role: "shell",
    }),
    t({ id: "mock-coffee", title: "docs lookup", provider: "codex", state: "idle" }),
    t({ id: "mock-treadmill", title: "web scrape", provider: "opencode", state: "idle" }),
    t({ id: "mock-wc", title: "research", provider: "claudeAgent", state: "idle" }),
  ];
  return {
    threads,
    coordinatorThreadIds: new Set(["mock-root"]),
    seating: {
      root: "mock-root" as ThreadId,
      nested: ids(["mock-nested"]),
      leaves: ids(["mock-file", "mock-browser", "mock-app", "mock-build"]),
    },
    activities: new Map<string, DemoActivity>([
      ["mock-browser", "sleep"],
      ["mock-app", "fresh"],
      ["mock-coffee", "coffee"],
      ["mock-treadmill", "treadmill"],
      ["mock-wc", "toilet"],
    ]),
    roaming: new Set(["mock-coffee", "mock-treadmill", "mock-wc"]),
  };
}
