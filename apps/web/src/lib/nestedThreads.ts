// FILE: nestedThreads.ts
// Purpose: Groups subagent threads under their parent for the sidebar and summarizes a parent's
//          nested sessions ("4 nested sessions · 3 failed"), shared by this computer's rows and
//          a remote host's rows.
// Layer: Sidebar support
// Exports: groupNestedThreads, summarizeNestedThreads, nestedThreadsSummaryLabel

import { collectSubagentDescendants } from "@saint/shared/threadHierarchy";

import { resolveSubagentThreadStatusKind } from "./subagentPresentation";

interface NestableThread {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly createdAt?: string | undefined;
}

type StatusThread = NestableThread & Parameters<typeof resolveSubagentThreadStatusKind>[0];

/** Live children by parent id, oldest first, like the "Subagent N" labels count them. */
export function groupNestedThreads<T extends NestableThread>(
  threads: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const byParent = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt) continue;
    const siblings = byParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else byParent.set(thread.parentThreadId, [thread]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(
      (left, right) =>
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.id.localeCompare(right.id),
    );
  }
  return byParent;
}

/** Every session under `parentId` (children, their children, ...) and how many of them failed. */
export function summarizeNestedThreads<T extends StatusThread>(
  childrenByParent: ReadonlyMap<string, readonly T[]>,
  parentId: string,
): { readonly count: number; readonly failed: number } {
  const edges = [...childrenByParent.values()].flat();
  const descendants = collectSubagentDescendants(edges, parentId);
  return {
    count: descendants.length,
    failed: descendants.filter((thread) => resolveSubagentThreadStatusKind(thread) === "failed")
      .length,
  };
}

export function nestedThreadsSummaryLabel(summary: {
  readonly count: number;
  readonly failed: number;
}): string {
  const sessions = `${summary.count} nested ${summary.count === 1 ? "session" : "sessions"}`;
  return summary.failed > 0 ? `${sessions} · ${summary.failed} failed` : sessions;
}
