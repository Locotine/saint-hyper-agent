// FILE: officeModel.logic.ts
// Purpose: Maps Saint threads (any provider) onto office characters: one desk per live or
//          recently active thread, a supervisor desk for the coordinator, duty per thread.
// Layer: Web office logic (pure)
// Exports: desk assignment, duty derivation, monitor colours

import type { ProviderKind, ThreadId } from "@saint/contracts";

import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import type { SidebarThreadSummary } from "~/types";

export type DutyState = "working" | "approval" | "input" | "error" | "idle";

export type OfficeThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "title"
  | "session"
  | "modelSelection"
  | "latestTurn"
  | "updatedAt"
  | "createdAt"
  | "parentThreadId"
  | "archivedAt"
  | "interactionMode"
  | "lastVisitedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "hasLiveTailWork"
  | "pendingBackgroundWorkCount"
>;

/** Threads idle for longer than this leave the office. */
export const RECENT_THREAD_MS = 2 * 60 * 60_000;

export function deriveDuty(thread: OfficeThread): DutyState {
  const status = resolveThreadStatusPill({
    thread,
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
  });
  switch (status?.label) {
    case "Pending Approval":
      return "approval";
    case "Awaiting Input":
      return "input";
    case "Working":
    case "Connecting":
    case "Preparing worktree":
    case "In Background":
      return "working";
    default:
      break;
  }
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error") return "error";
  return "idle";
}

export function threadProvider(thread: OfficeThread): ProviderKind {
  return thread.session?.provider ?? thread.modelSelection.provider;
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function threadLastActiveMs(thread: OfficeThread): number {
  return Math.max(
    parseTime(thread.updatedAt),
    parseTime(thread.createdAt),
    parseTime(thread.latestTurn?.requestedAt),
    parseTime(thread.latestTurn?.startedAt),
    parseTime(thread.latestTurn?.completedAt),
  );
}

const DUTY_RANK: Record<DutyState, number> = {
  approval: 4,
  input: 3,
  working: 2,
  error: 1,
  idle: 0,
};

function compareThreads(
  a: { thread: OfficeThread; duty: DutyState },
  b: { thread: OfficeThread; duty: DutyState },
): number {
  return (
    DUTY_RANK[b.duty] - DUTY_RANK[a.duty] ||
    threadLastActiveMs(b.thread) - threadLastActiveMs(a.thread)
  );
}

export interface OfficeAssignment {
  /** Thread per desk; index 0 is the supervisor desk. The length grows with the thread count. */
  readonly desks: readonly (ThreadId | null)[];
}

/**
 * Seats every live or recently active thread. The supervisor desk takes a coordinator, or else
 * a thread whose subagent is live. Threads keep their desk across updates; newcomers take the
 * lowest free desk; trailing empty desks are dropped.
 */
export function assignOfficeDesks(input: {
  readonly threads: readonly OfficeThread[];
  readonly coordinatorThreadIds: ReadonlySet<string>;
  readonly previous: readonly (ThreadId | null)[];
  readonly now: number;
}): OfficeAssignment {
  const ranked = input.threads
    .filter((thread) => !thread.archivedAt)
    .map((thread) => ({ thread, duty: deriveDuty(thread) }))
    .filter(
      ({ thread, duty }) =>
        duty !== "idle" || input.now - threadLastActiveMs(thread) < RECENT_THREAD_MS,
    )
    .toSorted(compareThreads);

  const liveParentIds = new Set(
    ranked
      .filter(({ thread, duty }) => duty !== "idle" && thread.parentThreadId)
      .map(({ thread }) => thread.parentThreadId as string),
  );
  const supervisor =
    ranked.find(({ thread }) => input.coordinatorThreadIds.has(thread.id)) ??
    ranked.find(({ thread }) => liveParentIds.has(thread.id)) ??
    null;

  const chosen = new Set(
    ranked.filter((entry) => entry !== supervisor).map(({ thread }) => thread.id),
  );
  const desks: (ThreadId | null)[] = [supervisor?.thread.id ?? null];
  for (let desk = 1; desk < input.previous.length; desk += 1) {
    const kept = input.previous[desk] ?? null;
    desks.push(kept !== null && chosen.has(kept) ? kept : null);
  }
  for (const id of chosen) {
    if (desks.includes(id)) continue;
    const free = desks.indexOf(null, 1);
    if (free === -1) desks.push(id);
    else desks[free] = id;
  }
  while (desks.length > 1 && desks[desks.length - 1] === null) desks.pop();
  return { desks };
}

/** Monitor screen colour per duty; a desk with no thread keeps its screen dark. */
export function monitorColor(duty: DutyState | null): number {
  switch (duty) {
    case "working":
      return 0x6aa8f7;
    case "approval":
    case "input":
      return 0xf6b24a;
    case "error":
      return 0xea6a6e;
    default:
      return 0x1a1b1f;
  }
}
