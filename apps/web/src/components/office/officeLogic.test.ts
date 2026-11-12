import type { ThreadId } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { findPath } from "./astar";
import {
  dutyAction,
  idleCandidates,
  pickIdleActivity,
  seatedAnim,
  shouldLeave,
  standbySeconds,
  walkDirection,
} from "./officeBehavior.logic";
import { firstLeafDesk, officeFitBoost, officeLayout } from "./officeLayout.logic";
import {
  EMPTY_ASSIGNMENT,
  SKIN_KEYWORDS,
  assignOfficeDesks,
  clearSkinCache,
  deriveDuty,
  deskSprites,
  inferAgentSkin,
  mapProvider,
  monitorSprite,
  statusBubbles,
  type OfficeThread,
} from "./officeModel.logic";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");

function thread(id: string, overrides: Partial<OfficeThread> = {}): OfficeThread {
  return {
    id: id as ThreadId,
    title: id,
    session: null,
    modelSelection: { provider: "codex", model: "gpt-5-codex" } as OfficeThread["modelSelection"],
    latestTurn: null,
    updatedAt: new Date(NOW - 60_000).toISOString(),
    createdAt: new Date(NOW - 120_000).toISOString(),
    parentThreadId: null,
    archivedAt: null,
    interactionMode: "default",
    lastVisitedAt: new Date(NOW).toISOString(),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  } as OfficeThread;
}

function running(id: string, overrides: Partial<OfficeThread> = {}): OfficeThread {
  return thread(id, {
    session: {
      provider: "claudeAgent",
      status: "running",
      orchestrationStatus: "running",
      activeTurnId: "turn-1",
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    } as OfficeThread["session"],
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: new Date(NOW).toISOString(),
      startedAt: new Date(NOW).toISOString(),
      completedAt: null,
      assistantMessageId: null,
    } as OfficeThread["latestTurn"],
    ...overrides,
  });
}

const open = () => false;
const wall = (c: number, r: number) => c === 1 && r < 4;

describe("findPath", () => {
  it("returns the shortest 4-way path including both ends", () => {
    const path = findPath(5, 5, open, { c: 0, r: 0 }, { c: 2, r: 1 });
    expect(path).toHaveLength(4);
    expect(path?.[0]).toEqual({ c: 0, r: 0 });
    expect(path?.at(-1)).toEqual({ c: 2, r: 1 });
  });

  it("routes around walls and reaches a blocked goal", () => {
    const path = findPath(5, 5, wall, { c: 0, r: 0 }, { c: 2, r: 0 });
    expect(path).not.toBeNull();
    expect(path?.some((step) => step.c === 1 && step.r < 4)).toBe(false);
    expect(findPath(3, 3, (c) => c === 1, { c: 0, r: 0 }, { c: 2, r: 0 })).toBeNull();
  });
});

describe("deriveDuty", () => {
  it("follows the sidebar status of the thread", () => {
    expect(deriveDuty(thread("idle"))).toBe("idle");
    expect(deriveDuty(running("run"))).toBe("working");
    expect(deriveDuty(running("approve", { hasPendingApprovals: true }))).toBe("approval");
    expect(deriveDuty(running("ask", { hasPendingUserInput: true }))).toBe("input");
    expect(
      deriveDuty(
        thread("failed", {
          latestTurn: {
            turnId: "turn-1",
            state: "error",
            requestedAt: new Date(NOW).toISOString(),
            startedAt: null,
            completedAt: new Date(NOW).toISOString(),
            assistantMessageId: null,
          } as OfficeThread["latestTurn"],
        }),
      ),
    ).toBe("error");
  });
});

const assign = (
  threads: OfficeThread[],
  coordinators: string[] = [],
  previous = EMPTY_ASSIGNMENT,
) =>
  assignOfficeDesks({
    threads,
    coordinatorThreadIds: new Set(coordinators),
    previous,
    now: NOW,
  });

describe("assignOfficeDesks", () => {
  it("seats a coordinator at the root desk and everyone else, without a cap", () => {
    const result = assign(
      [
        thread("quiet"),
        running("busy"),
        running("needs", { hasPendingApprovals: true }),
        thread("coord"),
        ...["a", "b", "c", "d", "e", "f"].map((id) => running(id)),
      ],
      ["coord"],
    );
    expect(result.root).toBe("coord");
    expect(result.nested).toEqual([]);
    expect(result.leaves[0]).toBe("needs");
    expect(result.leaves).toHaveLength(9);
    expect(result.leaves.at(-1)).toBe("quiet");
  });

  it("makes a top-level parent the root and a parent with live children nested", () => {
    const result = assign([
      thread("parent"),
      running("lead", { parentThreadId: "parent" as ThreadId }),
      running("worker", { parentThreadId: "lead" as ThreadId }),
    ]);
    expect(result.root).toBe("parent");
    expect(result.nested).toEqual(["lead"]);
    expect(result.leaves).toEqual(["worker"]);
  });

  it("never makes a subagent the root", () => {
    const result = assign([
      running("child", { parentThreadId: "gone" as ThreadId }),
      running("grandchild", { parentThreadId: "child" as ThreadId }),
    ]);
    expect(result.root).toBeNull();
    expect(result.nested).toEqual(["child"]);
  });

  it("demotes a nested supervisor once its last child is done", () => {
    const first = assign([
      thread("parent"),
      running("lead", { parentThreadId: "parent" as ThreadId }),
      running("worker", { parentThreadId: "lead" as ThreadId }),
    ]);
    const next = assign(
      [
        thread("parent"),
        running("lead", { parentThreadId: "parent" as ThreadId }),
        thread("worker", { parentThreadId: "lead" as ThreadId }),
      ],
      [],
      first,
    );
    expect(next.nested).toEqual([]);
    expect(next.leaves).toEqual(["worker", "lead"]);
  });

  it("keeps threads at their desks, fills gaps, and drops stale threads", () => {
    const stale = thread("stale", {
      updatedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
      createdAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    });
    const result = assign([stale, running("a"), running("c")], [], {
      root: null,
      nested: [],
      leaves: ["gone" as ThreadId, null, "c" as ThreadId],
    });
    expect(result.leaves).toEqual(["a", null, "c"]);
  });
});

describe("officeLayout", () => {
  it.each([
    [0, 0],
    [1, 4],
    [2, 7],
    [3, 12],
  ])("fits %i nested and %i specialist desks, all reachable from the door", (nested, leaves) => {
    const layout = officeLayout({ nested, leaves });
    expect(layout.desks.length).toBe(firstLeafDesk(nested) + Math.max(4, leaves + (leaves % 2)));
    expect(layout.desks[0]?.tier).toBe("root");
    expect(layout.desks.filter((slot) => slot.tier === "nested")).toHaveLength(nested);
    expect(layout.cols).toBe(12);
    for (const slot of layout.desks) {
      expect(layout.isBlocked(slot.stand.c, slot.stand.r)).toBe(false);
      for (const cell of slot.desk) expect(layout.isBlocked(cell.c, cell.r)).toBe(true);
      const path = findPath(
        layout.cols,
        layout.rows,
        layout.isBlocked,
        layout.spots.door,
        slot.stand,
      );
      expect(path).not.toBeNull();
    }
    for (const spot of [layout.spots.coffee, layout.spots.treadmill, layout.spots.toilet]) {
      expect(
        findPath(layout.cols, layout.rows, layout.isBlocked, layout.spots.door, spot),
      ).not.toBeNull();
    }
  });

  it("puts the root on top, a lone nested desk centred below it, then two specialist columns", () => {
    const layout = officeLayout({ nested: 1, leaves: 4 });
    const [root, nested, left, right, nextLeft] = layout.desks;
    expect(nested!.anchor.x).toBe(root!.anchor.x);
    expect(nested!.anchor.y).toBeGreaterThan(root!.anchor.y);
    expect(left!.anchor.y).toBeGreaterThan(nested!.anchor.y);
    expect(left!.anchor.y).toBe(right!.anchor.y);
    expect(left!.anchor.x).toBeLessThan(root!.anchor.x);
    expect(right!.anchor.x).toBeGreaterThan(root!.anchor.x);
    expect(nextLeft!.anchor.y).toBeGreaterThan(left!.anchor.y);
    expect(nextLeft!.variant).toBe(2);
  });

  it("keeps specialist desks in place when the first nested supervisor appears", () => {
    const before = officeLayout({ nested: 0, leaves: 4 }).desks.slice(firstLeafDesk(0));
    const after = officeLayout({ nested: 1, leaves: 4 }).desks.slice(firstLeafDesk(1));
    expect(after.map((slot) => slot.anchor)).toEqual(before.map((slot) => slot.anchor));
  });

  it("eases the first-fit zoom from 1.1 to 1", () => {
    expect(officeFitBoost(0)).toBeCloseTo(1.1);
    expect(officeFitBoost(1)).toBeCloseTo(1);
    expect(officeFitBoost(0.5)).toBeCloseTo(1.05);
  });
});

const skinOf = (fields: Partial<OfficeThread>, id = "t") => {
  clearSkinCache();
  return inferAgentSkin({
    id: id as ThreadId,
    title: "",
    subagentRole: null,
    subagentNickname: null,
    ...fields,
  });
};

describe("providers and skins", () => {
  it("maps provider kinds onto palette providers", () => {
    expect(mapProvider("claudeAgent")).toBe("claude");
    expect(mapProvider("codex")).toBe("openai");
    expect(mapProvider("antigravity")).toBe("antigravity");
    for (const other of ["cursor", "grok", "droid", "opencode", "pi", "devin", "omp"] as const) {
      expect(mapProvider(other)).toBe("local");
    }
    expect(mapProvider(null)).toBe("local");
  });

  it.each(SKIN_KEYWORDS.flatMap(([skin, words]) => words.map((word) => [word, skin] as const)))(
    "maps the keyword %s onto %s",
    (word, skin) => {
      expect(skinOf({ title: `Please ${word.toUpperCase()} now` })).toBe(skin);
    },
  );

  it("prefers role, then nickname, then title, first group wins", () => {
    expect(skinOf({ subagentRole: "explore", subagentNickname: "browser", title: "fix" })).toBe(
      "skin_06_search_agent",
    );
    expect(skinOf({ subagentNickname: "terminal", title: "fix" })).toBe("skin_04_computer_agent");
    expect(skinOf({ title: "browser ui fix" })).toBe("skin_03_browser_agent");
  });

  it("matches whole words only", () => {
    // "app" in "happy", "ui" in "guidebook", "web" in "webbing", "build" and "fix" inside words.
    const fallback = skinOf({ title: "" }, "x");
    expect(skinOf({ title: "happy guidebook webbing" }, "x")).toBe(fallback);
    expect(skinOf({ title: "rebuilding happy fixtures" }, "x")).toBe(fallback);
    expect(skinOf({ title: "browser-qa" })).toBe("skin_03_browser_agent");
  });

  it("falls back to a stable hash over the worker skins and caches per thread", () => {
    const a = skinOf({ title: "zzz" }, "thread-a");
    expect(skinOf({ title: "zzz" }, "thread-a")).toBe(a);
    expect(a).not.toBe("skin_01_supervisor");
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => skinOf({ title: "zzz" }, `thread-${i}`)),
    );
    expect(seen.size).toBeGreaterThan(2);
    clearSkinCache();
    const thread = { id: "keep" as ThreadId, subagentRole: null, subagentNickname: null };
    expect(inferAgentSkin({ ...thread, title: "explore" })).toBe("skin_06_search_agent");
    expect(inferAgentSkin({ ...thread, title: "fix the ui" })).toBe("skin_06_search_agent");
  });

  it("picks furniture, monitors and bubbles per tier and duty", () => {
    expect(deskSprites("root").desk).toBe("env/desk_supervisor_large.png");
    expect(deskSprites("nested").backrest).toBe("env/chair_sub_supervisor_backrest.png");
    expect(deskSprites("nested").badge).toBe("ui/badge_nested_supervisor.png");
    expect(deskSprites("leaf", 4).desk).toBe("env/desk_specialist_05.png");
    expect(deskSprites("leaf", 5).desk).toBe("env/desk_specialist_01.png");
    expect(deskSprites("leaf").badge).toBeNull();
    expect(monitorSprite("working", "skin_02_file_agent")).toBe("env/monitor_working.png");
    expect(monitorSprite("working", "skin_05_app_agent")).toBe("env/monitor_working_green.png");
    expect(monitorSprite("input", null)).toBe("env/monitor_pending.png");
    expect(monitorSprite("error", null)).toBe("env/monitor_error.png");
    expect(monitorSprite(null, null)).toBe("env/monitor_off.png");
    expect(statusBubbles("working", false)).toEqual(["typing"]);
    expect(statusBubbles("approval", true)).toEqual(["typing", "question"]);
    expect(statusBubbles("error", false)).toEqual(["alert"]);
    expect(statusBubbles("idle", false)).toEqual([]);
  });
});

describe("behaviour", () => {
  it("maps duty changes onto actions", () => {
    expect(dutyAction(undefined, "idle", false)).toBe("DISPATCH");
    expect(dutyAction("idle", "working", false)).toBe("START");
    expect(dutyAction("idle", "working", true)).toBe("SUB_START");
    expect(dutyAction("working", "approval", false)).toBe("ATTENTION");
    expect(dutyAction("working", "error", false)).toBe("ERROR");
    expect(dutyAction("working", "idle", false)).toBe("COMPLETE");
    expect(dutyAction("error", "idle", false)).toBe("IDLE");
    expect(dutyAction("working", "working", false)).toBeNull();
  });

  it("picks the seated pose", () => {
    const base = { nested: false, hasWorkingChildren: false, swap: false, idle: null };
    expect(seatedAnim({ ...base, duty: "working" })).toBe("sit_type");
    expect(seatedAnim({ ...base, duty: "working", hasWorkingChildren: true })).toBe("sit_rest");
    expect(seatedAnim({ ...base, duty: "working", nested: true, swap: true })).toBe("sit_rest");
    expect(seatedAnim({ ...base, duty: "working", nested: true })).toBe("sit_type");
    expect(seatedAnim({ ...base, duty: "idle", idle: "fresh" })).toBe("coffee_idle");
    expect(seatedAnim({ ...base, duty: "idle", idle: "sleep" })).toBe("doze");
  });

  it("walks with the sprite direction of each step", () => {
    expect(walkDirection(10, 0, -1)).toBe("SE");
    expect(walkDirection(-10, 0, 1)).toBe("SW");
    expect(walkDirection(0, -10, 1)).toBe("NE");
    expect(walkDirection(0, -10, -1)).toBe("NW");
    expect(walkDirection(0, 10, -1)).toBe("SW");
  });

  it("keeps the treadmill, toilet and slacking desk exclusive", () => {
    const busy = { slacking: true, treadmill: true, toilet: true, hasTalkTarget: false };
    expect(idleCandidates(busy, null).toSorted()).toEqual(["coffee", "sleep"]);
    for (let i = 0; i < 20; i += 1) {
      expect(["coffee", "sleep"]).toContain(pickIdleActivity(() => i / 20, busy, null));
    }
    const free = { slacking: false, treadmill: false, toilet: false, hasTalkTarget: true };
    expect(idleCandidates(free, "talk")).not.toContain("talk");
  });

  it("never leaves with four or fewer on stage", () => {
    expect(shouldLeave(4, () => 0)).toBe(false);
    expect(shouldLeave(5, () => 0.4)).toBe(true);
    expect(shouldLeave(5, () => 0.6)).toBe(false);
    expect(standbySeconds(() => 0)).toBe(10);
    expect(standbySeconds(() => 1)).toBe(30);
  });
});
