// FILE: useOfficeState.ts
// Purpose: Reads Saint's thread summaries and turns them into office desks, one per thread.
// Layer: Web office hook over the normalized store
// Exports: useOfficeState, OfficeDeskView

import type { ProviderKind, ThreadId } from "@saint/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCoordinatorThreadIds } from "~/components/chat/project/useProjectAgentSummaries";
import { resolveThreadStatusPill, type ThreadStatusPill } from "~/components/Sidebar.logic";
import { useStore, type AppState } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import type { SidebarThreadSummary } from "~/types";

import type { OfficeEngineAgent } from "./engine/officeEngine";
import { assignOfficeDesks, deriveDuty, threadProvider, type DutyState } from "./officeModel.logic";

export interface OfficeDeskView {
  readonly desk: number;
  readonly role: string;
  readonly thread: SidebarThreadSummary | null;
  readonly duty: DutyState;
  readonly provider: ProviderKind | null;
  readonly status: ThreadStatusPill | null;
  readonly speech: string | null;
}

const selectSidebarThreads = createSidebarThreadSummariesSelector();
const EMPTY_DESKS: readonly (ThreadId | null)[] = [];
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

export function useOfficeState(): {
  readonly desks: readonly OfficeDeskView[];
  readonly agents: readonly OfficeEngineAgent[];
} {
  const threads = useStore(selectSidebarThreads);
  const coordinatorThreadIds = useCoordinatorThreadIds();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const previousDesks = useRef<readonly (ThreadId | null)[]>(EMPTY_DESKS);
  const assignment = useMemo(
    () =>
      assignOfficeDesks({ threads, coordinatorThreadIds, previous: previousDesks.current, now }),
    [threads, coordinatorThreadIds, now],
  );
  useEffect(() => {
    previousDesks.current = assignment.desks;
  }, [assignment.desks]);

  // Joined into one string so the selector result is stable between unrelated store updates.
  const deskIdsKey = assignment.desks.join("|");
  const speechKey = useStore(
    useCallback(
      (state: AppState) =>
        assignment.desks
          .map((threadId) => (threadId ? latestActivitySummary(state, threadId) : ""))
          .join("\u0000"),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the desk ids
      [deskIdsKey],
    ),
  );

  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const speeches = speechKey.split("\u0000");
    const desks = assignment.desks.map((threadId, desk): OfficeDeskView => {
      const thread = threadId ? (byId.get(threadId) ?? null) : null;
      const speech = speeches[desk] ? truncate(speeches[desk], SPEECH_MAX) : null;
      return {
        desk,
        role: desk === 0 ? "Supervisor" : `Desk ${desk + 1}`,
        thread,
        duty: thread ? deriveDuty(thread) : "idle",
        provider: thread ? threadProvider(thread) : null,
        status: thread
          ? resolveThreadStatusPill({
              thread,
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
            })
          : null,
        speech,
      };
    });
    const agents = desks.flatMap((desk): OfficeEngineAgent[] =>
      desk.thread
        ? [
            {
              threadId: desk.thread.id,
              desk: desk.desk,
              label: truncate(desk.thread.title, LABEL_MAX),
              duty: desk.duty,
              speech: desk.speech,
              parentThreadId: desk.thread.parentThreadId ?? null,
            },
          ]
        : [],
    );
    return { desks: desks.filter((desk) => desk.thread !== null), agents };
  }, [assignment, speechKey, threads]);
}
