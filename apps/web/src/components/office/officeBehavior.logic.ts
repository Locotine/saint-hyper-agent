// FILE: officeBehavior.logic.ts
// Purpose: Pure behaviour rules for office characters: atlas animation names and rates, walk
//          direction, the action a duty change triggers, and idle decisions. Timings follow Marvis.
// Layer: Web office logic (pure)
// Exports: animation names, animFps, walkDirection, dutyAction, pickIdleActivity, shouldLeave, constants

import type { DutyState } from "./officeModel.logic";

/** The ticker runs at up to 60fps; sprite animations step at their own rate. */
export const RENDER_FPS = 60;
export const HIDDEN_FPS = 10;
export const DEEP_HIDDEN_FPS = 2;
/** Walking speed in world px per second (two tiles). */
export const WALK_SPEED = 128;
export const IDLE_ACTION_SEC = 180;
export const STANDBY_MIN_SEC = 10;
export const STANDBY_MAX_SEC = 30;
export const HOVER_STARTLE_SEC = 0.5;
export const SPEECH_SEC = 3;
/** A finished agent sips coffee at its desk this long, then dozes off. */
export const JUST_FINISHED_SEC = 30;
/** Nested supervisors swap between typing and watching their team this often. */
export const SUPERVISOR_SWAP_SEC = 4;
/** Idle characters may leave only while more than this many are on stage. */
export const MIN_ON_STAGE = 4;

/** Directions baked into the skin atlases: S* face the viewer, N* show the back. */
export type OfficeDirection = "SE" | "SW" | "NE" | "NW";

/** Animation names in the skin atlases (`<direction>/<anim>`). */
export type OfficeAnim =
  | "idle"
  | "walk"
  | "sit_type"
  | "sit_rest"
  | "doze"
  | "coffee_idle"
  | "coffee_walk"
  | "lift_weights"
  | "beanbag_game"
  | "chat"
  | "alert"
  | "carry_report"
  | "celebrate";

export const OFFICE_ANIMS: readonly OfficeAnim[] = [
  "idle",
  "walk",
  "sit_type",
  "sit_rest",
  "doze",
  "coffee_idle",
  "coffee_walk",
  "lift_weights",
  "beanbag_game",
  "chat",
  "alert",
  "carry_report",
  "celebrate",
];

export const OFFICE_DIRECTIONS: readonly OfficeDirection[] = ["SE", "SW", "NE", "NW"];

/** Frames per second per animation; walking matches WALK_SPEED, resting poses breathe slowly. */
export function animFps(anim: OfficeAnim): number {
  switch (anim) {
    case "walk":
    case "coffee_walk":
    case "carry_report":
      return 10;
    case "lift_weights":
      return 9;
    case "sit_rest":
    case "doze":
      return 2;
    case "idle":
    case "coffee_idle":
      return 4;
    default:
      return 6;
  }
}

/** Walk direction for a step; vertical-only steps keep the horizontal facing. */
export function walkDirection(dx: number, dy: number, facing: 1 | -1): OfficeDirection {
  const right = Math.abs(dx) > 0.5 ? dx > 0 : facing === 1;
  const up = dy < -0.5 && Math.abs(dy) > Math.abs(dx);
  if (up) return right ? "NE" : "NW";
  return right ? "SE" : "SW";
}

export type OfficeAction =
  | "DISPATCH"
  | "START"
  | "SUB_START"
  | "ATTENTION"
  | "COMPLETE"
  | "ERROR"
  | "IDLE";

/**
 * What a character does when its thread's duty changes. `previous` is undefined for a thread
 * that just appeared; `isSubagent` threads hand over at their parent's desk before working.
 */
export function dutyAction(
  previous: DutyState | undefined,
  next: DutyState,
  isSubagent: boolean,
): OfficeAction | null {
  if (previous === next) return null;
  if (previous === undefined) return "DISPATCH";
  switch (next) {
    case "working":
      return isSubagent && previous === "idle" ? "SUB_START" : "START";
    case "approval":
    case "input":
      return "ATTENTION";
    case "error":
      return "ERROR";
    case "idle":
      return previous === "working" ? "COMPLETE" : "IDLE";
  }
}

export type IdleActivity = "slacking" | "talk" | "treadmill" | "toilet" | "sleep" | "coffee";

export interface IdleOccupancy {
  readonly slacking: boolean;
  readonly treadmill: boolean;
  readonly toilet: boolean;
  readonly hasTalkTarget: boolean;
}

/** Candidates exclude taken exclusive spots; `previous` is not repeated when others exist. */
export function idleCandidates(
  occupancy: IdleOccupancy,
  previous: IdleActivity | null,
): IdleActivity[] {
  const all: IdleActivity[] = ["sleep", "coffee"];
  if (!occupancy.slacking) all.push("slacking");
  if (occupancy.hasTalkTarget) all.push("talk");
  if (!occupancy.treadmill) all.push("treadmill");
  if (!occupancy.toilet) all.push("toilet");
  const fresh = all.filter((activity) => activity !== previous);
  return fresh.length > 0 ? fresh : all;
}

export function pickIdleActivity(
  random: () => number,
  occupancy: IdleOccupancy,
  previous: IdleActivity | null,
): IdleActivity {
  const candidates = idleCandidates(occupancy, previous);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
}

export function standbySeconds(random: () => number): number {
  return STANDBY_MIN_SEC + random() * (STANDBY_MAX_SEC - STANDBY_MIN_SEC);
}

/** Above four on stage, an idle character leaves half the time; never below four. */
export function shouldLeave(onStage: number, random: () => number): boolean {
  return onStage > MIN_ON_STAGE && random() < 0.5;
}

/** What an agent at its desk is doing when idle: fresh off a turn, dozing, or playing games. */
export type DeskIdle = "fresh" | "sleep" | "slacking";

/**
 * Seated animation (always seen from behind, NW). Supervisors with working children watch
 * them (`sit_rest`); nested supervisors alternate between watching and typing (`swap`).
 */
export function seatedAnim(input: {
  readonly duty: DutyState;
  readonly nested: boolean;
  readonly hasWorkingChildren: boolean;
  readonly swap: boolean;
  readonly idle: DeskIdle | null;
}): OfficeAnim {
  if (input.idle === "slacking") return "sit_type";
  switch (input.duty) {
    case "working":
      if (input.nested) return input.swap ? "sit_rest" : "sit_type";
      return input.hasWorkingChildren ? "sit_rest" : "sit_type";
    case "approval":
    case "input":
      return input.hasWorkingChildren ? "sit_type" : "sit_rest";
    case "error":
      return "sit_rest";
    case "idle":
      return input.idle === "fresh" ? "coffee_idle" : "doze";
  }
}
