// FILE: officeModel.logic.ts
// Purpose: Maps Saint threads (any provider) onto office characters: a root supervisor desk,
//          nested supervisor desks, specialist desks, duty per thread, and the sprite names
//          (skin, desk, chair, monitor, badge, bubble) each one wears. Names come from palette.json.
// Layer: Web office logic (pure)
// Exports: desk assignment, tiers, duty, provider/skin mapping, sprite name helpers

import type { ProviderKind, ThreadId } from "@saint/contracts";

import palette from "../../../../../assets/buffalo_mascot_pack/palette.json";
import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import type { SidebarThreadSummary } from "~/types";

export { palette };

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
  | "subagentRole"
  | "subagentNickname"
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

/** When the latest turn ended (epoch ms), or null while it runs or when there is none. */
export function threadFinishedMs(thread: OfficeThread): number | null {
  return parseTime(thread.latestTurn?.completedAt) || null;
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

// ---- tiers and desks ------------------------------------------------------------------------

export type OfficeTier = "root" | "nested" | "leaf";

export interface OfficeAssignment {
  /** The root supervisor, or null when no thread qualifies (its desk stays empty). */
  readonly root: ThreadId | null;
  /** Nested supervisors in seat order. */
  readonly nested: readonly ThreadId[];
  /** Specialist desks; null is a free desk. The length grows with the thread count. */
  readonly leaves: readonly (ThreadId | null)[];
}

export const EMPTY_ASSIGNMENT: OfficeAssignment = { root: null, nested: [], leaves: [] };

/**
 * Seats every live or recently active thread.
 * - root: no parent, and a coordinator or a parent of a seated thread (live children first);
 * - nested: has a parent and a live (non-idle) child, so it demotes once its last child is done;
 * - leaf: everyone else.
 * Threads keep their desk across updates; newcomers take the lowest free desk; trailing empty
 * specialist desks are dropped.
 */
export function assignOfficeDesks(input: {
  readonly threads: readonly OfficeThread[];
  readonly coordinatorThreadIds: ReadonlySet<string>;
  readonly previous: OfficeAssignment;
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

  const parentIds = new Set<string>();
  const liveParentIds = new Set<string>();
  for (const { thread, duty } of ranked) {
    if (!thread.parentThreadId) continue;
    parentIds.add(thread.parentThreadId);
    if (duty !== "idle") liveParentIds.add(thread.parentThreadId);
  }

  const topLevel = ranked.filter(({ thread }) => !thread.parentThreadId);
  const root =
    topLevel.find(({ thread }) => input.coordinatorThreadIds.has(thread.id)) ??
    topLevel.find(({ thread }) => liveParentIds.has(thread.id)) ??
    topLevel.find(({ thread }) => parentIds.has(thread.id)) ??
    null;
  const rootId = root?.thread.id ?? null;

  const nestedNow = new Set(
    ranked
      .filter(({ thread }) => thread.parentThreadId && liveParentIds.has(thread.id))
      .map(({ thread }) => thread.id),
  );
  const nested = input.previous.nested.filter((id) => nestedNow.has(id));
  for (const id of nestedNow) if (!nested.includes(id)) nested.push(id);

  const chosen = new Set(
    ranked.map(({ thread }) => thread.id).filter((id) => id !== rootId && !nestedNow.has(id)),
  );
  const leaves: (ThreadId | null)[] = input.previous.leaves.map((kept) =>
    kept !== null && chosen.has(kept) ? kept : null,
  );
  for (const id of chosen) {
    if (leaves.includes(id)) continue;
    const free = leaves.indexOf(null);
    if (free === -1) leaves.push(id);
    else leaves[free] = id;
  }
  while (leaves.length > 0 && leaves[leaves.length - 1] === null) leaves.pop();
  return { root: rootId, nested, leaves };
}

// ---- providers and skins --------------------------------------------------------------------

export type OfficeProvider = keyof typeof palette.providers;
export type SkinId = keyof typeof palette.skins;

export const SKIN_IDS = Object.keys(palette.skins) as SkinId[];
export const ROOT_SKIN: SkinId = "skin_01_supervisor";
const WORKER_SKINS = SKIN_IDS.filter((skin) => skin !== ROOT_SKIN);

export function mapProvider(provider: ProviderKind | null | undefined): OfficeProvider {
  switch (provider) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "openai";
    case "antigravity":
      return "antigravity";
    default:
      return "local";
  }
}

export function providerColor(provider: ProviderKind | null | undefined): number {
  return Number.parseInt(palette.providers[mapProvider(provider)].color.slice(1), 16);
}

/** Keyword groups in priority order; the first group with a whole-word hit wins. */
export const SKIN_KEYWORDS: readonly (readonly [SkinId, readonly string[]])[] = [
  ["skin_06_search_agent", ["search", "explore", "research", "find", "grep", "lookup", "docs"]],
  ["skin_03_browser_agent", ["browser", "web", "url", "page", "scrape", "playwright", "e2e", "qa"]],
  [
    "skin_04_computer_agent",
    ["computer", "desktop", "shell", "terminal", "bash", "device", "simulator"],
  ],
  [
    "skin_05_app_agent",
    ["app", "ui", "ux", "frontend", "component", "design", "game", "css", "layout"],
  ],
  [
    "skin_02_file_agent",
    ["file", "edit", "write", "refactor", "fix", "code", "build", "implement", "review"],
  ],
];

const SKIN_PATTERNS = SKIN_KEYWORDS.map(
  ([skin, words]) =>
    [skin, new RegExp(`(?:^|[^a-z0-9])(?:${words.join("|")})(?![a-z0-9])`)] as const,
);

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

function skinFromText(text: string | null | undefined): SkinId | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  return SKIN_PATTERNS.find(([, pattern]) => pattern.test(lower))?.[0] ?? null;
}

const skinCache = new Map<string, SkinId>();

/**
 * Worker skin for a non-root thread: subagent role, then nickname, then title; falls back to a
 * stable hash of the id. Cached per thread id so a renamed thread keeps its look.
 */
export function inferAgentSkin(
  thread: Pick<OfficeThread, "id" | "title" | "subagentRole" | "subagentNickname">,
): SkinId {
  const cached = skinCache.get(thread.id);
  if (cached) return cached;
  const skin =
    skinFromText(thread.subagentRole) ??
    skinFromText(thread.subagentNickname) ??
    skinFromText(thread.title) ??
    WORKER_SKINS[hashString(thread.id) % WORKER_SKINS.length]!;
  skinCache.set(thread.id, skin);
  return skin;
}

/** Test hook: forget cached skins. */
export function clearSkinCache(): void {
  skinCache.clear();
}

// ---- sprite names ---------------------------------------------------------------------------

const HIERARCHY_KEY = {
  root: "root_supervisor",
  nested: "nested_supervisor",
  leaf: "leaf_worker",
} as const satisfies Record<OfficeTier, keyof typeof palette.hierarchy>;

export const DESK_VARIANTS = 5;

/** Desk, chair parts and badge for a tier; specialist desks cycle through five variants. */
export function deskSprites(
  tier: OfficeTier,
  variant = 0,
): {
  readonly desk: string;
  readonly seat: string;
  readonly backrest: string;
  readonly full: string;
  readonly badge: string | null;
} {
  const entry = palette.hierarchy[HIERARCHY_KEY[tier]];
  const desk =
    tier === "leaf"
      ? entry.desk.replace(/_\d\d\.png$/, `_0${(variant % DESK_VARIANTS) + 1}.png`)
      : entry.desk;
  return {
    desk,
    seat: `${entry.chair_prefix}_seat.png`,
    backrest: `${entry.chair_prefix}_backrest.png`,
    full: `${entry.chair_prefix}_full.png`,
    badge: entry.badge,
  };
}

export function providerIconSprite(provider: ProviderKind | null | undefined): string {
  return `ui/provider_${mapProvider(provider)}.png`;
}

/** Monitor screen per duty; app agents code on a green screen; away desks are dark. */
export function monitorSprite(duty: DutyState | null, skin: SkinId | null): string {
  switch (duty) {
    case "working":
      return skin === "skin_05_app_agent"
        ? "env/monitor_working_green.png"
        : "env/monitor_working.png";
    case "approval":
    case "input":
      return "env/monitor_pending.png";
    case "error":
      return "env/monitor_error.png";
    default:
      return "env/monitor_off.png";
  }
}

export type OfficeBubble = "typing" | "alert" | "question" | "done" | "zzz";

export const BUBBLE_SPRITES: Readonly<Record<Exclude<OfficeBubble, "typing">, string>> = {
  alert: "ui/bubble_alert.png",
  question: "ui/bubble_question.png",
  done: "ui/bubble_done_tick.png",
  zzz: "ui/bubble_zzz.png",
};
export const TYPING_BUBBLE_FRAMES = [
  "ui/bubble_typing_00.png",
  "ui/bubble_typing_01.png",
  "ui/bubble_typing_02.png",
] as const;

/**
 * Status bubbles over a seated agent. A supervisor waiting on an approval while its children
 * work shows both the typing pill and the question. Idle bubbles (done tick, zzz) depend on how
 * long the agent has been idle, which the renderer tracks.
 */
export function statusBubbles(
  duty: DutyState,
  hasWorkingChildren: boolean,
): readonly OfficeBubble[] {
  switch (duty) {
    case "working":
      return ["typing"];
    case "approval":
    case "input":
      return hasWorkingChildren ? ["typing", "question"] : ["question"];
    case "error":
      return ["alert"];
    case "idle":
      return [];
  }
}
