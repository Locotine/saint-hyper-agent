// FILE: useOfficeState.ts
// Purpose: Reads Saint's thread summaries and turns them into office desks, one per thread:
//          tier (root, nested, specialist), skin, provider and duty. In development a mock
//          office can replace the store data.
// Layer: Web office hook over the normalized store
// Exports: useOfficeState, OfficeDeskView

import type { ProviderKind, ThreadId } from "@saint/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCoordinatorThreadIds } from "~/components/chat/project/useProjectAgentSummaries";
import { resolveThreadStatusPill, type ThreadStatusPill } from "~/components/Sidebar.logic";
import { useStore, type AppState } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import type { SidebarThreadSummary } from "~/types";

import type { OfficeEngineAgent, OfficeEngineState } from "./engine/officeEngine";
import { firstLeafDesk } from "./officeLayout.logic";
import { mockOffice } from "./officeMock";
import {
  EMPTY_ASSIGNMENT,
  ROOT_SKIN,
  assignOfficeDesks,
  deriveDuty,
  inferAgentSkin,
  threadFinishedMs,
  threadProvider,
  type DutyState,
  type OfficeAssignment,
  type OfficeThread,
  type OfficeTier,
} from "./officeModel.logic";

export interface OfficeDeskView {
  /** Desk index, or null for an agent without a desk (mock agents pinned at an amenity). */
  readonly desk: number | null;
  readonly role: string;
  readonly thread: SidebarThreadSummary | null;
  readonly duty: DutyState;
  readonly provider: ProviderKind | null;
  readonly status: ThreadStatusPill | null;
  readonly speech: string | null;
}

const selectSidebarThreads = createSidebarThreadSummariesSelector();
const LABEL_MAX = 14;
const SPEECH_MAX = 28;
/** Recency filtering only needs coarse time. */
const CLOCK_TICK_MS = 30_000;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function latestActivitySummary(state: AppState, threadId: ThreadId): string {
  const ids = state.activityIdsByThreadId?.[threadId];
  const lastId = ids?.[ids.length - 1];
  return (lastId && state.activityByThreadId?.[threadId]?.[lastId]?.summary) || "";
}

/** Desk index, tier and roster role for every seated thread. */
function seatsOf(assignment: OfficeAssignment, roaming: readonly ThreadId[]) {
  const seats: { threadId: ThreadId; desk: number | null; tier: OfficeTier; role: string }[] = [];
  if (assignment.root) {
    seats.push({ threadId: assignment.root, desk: 0, tier: "root", role: "Supervisor" });
  }
  assignment.nested.forEach((threadId, i) =>
    seats.push({ threadId, desk: 1 + i, tier: "nested", role: "Sub-supervisor" }),
  );
  const leafStart = firstLeafDesk(assignment.nested.length);
  assignment.leaves.forEach((threadId, i) => {
    if (threadId)
      seats.push({ threadId, desk: leafStart + i, tier: "leaf", role: `Desk ${i + 1}` });
  });
  for (const threadId of roaming) seats.push({ threadId, desk: null, tier: "leaf", role: "Away" });
  return seats;
}

export function useOfficeState(options: { readonly demo?: boolean } = {}): {
  readonly desks: readonly OfficeDeskView[];
  readonly agents: readonly OfficeEngineAgent[];
  readonly layout: OfficeEngineState["layout"];
} {
  const demo = import.meta.env.DEV && options.demo === true;
  const storeThreads = useStore(selectSidebarThreads);
  const storeCoordinators = useCoordinatorThreadIds();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const mock = useMemo(() => (demo ? mockOffice(Date.now()) : null), [demo]);
  const threads: readonly OfficeThread[] = mock?.threads ?? storeThreads;
  const coordinatorThreadIds = mock?.coordinatorThreadIds ?? storeCoordinators;

  const previousDesks = useRef<OfficeAssignment>(EMPTY_ASSIGNMENT);
  const assignment = useMemo(
    () =>
      assignOfficeDesks({
        threads: mock ? threads.filter((thread) => !mock.roaming.has(thread.id)) : threads,
        coordinatorThreadIds,
        previous: mock?.seating ?? previousDesks.current,
        now,
      }),
    [threads, coordinatorThreadIds, mock, now],
  );
  useEffect(() => {
    previousDesks.current = assignment;
  }, [assignment]);

  const seats = useMemo(
    () =>
      seatsOf(
        assignment,
        mock
          ? threads.filter((thread) => mock.roaming.has(thread.id)).map((thread) => thread.id)
          : [],
      ),
    [assignment, mock, threads],
  );
  // Joined into one string so the selector result is stable between unrelated store updates.
  const deskIdsKey = seats.map((seat) => seat.threadId).join("|");
  const speechKey = useStore(
    useCallback(
      (state: AppState) =>
        seats.map((seat) => latestActivitySummary(state, seat.threadId)).join("\u0000"),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the desk ids
      [deskIdsKey],
    ),
  );

  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const dutyById = new Map(threads.map((thread) => [thread.id, deriveDuty(thread)]));
    const workingParents = new Set(
      threads
        .filter((thread) => thread.parentThreadId && dutyById.get(thread.id) === "working")
        .map((thread) => thread.parentThreadId as string),
    );
    const speeches = speechKey.split("\u0000");
    const rows = seats.flatMap((seat, i) => {
      const thread = byId.get(seat.threadId);
      if (!thread) return [];
      const duty = dutyById.get(thread.id) ?? "idle";
      const speech = speeches[i] ? truncate(speeches[i], SPEECH_MAX) : null;
      const provider = threadProvider(thread);
      const demoActivity = mock?.activities.get(thread.id);
      const desk: OfficeDeskView = {
        desk: seat.desk,
        role: seat.role,
        // Mock threads carry only the fields the office reads.
        thread: thread as SidebarThreadSummary,
        duty,
        provider,
        status: resolveThreadStatusPill({
          thread,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
        }),
        speech,
      };
      const agent: OfficeEngineAgent = {
        threadId: thread.id,
        desk: seat.desk,
        tier: seat.tier,
        skin: seat.tier === "root" ? ROOT_SKIN : inferAgentSkin(thread),
        provider,
        label: truncate(thread.title, LABEL_MAX),
        duty,
        speech,
        parentThreadId: thread.parentThreadId ?? null,
        hasWorkingChildren: workingParents.has(thread.id),
        finishedAt: threadFinishedMs(thread),
        ...(demoActivity ? { demoActivity } : {}),
      };
      return [{ desk, agent }];
    });
    return {
      desks: rows
        .map((row) => row.desk)
        .toSorted((a, b) => (a.desk ?? Infinity) - (b.desk ?? Infinity)),
      agents: rows.map((row) => row.agent),
      layout: { nested: assignment.nested.length, leaves: assignment.leaves.length },
    };
  }, [assignment, seats, speechKey, threads, mock]);
}
