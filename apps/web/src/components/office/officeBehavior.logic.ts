// FILE: officeBehavior.logic.ts
// Purpose: Pure behaviour rules for office characters: animation segments, the action a duty
//          change triggers, idle decisions, and per-thread colours. Timings follow Marvis.
// Layer: Web office logic (pure)
// Exports: animation table, dutyAction, pickIdleActivity, shouldLeave, agentColors, constants

import type { DutyState } from "./officeModel.logic";

/** Sprite animation rate; the ticker itself runs at up to 60fps. */
export const ANIM_FPS = 24;
export const RENDER_FPS = 60;
export const HIDDEN_FPS = 10;
export const DEEP_HIDDEN_FPS = 2;
/** Walking speed in world px per second (two tiles). */
export const WALK_SPEED = 128;
export const CAT_SPEED = 32;
export const CAT_FLEE_MULTIPLIER = 4;
export const CAT_FLEE_RADIUS = 32;
export const CAT_LIFETIME_SEC = 180;
export const IDLE_ACTION_SEC = 180;
export const STANDBY_MIN_SEC = 10;
export const STANDBY_MAX_SEC = 30;
export const HOVER_STARTLE_SEC = 0.5;
export const SPEECH_SEC = 3;
/** Idle characters may leave only while more than this many are on stage. */
export const MIN_ON_STAGE = 4;

export type OfficeAnim =
  | "walking_h"
  | "walking_up"
  | "standby"
  | "working"
  | "off_chair"
  | "on_chair"
  | "sigh"
  | "high_press"
  | "peek"
  | "drink_coffee"
  | "sleeping"
  | "running_treadmill"
  | "pooping"
  | "talking_on_seat"
  | "talking_on_stand"
  | "cheer_main"
  | "cheer1_sub"
  | "cheer2_sub"
  | "salute"
  | "sorry"
  | "fall_down"
  | "leaving"
  | "ticket";

export interface AnimSpec {
  readonly frames: number;
  /** Frames [0, enterEnd) play once before the loop. */
  readonly enterEnd?: number;
  /** Frames [loopEnd, frames) are the exit; absent means the exit is the enter reversed. */
  readonly loopEnd?: number;
  /** Characters in this animation sit on their chair. */
  readonly seated?: boolean;
}

export const ANIMS: Readonly<Record<OfficeAnim, AnimSpec>> = {
  walking_h: { frames: 16 },
  walking_up: { frames: 16 },
  standby: { frames: 40, enterEnd: 18 },
  working: { frames: 67, seated: true },
  off_chair: { frames: 20 },
  on_chair: { frames: 20 },
  sigh: { frames: 36, seated: true },
  high_press: { frames: 48, seated: true },
  peek: { frames: 30 },
  drink_coffee: { frames: 72 },
  sleeping: { frames: 66, loopEnd: 47, seated: true },
  running_treadmill: { frames: 51, enterEnd: 27 },
  pooping: { frames: 90, enterEnd: 66 },
  talking_on_seat: { frames: 48, seated: true },
  talking_on_stand: { frames: 48 },
  cheer_main: { frames: 48 },
  cheer1_sub: { frames: 40 },
  cheer2_sub: { frames: 40 },
  salute: { frames: 36 },
  sorry: { frames: 40 },
  fall_down: { frames: 48 },
  leaving: { frames: 24 },
  ticket: { frames: 36 },
};

export type AnimPhase = "enter" | "loop" | "exit";

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

/** Frame indices of one phase of an animation; empty when the phase does not exist. */
export function phaseFrames(anim: OfficeAnim, phase: AnimPhase): number[] {
  const spec = ANIMS[anim];
  const loopStart = spec.enterEnd ?? 0;
  const loopEnd = spec.loopEnd ?? spec.frames;
  switch (phase) {
    case "enter":
      return range(0, loopStart);
    case "loop":
      return range(loopStart, loopEnd);
    case "exit":
      if (spec.loopEnd !== undefined) return range(spec.loopEnd, spec.frames);
      return range(0, loopStart).toReversed();
  }
}

/** Coffee cup overlay visibility per drink_coffee frame. */
export function coffeeCupVisible(frame: number): boolean {
  return (frame >= 5 && frame < 27) || frame >= 65;
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

function hashString(text: string): number {
  // FNV-1a
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // murmur3 fmix32: ids that differ only in the last character must still land far apart.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function hslToHex(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

/** Stable random horn and scarf colours per thread; hues at least 30 degrees apart. */
export function agentColors(threadId: string): {
  readonly scarf: number;
  readonly horn: number;
  readonly scarfHue: number;
  readonly hornHue: number;
} {
  const hash = hashString(threadId);
  const scarfHue = hash % 360;
  const hornHue = (scarfHue + 30 + ((hash >>> 9) % 300)) % 360;
  return {
    scarfHue,
    hornHue,
    scarf: hslToHex(scarfHue, 0.72, 0.52),
    horn: hslToHex(hornHue, 0.55, 0.82),
  };
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
