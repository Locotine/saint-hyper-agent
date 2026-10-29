import { describe, expect, it } from "vitest";

import {
  FORK_CONTINUE_MARKER,
  buildForkSnapshot,
  carriedGoal,
  contextUsedFraction,
  parsePorcelainPaths,
  summarizableMessages,
} from "./forkContinue";

const messages = [
  { role: "user" as const, text: "Add a rate limit to POST /login" },
  { role: "assistant" as const, text: "Added a token bucket; gate evidence ev:0123456789ab" },
  { role: "user" as const, text: "Also cover the admin route" },
  { role: "assistant" as const, text: "Working on admin; tests red." },
];

describe("buildForkSnapshot", () => {
  it("carries goal, latest request, last reply, changed files and handles", () => {
    const text = buildForkSnapshot({
      title: "Rate limit",
      reason: "context 72% full",
      messages,
      changedFiles: ["src/auth/login.ts"],
      summary: "Bucket done for /login.",
    });
    expect(text.startsWith(FORK_CONTINUE_MARKER)).toBe(true);
    expect(text).toContain("Goal: Add a rate limit to POST /login");
    expect(text).toContain("Also cover the admin route");
    expect(text).toContain("tests red");
    expect(text).toContain("src/auth/login.ts");
    expect(text).toContain("ev:0123456789ab");
    expect(text).toContain("Bucket done");
  });

  it("a fork of a fork keeps the first goal and never summarizes the old snapshot", () => {
    const first = buildForkSnapshot({ title: "t", reason: "r", messages, changedFiles: [] });
    const forked = [
      { role: "user" as const, text: first },
      { role: "assistant" as const, text: "ok" },
    ];
    expect(carriedGoal(forked)).toBe("Add a rate limit to POST /login");
    expect(summarizableMessages(forked)).toEqual([{ role: "assistant", text: "ok" }]);
    expect(
      buildForkSnapshot({ title: "t", reason: "r", messages: forked, changedFiles: [] }),
    ).toContain("Goal: Add a rate limit to POST /login");
  });
});

describe("contextUsedFraction", () => {
  it.each([
    [{ usedPercent: 71 }, 0.71],
    [{ usedTokens: 140_000, maxTokens: 200_000 }, 0.7],
    [{ usedTokens: 10 }, null],
    [{ usedPercent: 90, compactsAutomatically: true }, null],
    [null, null],
  ])("%j → %s", (payload, expected) => {
    expect(contextUsedFraction(payload)).toBe(expected);
  });
});

it("parses porcelain paths", () => {
  expect(parsePorcelainPaths(" M src/a.ts\n?? new.ts\n")).toEqual(["src/a.ts", "new.ts"]);
});
