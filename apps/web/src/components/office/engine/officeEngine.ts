// FILE: officeEngine.ts
// Purpose: Pixi.js v8 virtual office modelled on Marvis, drawn with the buffalo asset pack v2:
//          thread characters walk the floor plan, sit at their desks with their backs to the
//          viewer, work, hand reports to their supervisor, and pass idle time at the coffee
//          bar, treadmill or WC. Dashed floor lines link parents to their children's desks.
//          Behaviour runs as cancellable async scripts.
// Layer: Web office renderer (imperative; React mounts it through OfficeCanvas)
// Exports: createOfficeEngine, OfficeEngine, OfficeEngineAgent, OfficeEngineState

import type { ProviderKind, ThreadId } from "@saint/contracts";
import { Application, Container, Graphics, type Ticker } from "pixi.js";

import { findPath, type TilePoint } from "../astar";
import {
  DEEP_HIDDEN_FPS,
  HIDDEN_FPS,
  HOVER_STARTLE_SEC,
  IDLE_ACTION_SEC,
  JUST_FINISHED_SEC,
  RENDER_FPS,
  SPEECH_SEC,
  SUPERVISOR_SWAP_SEC,
  dutyAction,
  pickIdleActivity,
  seatedAnim,
  shouldLeave,
  standbySeconds,
  type DeskIdle,
  type IdleActivity,
  type OfficeAction,
  type OfficeAnim,
} from "../officeBehavior.logic";
import {
  TILE,
  cellCenter,
  officeFitBoost,
  officeLayout,
  seatPoint,
  type DeskSlot,
  type OfficeLayout,
  type Point,
} from "../officeLayout.logic";
import {
  deskSprites,
  monitorSprite,
  providerColor,
  providerIconSprite,
  statusBubbles,
  type DutyState,
  type OfficeBubble,
  type OfficeTier,
  type SkinId,
} from "../officeModel.logic";
import type { DemoActivity } from "../officeMock";
import { Character, FEET_OFFSET } from "./character";
import { DESK_LAYER, buildFurniture, type DeskHandle, type FurnitureSet } from "./furniture";
import { loadOfficeAssets } from "./officeAssets";

export interface OfficeEngineAgent {
  readonly threadId: ThreadId;
  /**
   * Index into the layout's desks: 0 root, then nested supervisors, then specialists. Null for
   * an agent without a desk (mock agents pinned at an amenity).
   */
  readonly desk: number | null;
  readonly tier: OfficeTier;
  readonly skin: SkinId;
  readonly provider: ProviderKind | null;
  readonly label: string;
  readonly duty: DutyState;
  readonly speech: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly hasWorkingChildren: boolean;
  /** When the latest turn ended (epoch ms). */
  readonly finishedAt: number | null;
  /** Mock demo only: keeps the agent at one idle activity. */
  readonly demoActivity?: DemoActivity;
}

export interface OfficeEngineState {
  readonly agents: readonly OfficeEngineAgent[];
  readonly selectedThreadId: ThreadId | null;
  readonly layout: { readonly nested: number; readonly leaves: number };
}

export interface OfficeEngine {
  readonly update: (state: OfficeEngineState) => void;
  readonly destroy: () => void;
}

export const OFFICE_BACKGROUND = 0xf7f7f7;
const FIT_SETTLE_SEC = 0.6;
/** World px kept free above the top row for nameplates and bubbles. */
const FIT_TOP_PAD = 48;
const LINK_ALPHA = 0.85;
const LINK_DIM_ALPHA = 0.45;
const LINK_DASH = 6;
const LINK_GAP = 5;
/** Line ends: the parent's chair foot and the child's desk top edge, relative to desk anchors. */
const LINK_FROM_DY = 34;
const LINK_TO_DY = -30;
const REPORT_SEC = 2;
const COFFEE_SEC = 6;

class Superseded extends Error {}

type Step = <T>(p: Promise<T>) => Promise<T>;

interface AgentRuntime {
  data: OfficeEngineAgent;
  readonly char: Character;
  /** Bumped by every new script; older scripts stop at their next await. */
  generation: number;
  onStage: boolean;
  lastIdle: IdleActivity | null;
  /** Idle state at the desk; null while working or away from it. */
  deskIdle: DeskIdle | null;
  /** Nested supervisors alternate poses. */
  swap: boolean;
  hoverFor: number | null;
  removed: boolean;
}

function readLabelStyle(): { fontFamily: string; fontSize: number } {
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--app-font-size-ui-xs")) || 11;
  return { fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif", fontSize: size };
}

function feetAt(cell: TilePoint): Point {
  const center = cellCenter(cell);
  return { x: center.x, y: center.y + FEET_OFFSET };
}

function cellAt(x: number, y: number): TilePoint {
  return { c: Math.floor(x / TILE), r: Math.floor((y - FEET_OFFSET) / TILE) };
}

function seatKey(slot: DeskSlot | undefined): string {
  return slot ? `${slot.anchor.x},${slot.anchor.y},${slot.tier}` : "";
}

/** Dashed cubic Bezier with vertical tangents, sampled into short strokes. */
function dashedCurve(g: Graphics, from: Point, to: Point): void {
  const dy = (to.y - from.y) / 2;
  const at = (t: number): Point => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * from.x + b * from.x + c * to.x + d * to.x,
      y: a * from.y + b * (from.y + dy) + c * (to.y - dy) + d * to.y,
    };
  };
  const samples = 64;
  let previous = at(0);
  let travelled = 0;
  for (let i = 1; i <= samples; i += 1) {
    const point = at(i / samples);
    const length = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (travelled % (LINK_DASH + LINK_GAP) < LINK_DASH) {
      g.moveTo(previous.x, previous.y).lineTo(point.x, point.y);
    }
    travelled += length;
    previous = point;
  }
}

export async function createOfficeEngine(
  host: HTMLElement,
  options: { readonly onSelect: (threadId: ThreadId) => void },
): Promise<OfficeEngine> {
  const app = new Application();
  const [assets] = await Promise.all([
    loadOfficeAssets(),
    app.init({
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      background: OFFICE_BACKGROUND,
      preference: "webgl",
    }),
  ]);
  host.appendChild(app.canvas);
  app.ticker.maxFPS = RENDER_FPS;

  const labelStyle = readLabelStyle();
  const world = new Container();
  const links = new Graphics();
  const stage = new Container();
  stage.sortableChildren = true;
  const uiLayer = new Container();
  world.addChild(links, stage, uiLayer);
  app.stage.addChild(world);
  app.stage.eventMode = "static";

  let layout: OfficeLayout = officeLayout({ nested: 0, leaves: 0 });
  let layoutKey = "";
  let furniture: FurnitureSet | null = null;
  const agents = new Map<ThreadId, AgentRuntime>();
  let fitAge = 0;
  let zoom = 1;
  let hovered: ThreadId | null = null;
  let linksDirty = true;
  let destroyed = false;
  const occupied = {
    slacking: null as AgentRuntime | null,
    treadmill: null as AgentRuntime | null,
    toilet: null as AgentRuntime | null,
  };
  const timers: { at: number; resolve: () => void; owner: AgentRuntime }[] = [];
  let clock = 0;

  const deskOf = (runtime: AgentRuntime): DeskHandle | undefined =>
    runtime.data.desk === null ? undefined : furniture?.desks[runtime.data.desk];
  const slotOf = (runtime: AgentRuntime): DeskSlot | undefined =>
    runtime.data.desk === null ? undefined : layout.desks[runtime.data.desk];
  const occupantOf = (desk: number): AgentRuntime | undefined =>
    [...agents.values()].find((runtime) => runtime.data.desk === desk && !runtime.removed);

  const rebuildFurniture = () => {
    // Seated characters live inside desk groups; lift them out before the groups go.
    for (const runtime of agents.values()) {
      if (runtime.char.container.parent !== stage) stage.addChild(runtime.char.container);
      runtime.char.layerZ = null;
    }
    if (furniture) for (const piece of furniture.pieces) piece.destroy({ children: true });
    furniture = buildFurniture(layout, assets);
    for (const piece of furniture.pieces) stage.addChild(piece);
    furniture.desks.forEach((desk, index) => {
      desk.hit.on("pointertap", () => {
        const occupant = occupantOf(index);
        if (occupant) options.onSelect(occupant.data.threadId);
      });
      desk.hit.on("pointerover", () => setHovered(occupantOf(index)?.data.threadId ?? null));
      desk.hit.on("pointerout", () => setHovered(null));
    });
    furniture.setToiletBusy(occupied.toilet !== null);
    linksDirty = true;
  };

  const fit = () => {
    const w = app.screen.width;
    const h = app.screen.height;
    if (w <= 0 || h <= 0) return;
    const box = layout.content;
    const height = box.height + FIT_TOP_PAD;
    const base = Math.min(w / box.width, h / height);
    zoom = base * officeFitBoost(fitAge / FIT_SETTLE_SEC);
    world.scale.set(zoom);
    world.position.set(
      (w - box.width * zoom) / 2 - box.x * zoom,
      (h - height * zoom) / 2 + (FIT_TOP_PAD - box.y) * zoom,
    );
    for (const runtime of agents.values()) runtime.char.setUiScale(1 / zoom);
  };

  const setHovered = (threadId: ThreadId | null) => {
    if (hovered === threadId) return;
    hovered = threadId;
    linksDirty = true;
  };

  // ---- presentation ---------------------------------------------------------------------

  const hasChildren = (threadId: ThreadId) =>
    [...agents.values()].some((runtime) => runtime.data.parentThreadId === threadId);

  /** The hovered parent and every descendant below it. */
  const branchOf = (threadId: ThreadId | null): Set<ThreadId> => {
    const branch = new Set<ThreadId>();
    if (!threadId || !hasChildren(threadId)) return branch;
    const queue = [threadId];
    while (queue.length > 0) {
      const id = queue.pop()!;
      branch.add(id);
      for (const runtime of agents.values()) {
        if (runtime.data.parentThreadId === id && !branch.has(runtime.data.threadId)) {
          queue.push(runtime.data.threadId);
        }
      }
    }
    return branch;
  };

  const drawLinks = () => {
    linksDirty = false;
    links.clear();
    const branch = branchOf(hovered);
    for (const child of agents.values()) {
      const parentId = child.data.parentThreadId;
      const parent = parentId ? agents.get(parentId) : undefined;
      if (!parent || parent.removed || child.removed) continue;
      const from = slotOf(parent)?.anchor;
      const to = slotOf(child)?.anchor;
      if (!from || !to) continue;
      const lit = branch.size === 0 || branch.has(parent.data.threadId);
      dashedCurve(
        links,
        { x: from.x, y: from.y + LINK_FROM_DY },
        { x: to.x, y: to.y + LINK_TO_DY },
      );
      links.stroke({
        color: providerColor(parent.data.provider),
        width: branch.has(parent.data.threadId) ? 2.5 : 1.5,
        alpha: lit ? LINK_ALPHA : LINK_DIM_ALPHA,
        cap: "round",
      });
    }
  };

  const bubblesFor = (runtime: AgentRuntime): readonly OfficeBubble[] => {
    const { duty, hasWorkingChildren } = runtime.data;
    if (duty !== "idle") return statusBubbles(duty, hasWorkingChildren);
    if (!runtime.char.seated) return [];
    if (runtime.deskIdle === "fresh") return ["done"];
    if (runtime.deskIdle === "sleep") return ["zzz"];
    return [];
  };

  const monitorFor = (runtime: AgentRuntime): string => {
    const { duty, skin } = runtime.data;
    if (!runtime.onStage) return monitorSprite(null, skin);
    if (runtime.deskIdle === "slacking") return "env/monitor_working_green.png";
    if (runtime.char.seated) return monitorSprite(duty === "idle" ? "working" : duty, skin);
    return monitorSprite(duty === "idle" ? null : duty, skin);
  };

  /** Syncs the desk, bubbles and (when settled at the desk) the seated pose. */
  const refresh = (runtime: AgentRuntime) => {
    if (runtime.removed) return;
    const desk = deskOf(runtime);
    if (desk && occupantOf(desk.slot.index) === runtime) {
      desk.setState(runtime.char.seated, monitorFor(runtime));
    }
    runtime.char.setBubbles(bubblesFor(runtime));
    if (runtime.char.seated && !runtime.char.walking) {
      const anim = seatedAnim({
        duty: runtime.data.duty,
        nested: runtime.data.tier === "nested",
        hasWorkingChildren: runtime.data.hasWorkingChildren,
        swap: runtime.swap,
        idle: runtime.deskIdle,
      });
      if (runtime.char.anim !== anim) runtime.char.playLoop("NW", anim);
    }
  };

  const setLabel = (runtime: AgentRuntime) => {
    const { data } = runtime;
    runtime.char.setLabel(
      data.label,
      providerIconSprite(data.provider),
      deskSprites(data.tier).badge,
    );
    runtime.char.setSkin(data.skin);
  };

  // ---- script helpers -------------------------------------------------------------------

  const guard = (runtime: AgentRuntime, generation: number) => {
    if (destroyed || runtime.generation !== generation) throw new Superseded();
  };

  const wait = (runtime: AgentRuntime, seconds: number) =>
    new Promise<void>((resolve) => timers.push({ at: clock + seconds, resolve, owner: runtime }));

  const releaseSpots = (runtime: AgentRuntime) => {
    if (occupied.slacking === runtime) occupied.slacking = null;
    if (occupied.treadmill === runtime) occupied.treadmill = null;
    if (occupied.toilet === runtime) {
      occupied.toilet = null;
      furniture?.setToiletBusy(false);
    }
  };

  const startScript = (runtime: AgentRuntime, script: (step: Step) => Promise<void>) => {
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.char.interrupt();
    // Wake the previous script's timers so it can exit.
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i]!.owner === runtime) timers.splice(i, 1)[0]!.resolve();
    }
    releaseSpots(runtime);
    runtime.deskIdle = null;
    const step: Step = async (p) => {
      guard(runtime, generation);
      const value = await p;
      guard(runtime, generation);
      return value;
    };
    void script(step).catch((cause: unknown) => {
      if (!(cause instanceof Superseded)) console.error("[office] behaviour script failed", cause);
    });
  };

  const standUp = async (runtime: AgentRuntime, step: Step) => {
    const { char } = runtime;
    if (!char.seated) return;
    stage.addChild(char.container);
    char.layerZ = null;
    char.seated = false;
    refresh(runtime);
    const slot = slotOf(runtime);
    await step(char.walk(slot ? [feetAt(slot.stand)] : []));
  };

  const walkTo = async (
    runtime: AgentRuntime,
    step: Step,
    goal: TilePoint,
    anim: OfficeAnim = "walk",
    finish?: Point,
  ) => {
    await standUp(runtime, step);
    const { char } = runtime;
    const start = cellAt(char.x, char.y);
    const path = findPath(layout.cols, layout.rows, layout.isBlocked, start, goal) ?? [start, goal];
    const points = path.slice(1).map(feetAt);
    // Re-centre on the start tile first when standing off-grid.
    const startFeet = feetAt(start);
    if (Math.hypot(startFeet.x - char.x, startFeet.y - char.y) > 1) points.unshift(startFeet);
    if (finish) points.push(finish);
    await step(char.walk(points, anim));
  };

  const seatInto = (runtime: AgentRuntime) => {
    const desk = deskOf(runtime);
    if (!desk) return;
    const { char } = runtime;
    desk.group.addChild(char.container);
    char.layerZ = DESK_LAYER.buffalo;
    char.seated = true;
    char.place(seatPoint(desk.slot));
  };

  const sitDown = async (runtime: AgentRuntime, step: Step, anim: OfficeAnim = "walk") => {
    const slot = slotOf(runtime);
    if (runtime.char.seated || !slot) return;
    await walkTo(runtime, step, slot.stand, anim, seatPoint(slot));
    seatInto(runtime);
    refresh(runtime);
  };

  const enterStage = (runtime: AgentRuntime) => {
    if (runtime.onStage) return;
    runtime.onStage = true;
    runtime.char.container.visible = true;
    runtime.char.overlay.visible = true;
    runtime.char.seated = false;
    runtime.char.place(feetAt(layout.spots.door));
  };

  const leaveStage = async (runtime: AgentRuntime, step: Step) => {
    await walkTo(runtime, step, layout.spots.door);
    runtime.onStage = false;
    runtime.char.container.visible = false;
    runtime.char.overlay.visible = false;
    refresh(runtime);
  };

  const onStageCount = () => [...agents.values()].filter((a) => a.onStage && !a.removed).length;

  // ---- behaviours -----------------------------------------------------------------------

  /** Sits down and keeps the seated pose; nested supervisors keep swapping poses. */
  const workAtDesk = async (runtime: AgentRuntime, step: Step) => {
    await sitDown(runtime, step);
    refresh(runtime);
    while (runtime.data.tier === "nested" && runtime.data.duty === "working") {
      await step(wait(runtime, SUPERVISOR_SWAP_SEC));
      runtime.swap = !runtime.swap;
      refresh(runtime);
    }
  };

  const runAction = (runtime: AgentRuntime, action: OfficeAction) => {
    startScript(runtime, async (step) => {
      enterStage(runtime);
      const { char } = runtime;
      refresh(runtime);
      switch (action) {
        case "DISPATCH":
          return dutyScript(runtime, step);
        case "SUB_START": {
          const parent = runtime.data.parentThreadId
            ? agents.get(runtime.data.parentThreadId)
            : undefined;
          const parentSlot = parent?.onStage ? slotOf(parent) : undefined;
          if (parentSlot) {
            await walkTo(runtime, step, parentSlot.stand);
            char.playLoop("NW", "chat");
            char.speak("Nhận việc!", SPEECH_SEC);
            await step(wait(runtime, SPEECH_SEC));
          }
          return workAtDesk(runtime, step);
        }
        case "COMPLETE": {
          const parent = runtime.data.parentThreadId
            ? agents.get(runtime.data.parentThreadId)
            : undefined;
          const parentSlot = parent?.onStage ? slotOf(parent) : undefined;
          if (!parentSlot) return idleScript(runtime, step);
          // A finished subagent carries its report to the supervisor, then leaves.
          await walkTo(runtime, step, parentSlot.stand, "carry_report");
          char.playLoop("NW", "idle");
          await step(wait(runtime, REPORT_SEC));
          return leaveStage(runtime, step);
        }
        case "START":
        case "ATTENTION":
        case "ERROR":
          return workAtDesk(runtime, step);
        case "IDLE":
          return idleScript(runtime, step);
      }
    });
  };

  const dutyScript = (runtime: AgentRuntime, step: Step) =>
    runtime.data.duty === "idle" ? idleScript(runtime, step) : workAtDesk(runtime, step);

  const secondsSinceFinished = (runtime: AgentRuntime) =>
    runtime.data.finishedAt === null ? Infinity : (Date.now() - runtime.data.finishedAt) / 1000;

  const dozeAtDesk = async (runtime: AgentRuntime, step: Step, seconds: number) => {
    await sitDown(runtime, step);
    runtime.deskIdle = "sleep";
    refresh(runtime);
    await step(wait(runtime, seconds));
  };

  const idleScript = async (runtime: AgentRuntime, step: Step) => {
    const demo = runtime.data.demoActivity;
    if (demo) return demoScript(runtime, step, demo);
    const fresh = JUST_FINISHED_SEC - secondsSinceFinished(runtime);
    await sitDown(runtime, step);
    if (fresh > 0) {
      runtime.deskIdle = "fresh";
      refresh(runtime);
      await step(wait(runtime, fresh));
    }
    await dozeAtDesk(runtime, step, IDLE_ACTION_SEC);
    for (;;) {
      if (shouldLeave(onStageCount(), Math.random)) return leaveStage(runtime, step);
      const talkTargets = [...agents.values()].filter(
        (a) => a !== runtime && a.onStage && !a.char.walking && !a.removed,
      );
      const activity = pickIdleActivity(
        Math.random,
        {
          slacking: occupied.slacking !== null,
          treadmill: occupied.treadmill !== null,
          toilet: occupied.toilet !== null,
          hasTalkTarget: talkTargets.length > 0,
        },
        runtime.lastIdle,
      );
      runtime.lastIdle = activity;
      await runIdleActivity(runtime, step, activity, talkTargets);
      await dozeAtDesk(runtime, step, standbySeconds(Math.random));
    }
  };

  /** Mock demo: holds one pose so the scene matches the reference image. */
  const demoScript = async (runtime: AgentRuntime, step: Step, demo: DemoActivity) => {
    switch (demo) {
      case "fresh":
      case "sleep":
      case "slacking":
        await sitDown(runtime, step);
        runtime.deskIdle = demo;
        refresh(runtime);
        return;
      case "coffee":
        await walkTo(runtime, step, layout.spots.coffee, "walk", layout.amenities.barista);
        runtime.char.playLoop("SW", "idle");
        return;
      default:
        for (;;) await runIdleActivity(runtime, step, demo, []);
    }
  };

  const runIdleActivity = async (
    runtime: AgentRuntime,
    step: Step,
    activity: IdleActivity,
    talkTargets: readonly AgentRuntime[],
  ) => {
    const { char } = runtime;
    const { spots, amenities } = layout;
    switch (activity) {
      case "slacking":
        occupied.slacking = runtime;
        await sitDown(runtime, step);
        runtime.deskIdle = "slacking";
        refresh(runtime);
        await step(wait(runtime, IDLE_ACTION_SEC));
        occupied.slacking = null;
        runtime.deskIdle = null;
        return;
      case "sleep":
        return dozeAtDesk(runtime, step, IDLE_ACTION_SEC);
      case "coffee":
        await walkTo(runtime, step, spots.coffee, "walk", amenities.barista);
        refresh(runtime);
        char.playLoop("SW", "idle");
        await step(wait(runtime, COFFEE_SEC));
        // Back to the desk with the cup, then sip it there.
        await step(char.walk([feetAt(spots.coffee)], "coffee_walk"));
        await sitDown(runtime, step, "coffee_walk");
        runtime.deskIdle = "fresh";
        refresh(runtime);
        await step(wait(runtime, COFFEE_SEC * 2));
        return;
      case "treadmill":
        occupied.treadmill = runtime;
        await walkTo(runtime, step, spots.treadmill, "walk", amenities.runner);
        char.playLoop("SW", "lift_weights");
        await step(wait(runtime, IDLE_ACTION_SEC));
        occupied.treadmill = null;
        return;
      case "toilet":
        occupied.toilet = runtime;
        await walkTo(runtime, step, spots.toilet, "walk", amenities.sitter);
        furniture?.setToiletBusy(true);
        char.playLoop("SE", "beanbag_game");
        await step(wait(runtime, IDLE_ACTION_SEC));
        releaseSpots(runtime);
        await step(char.walk([feetAt(spots.toilet)]));
        return;
      case "talk": {
        const target = talkTargets[Math.floor(Math.random() * talkTargets.length)];
        if (!target) return;
        const targetCell = cellAt(target.char.x, target.char.y);
        const spot = [1, -1, 0]
          .flatMap((dc) => [1, 0, -1].map((dr) => ({ c: targetCell.c + dc, r: targetCell.r + dr })))
          .find(
            (cell) =>
              (cell.c !== targetCell.c || cell.r !== targetCell.r) &&
              !layout.isBlocked(cell.c, cell.r),
          );
        if (!spot) return;
        await walkTo(runtime, step, spot);
        char.facing = target.char.x >= char.x ? 1 : -1;
        char.playLoop(char.facing === 1 ? "SE" : "SW", "chat");
        for (const line of ["…", "Haha", "Ok!"]) {
          char.speak(line, SPEECH_SEC);
          await step(wait(runtime, SPEECH_SEC));
        }
        return;
      }
    }
  };

  // ---- runtime registry -----------------------------------------------------------------

  const addAgent = (data: OfficeEngineAgent): AgentRuntime => {
    const char = new Character(assets, data.skin, labelStyle);
    char.setUiScale(1 / zoom);
    char.container.visible = false;
    char.overlay.visible = false;
    const runtime: AgentRuntime = {
      data,
      char,
      generation: 0,
      onStage: false,
      lastIdle: null,
      deskIdle: null,
      swap: false,
      hoverFor: null,
      removed: false,
    };
    setLabel(runtime);
    char.container.on("pointertap", () => options.onSelect(runtime.data.threadId));
    char.container.on("pointerover", () => {
      runtime.hoverFor = 0;
      setHovered(runtime.data.threadId);
    });
    char.container.on("pointerout", () => {
      runtime.hoverFor = null;
      setHovered(null);
    });
    stage.addChild(char.container);
    uiLayer.addChild(char.overlay);
    agents.set(data.threadId, runtime);
    return runtime;
  };

  const finalizeRemoval = (runtime: AgentRuntime) => {
    if (agents.get(runtime.data.threadId) !== runtime) return;
    agents.delete(runtime.data.threadId);
    releaseSpots(runtime);
    const desk = deskOf(runtime);
    if (desk && !occupantOf(desk.slot.index)) desk.setState(false, "env/monitor_off.png");
    runtime.char.destroy();
    linksDirty = true;
  };

  const removeAgent = (runtime: AgentRuntime) => {
    runtime.removed = true;
    linksDirty = true;
    if (!runtime.onStage) return finalizeRemoval(runtime);
    startScript(runtime, async (step) => {
      await leaveStage(runtime, step);
      finalizeRemoval(runtime);
    });
  };

  const startle = (runtime: AgentRuntime) => {
    startScript(runtime, async (step) => {
      runtime.char.speak("!", 1);
      await step(wait(runtime, 1));
      return dutyScript(runtime, step);
    });
  };

  // ---- frame loop -----------------------------------------------------------------------

  const updateFrameRate = () => {
    app.ticker.maxFPS = document.hidden
      ? DEEP_HIDDEN_FPS
      : document.hasFocus()
        ? RENDER_FPS
        : HIDDEN_FPS;
  };

  app.ticker.add((ticker: Ticker) => {
    const dt = Math.min(0.1, ticker.deltaMS / 1000);
    clock += dt;
    if (fitAge < FIT_SETTLE_SEC) {
      fitAge += dt;
      fit();
    }
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i]!.at <= clock) timers.splice(i, 1)[0]!.resolve();
    }
    for (const runtime of agents.values()) {
      runtime.char.tick(dt, ticker);
      if (runtime.hoverFor !== null) {
        runtime.hoverFor += dt;
        if (runtime.hoverFor >= HOVER_STARTLE_SEC) {
          runtime.hoverFor = null;
          const dozing = runtime.deskIdle === "slacking" || runtime.deskIdle === "sleep";
          if (dozing && !runtime.data.demoActivity) startle(runtime);
        }
      }
    }
    if (linksDirty) drawLinks();
  });

  const resizeObserver = new ResizeObserver(() => fit());
  resizeObserver.observe(host);
  document.addEventListener("visibilitychange", updateFrameRate);
  window.addEventListener("focus", updateFrameRate);
  window.addEventListener("blur", updateFrameRate);

  rebuildFurniture();
  fit();

  return {
    update: (state) => {
      const before = new Map(
        [...agents.values()].map((runtime) => [runtime, seatKey(slotOf(runtime))] as const),
      );
      const nextKey = `${state.layout.nested}|${state.layout.leaves}`;
      const relaid = nextKey !== layoutKey;
      if (relaid) {
        layoutKey = nextKey;
        const wanted = officeLayout(state.layout);
        const resized =
          wanted.content.width !== layout.content.width ||
          wanted.content.height !== layout.content.height;
        layout = wanted;
        rebuildFurniture();
        if (resized) {
          fitAge = FIT_SETTLE_SEC;
          fit();
        }
      }

      const seen = new Set<ThreadId>();
      for (const data of state.agents) {
        seen.add(data.threadId);
        const existing = agents.get(data.threadId);
        if (!existing || existing.removed) {
          if (existing) finalizeRemoval(existing);
          runAction(addAgent(data), "DISPATCH");
          continue;
        }
        const previous = existing.data;
        existing.data = data;
        setLabel(existing);
        if (data.speech && data.speech !== previous.speech)
          existing.char.speak(data.speech, SPEECH_SEC);
        if (previous.parentThreadId !== data.parentThreadId) linksDirty = true;
        if (seatKey(slotOf(existing)) !== before.get(existing)) {
          // Moved to another desk (promotion, demotion, re-layout): walk there and resume.
          linksDirty = true;
          runAction(existing, "DISPATCH");
          continue;
        }
        if (relaid && existing.char.seated) seatInto(existing);
        const action = dutyAction(previous.duty, data.duty, data.parentThreadId !== null);
        if (action) runAction(existing, existing.onStage ? action : "DISPATCH");
        else if (data.demoActivity !== previous.demoActivity) runAction(existing, "DISPATCH");
        refresh(existing);
      }
      for (const runtime of agents.values()) {
        if (!seen.has(runtime.data.threadId) && !runtime.removed) removeAgent(runtime);
      }
      // Desks left without an occupant fall back to the tucked-in chair and a dark screen.
      furniture?.desks.forEach((desk, index) => {
        if (!occupantOf(index)) desk.setState(false, "env/monitor_off.png");
      });

      for (const runtime of agents.values())
        runtime.char.setSelected(runtime.data.threadId === state.selectedThreadId);
    },
    destroy: () => {
      destroyed = true;
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", updateFrameRate);
      window.removeEventListener("focus", updateFrameRate);
      window.removeEventListener("blur", updateFrameRate);
      for (const timer of timers.splice(0)) timer.resolve();
      for (const runtime of agents.values()) runtime.char.interrupt();
      // Textures belong to the shared asset cache; only the scene graph goes.
      app.destroy(true, { children: true });
    },
  };
}
