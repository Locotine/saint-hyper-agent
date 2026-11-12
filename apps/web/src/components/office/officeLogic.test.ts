import type { ThreadId } from "@saint/contracts";
import { describe, expect, it } from "vitest";

import { findPath } from "./astar";
import {
  ANIMS,
  agentColors,
  dutyAction,
  hueDistance,
  idleCandidates,
  phaseFrames,
  pickIdleActivity,
  shouldLeave,
  standbySeconds,
} from "./officeBehavior.logic";
import { officeFitBoost, officeLayout } from "./officeLayout.logic";
import {
  assignOfficeDesks,
  deriveDuty,
  monitorColor,
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

describe("assignOfficeDesks", () => {
  it("seats a coordinator at the supervisor desk and everyone else, without a cap", () => {
    const result = assignOfficeDesks({
      threads: [
        thread("quiet"),
        running("busy"),
        running("needs", { hasPendingApprovals: true }),
        thread("coord"),
        ...["a", "b", "c", "d", "e", "f"].map((id) => running(id)),
      ],
      coordinatorThreadIds: new Set(["coord"]),
      previous: [],
      now: NOW,
    });
    expect(result.desks[0]).toBe("coord");
    expect(result.desks[1]).toBe("needs");
    expect(result.desks).toHaveLength(10);
    expect(result.desks.at(-1)).toBe("quiet");
  });

  it("uses a parent with a live subagent as supervisor when no coordinator exists", () => {
    const result = assignOfficeDesks({
      threads: [thread("parent"), running("child", { parentThreadId: "parent" as ThreadId })],
      coordinatorThreadIds: new Set(),
      previous: [],
      now: NOW,
    });
    expect(result.desks).toEqual(["parent", "child"]);
  });

  it("keeps threads at their desks, fills gaps, and drops stale threads", () => {
    const stale = thread("stale", {
      updatedAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
      createdAt: new Date(NOW - 3 * 60 * 60_000).toISOString(),
    });
    const result = assignOfficeDesks({
      threads: [stale, running("a"), running("c")],
      coordinatorThreadIds: new Set(),
      previous: [null, "gone" as ThreadId, null, "c" as ThreadId],
      now: NOW,
    });
    expect(result.desks).toEqual([null, "a", null, "c"]);
  });
});

describe("officeLayout", () => {
  it.each([1, 6, 7, 13])("fits %i desks and reaches every seat from the door", (count) => {
    const layout = officeLayout(count);
    expect(layout.desks.length).toBeGreaterThanOrEqual(count);
    expect(layout.cols).toBe(17);
    expect(layout.rows).toBe(count <= 6 ? 14 : 14 + 4 * Math.ceil((count - 6) / 2));
    for (const slot of layout.desks) {
      expect(slot.stand.c).toBe(slot.seat.c - slot.facing);
      expect(layout.isBlocked(slot.stand.c, slot.stand.r)).toBe(false);
      const path = findPath(
        layout.cols,
        layout.rows,
        layout.isBlocked,
        layout.spots.door,
        slot.stand,
      );
      expect(path).not.toBeNull();
    }
    for (const spot of [layout.spots.water, layout.spots.treadmill, layout.spots.toilet]) {
      expect(
        findPath(layout.cols, layout.rows, layout.isBlocked, layout.spots.door, spot),
      ).not.toBeNull();
    }
  });

  it("faces the left column right and the right column left", () => {
    const [left, right] = officeLayout(2).desks;
    expect(left?.facing).toBe(1);
    expect(right?.facing).toBe(-1);
    expect(left?.boss).toBe(true);
  });

  it("eases the first-fit zoom from 1.1 to 1", () => {
    expect(officeFitBoost(0)).toBeCloseTo(1.1);
    expect(officeFitBoost(1)).toBeCloseTo(1);
    expect(officeFitBoost(0.5)).toBeCloseTo(1.05);
  });
});

describe("animation segments", () => {
  it("splits enter, loop and exit like Marvis", () => {
    expect(phaseFrames("standby", "enter")).toHaveLength(18);
    expect(phaseFrames("standby", "loop")[0]).toBe(18);
    expect(phaseFrames("sleeping", "loop")).toHaveLength(47);
    expect(phaseFrames("sleeping", "exit")).toEqual(Array.from({ length: 19 }, (_, i) => 47 + i));
    expect(phaseFrames("pooping", "exit")[0]).toBe(65);
    expect(phaseFrames("running_treadmill", "enter")).toHaveLength(27);
    expect(ANIMS.working.frames).toBe(67);
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

  it("gives each thread stable colours with horn and scarf hues apart", () => {
    const a = agentColors("thread-a");
    expect(agentColors("thread-a")).toEqual(a);
    expect(agentColors("thread-b").scarf).not.toBe(a.scarf);
    for (const id of ["x", "y", "z", "a-long-thread-id", "0"]) {
      const colors = agentColors(id);
      expect(hueDistance(colors.scarfHue, colors.hornHue)).toBeGreaterThanOrEqual(30);
    }
  });

  it("maps duty onto monitor colour", () => {
    expect(monitorColor("working")).not.toBe(monitorColor(null));
  });
});
