import { describe, expect, it } from "vitest";

import {
  groupNestedThreads,
  nestedThreadsSummaryLabel,
  summarizeNestedThreads,
} from "./nestedThreads";

const thread = (id: string, parentThreadId: string | null, extra: object = {}) => ({
  id,
  parentThreadId,
  ...extra,
});

describe("nested threads", () => {
  it("groups live children under their parent, oldest first", () => {
    const grouped = groupNestedThreads([
      thread("p", null),
      thread("b", "p", { createdAt: "2" }),
      thread("a", "p", { createdAt: "1" }),
      thread("gone", "p", { archivedAt: "3" }),
    ]);
    expect(grouped.get("p")?.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("counts every nested session and the failed ones", () => {
    const grouped = groupNestedThreads([
      thread("a", "p", { session: { status: "error" } }),
      thread("b", "p", { latestTurn: { state: "completed" } }),
      thread("c", "a", { latestTurn: { state: "error" } }),
    ]);
    expect(summarizeNestedThreads(grouped, "p")).toEqual({ count: 3, failed: 2 });
    expect(nestedThreadsSummaryLabel({ count: 4, failed: 3 })).toBe("4 nested sessions · 3 failed");
    expect(nestedThreadsSummaryLabel({ count: 1, failed: 0 })).toBe("1 nested session");
  });
});
