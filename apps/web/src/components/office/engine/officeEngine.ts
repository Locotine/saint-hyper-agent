// FILE: officeEngine.ts
// Purpose: Pixi.js v8 virtual office modelled on Marvis: any number of thread characters walk
//          the floor plan, sit at their desks, work, hand over, and pass idle time at the
//          water bar, treadmill, toilet, or desk. Behaviour runs as cancellable async scripts.
// Layer: Web office renderer (imperative; React mounts it through OfficeCanvas)
// Exports: createOfficeEngine, OfficeEngine, OfficeEngineAgent, OfficeEngineState

import type { ThreadId } from "@saint/contracts";
import { Application, Container, Graphics } from "pixi.js";

import { findPath, type TilePoint } from "../astar";
import {
  CAT_FLEE_MULTIPLIER,
  CAT_FLEE_RADIUS,
  CAT_LIFETIME_SEC,
  CAT_SPEED,
  DEEP_HIDDEN_FPS,
  HIDDEN_FPS,
  HOVER_STARTLE_SEC,
  IDLE_ACTION_SEC,
  RENDER_FPS,
  SPEECH_SEC,
  agentColors,
  dutyAction,
  pickIdleActivity,
  shouldLeave,
  standbySeconds,
  type IdleActivity,
  type OfficeAction,
} from "../officeBehavior.logic";
import {
  TILE,
  cellCenter,
  officeFitBoost,
  officeLayout,
  type DeskSlot,
  type OfficeLayout,
} from "../officeLayout.logic";
import { monitorColor, type DutyState } from "../officeModel.logic";
import { Character, FEET_OFFSET } from "./character";
import {
  OFFICE_BACKGROUND,
  buildFurniture,
  type FurnitureSet,
  type OfficeTheme,
} from "./furniture";

export interface OfficeEngineAgent {
  readonly threadId: ThreadId;
  readonly desk: number;
  readonly label: string;
  readonly duty: DutyState;
  readonly speech: string | null;
  readonly parentThreadId: ThreadId | null;
}

export interface OfficeEngineState {
  readonly agents: readonly OfficeEngineAgent[];
  readonly selectedThreadId: ThreadId | null;
}

export interface OfficeEngine {
  readonly update: (state: OfficeEngineState) => void;
  readonly destroy: () => void;
}

const SLACK_SCREEN = 0xa77bf3;
const FIT_SETTLE_SEC = 0.6;

class Superseded extends Error {}

interface AgentRuntime {
  data: OfficeEngineAgent;
  readonly char: Character;
  /** Bumped by every new script; older scripts stop at their next await. */
  generation: number;
  onStage: boolean;
  lastIdle: IdleActivity | null;
  idleKind: IdleActivity | "standby" | null;
  hoverFor: number | null;
  removed: boolean;
}

interface Confetti {
  readonly g: Graphics;
  vx: number;
  vy: number;
  life: number;
}

interface Cat {
  readonly g: Container;
  readonly legs: Graphics;
  x: number;
  readonly y: number;
  readonly dir: 1 | -1;
  age: number;
}

function readTheme(): OfficeTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readLabelStyle(): { fontFamily: string; fontSize: number } {
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--app-font-size-ui-xs")) || 11;
  return { fontFamily: getComputedStyle(document.body).fontFamily || "sans-serif", fontSize: size };
}

function feetAt(cell: TilePoint): { x: number; y: number } {
  const center = cellCenter(cell);
  return { x: center.x, y: center.y + FEET_OFFSET };
}

function cellAt(x: number, y: number): TilePoint {
  return { c: Math.floor(x / TILE), r: Math.floor((y - FEET_OFFSET) / TILE) };
}

export async function createOfficeEngine(
  host: HTMLElement,
  options: { readonly onSelect: (threadId: ThreadId) => void },
): Promise<OfficeEngine> {
  const app = new Application();
  let theme = readTheme();
  await app.init({
    resizeTo: host,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    background: OFFICE_BACKGROUND[theme],
    preference: "webgl",
  });
  host.appendChild(app.canvas);
  app.ticker.maxFPS = RENDER_FPS;

  const labelStyle = readLabelStyle();
  const world = new Container();
  const floorLayer = new Container();
  const stage = new Container();
  stage.sortableChildren = true;
  const fxLayer = new Container();
  world.addChild(floorLayer, stage, fxLayer);
  app.stage.addChild(world);
  app.stage.eventMode = "static";

  let layout: OfficeLayout = officeLayout(6);
  let furniture: FurnitureSet | null = null;
  const agents = new Map<ThreadId, AgentRuntime>();
  const confetti: Confetti[] = [];
  let cat: Cat | null = null;
  let catCooldown = 20 + Math.random() * 40;
  let pointer: { x: number; y: number } | null = null;
  let fitAge = 0;
  let zoom = 1;
  let selected: ThreadId | null = null;
  let destroyed = false;
  const occupied = {
    slacking: null as AgentRuntime | null,
    treadmill: null as AgentRuntime | null,
    toilet: null as AgentRuntime | null,
  };
  const timers: { at: number; resolve: () => void; owner: AgentRuntime }[] = [];
  let clock = 0;

  const rebuildFurniture = () => {
    if (furniture) {
      floorLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
      for (const piece of furniture.pieces) piece.destroy({ children: true });
    }
    furniture = buildFurniture(layout, theme);
    floorLayer.addChild(furniture.floor);
    for (const piece of furniture.pieces) stage.addChild(piece);
    for (const runtime of agents.values()) refreshMonitor(runtime);
  };

  const fit = () => {
    const w = app.screen.width;
    const h = app.screen.height;
    if (w <= 0 || h <= 0) return;
    const base = Math.min(w / layout.width, h / layout.height);
    zoom = base * officeFitBoost(fitAge / FIT_SETTLE_SEC);
    world.scale.set(zoom);
    world.position.set((w - layout.width * zoom) / 2, (h - layout.height * zoom) / 2);
    for (const runtime of agents.values()) runtime.char.setUiScale(1 / zoom);
  };

  const slotOf = (runtime: AgentRuntime): DeskSlot =>
    layout.desks[runtime.data.desk] ?? layout.desks[0]!;

  // ---- script helpers -------------------------------------------------------------------

  const guard = (runtime: AgentRuntime, generation: number) => {
    if (destroyed || runtime.generation !== generation) throw new Superseded();
  };

  const wait = (runtime: AgentRuntime, seconds: number) =>
    new Promise<void>((resolve) => timers.push({ at: clock + seconds, resolve, owner: runtime }));

  const startScript = (
    runtime: AgentRuntime,
    script: (step: <T>(p: Promise<T>) => Promise<T>) => Promise<void>,
  ) => {
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.char.interrupt();
    // Wake the previous script's timers so it can exit.
    for (let i = timers.length - 1; i >= 0; i -= 1) {
      if (timers[i]!.owner === runtime) timers.splice(i, 1)[0]!.resolve();
    }
    releaseSpots(runtime);
    runtime.idleKind = null;
    const step = async <T>(p: Promise<T>): Promise<T> => {
      guard(runtime, generation);
      const value = await p;
      guard(runtime, generation);
      return value;
    };
    void script(step).catch((cause: unknown) => {
      if (!(cause instanceof Superseded)) console.error("[office] behaviour script failed", cause);
    });
  };

  const releaseSpots = (runtime: AgentRuntime) => {
    if (occupied.slacking === runtime) occupied.slacking = null;
    if (occupied.treadmill === runtime) occupied.treadmill = null;
    if (occupied.toilet === runtime) occupied.toilet = null;
  };

  const walkTo = async (
    runtime: AgentRuntime,
    step: <T>(p: Promise<T>) => Promise<T>,
    goal: TilePoint,
  ) => {
    await standUp(runtime, step);
    const { char } = runtime;
    const start = cellAt(char.x, char.y);
    const path = findPath(layout.cols, layout.rows, layout.isBlocked, start, goal) ?? [start, goal];
    const points = path.slice(1).map(feetAt);
    // Re-centre on the start tile first when standing off-grid (after a tween or a teleport).
    const startFeet = feetAt(start);
    if (Math.hypot(startFeet.x - char.x, startFeet.y - char.y) > 1) points.unshift(startFeet);
    await step(char.walk(points));
  };

  const sitDown = async (runtime: AgentRuntime, step: <T>(p: Promise<T>) => Promise<T>) => {
    if (runtime.char.seated) return;
    const slot = slotOf(runtime);
    await walkTo(runtime, step, slot.stand);
    const { char } = runtime;
    char.facing = slot.facing;
    const seat = { x: feetAt(slot.seat).x, y: feetAt(slot.seat).y };
    await step(char.playOnce("on_chair", { from: { x: char.x, y: char.y }, to: seat }));
    char.seated = true;
    refreshMonitor(runtime);
  };

  const standUp = async (runtime: AgentRuntime, step: <T>(p: Promise<T>) => Promise<T>) => {
    const { char } = runtime;
    if (!char.seated) return;
    const slot = slotOf(runtime);
    char.facing = slot.facing;
    await step(
      char.playOnce("off_chair", { from: { x: char.x, y: char.y }, to: feetAt(slot.stand) }),
    );
    char.seated = false;
    refreshMonitor(runtime);
  };

  const enterStage = (runtime: AgentRuntime) => {
    if (runtime.onStage) return;
    runtime.onStage = true;
    runtime.char.container.visible = true;
    runtime.char.seated = false;
    runtime.char.place(feetAt(layout.spots.door));
  };

  const onStageCount = () => [...agents.values()].filter((a) => a.onStage && !a.removed).length;

  const refreshMonitor = (runtime: AgentRuntime) => {
    const monitor = furniture?.monitors[runtime.data.desk];
    if (!monitor) return;
    if (!runtime.onStage) return monitor.setColor(monitorColor(null), false);
    if (runtime.idleKind === "slacking") return monitor.setColor(SLACK_SCREEN, true);
    const duty = runtime.data.duty;
    monitor.setColor(
      monitorColor(duty === "idle" && !runtime.char.seated ? null : duty),
      duty !== "idle" || runtime.char.seated,
    );
  };

  const burstConfetti = (x: number, y: number) => {
    const colors = [0xf25f5c, 0xffe066, 0x70c1b3, 0x4f8ef7, 0xa77bf3];
    for (let i = 0; i < 28; i += 1) {
      const g = new Graphics().rect(-2.5, -1.5, 5, 3).fill(colors[i % colors.length]!);
      g.position.set(x, y);
      g.rotation = Math.random() * Math.PI;
      fxLayer.addChild(g);
      confetti.push({
        g,
        vx: (Math.random() - 0.5) * 160,
        vy: -120 - Math.random() * 120,
        life: 1.4,
      });
    }
  };

  const pinStatus = (runtime: AgentRuntime) => {
    const duty = runtime.data.duty;
    runtime.char.pin(
      duty === "approval"
        ? "!"
        : duty === "input"
          ? "?"
          : duty === "error"
            ? "×"
            : runtime.idleKind === "sleep"
              ? "z z"
              : null,
    );
  };

  // ---- behaviours -----------------------------------------------------------------------

  const runAction = (runtime: AgentRuntime, action: OfficeAction) => {
    startScript(runtime, async (step) => {
      enterStage(runtime);
      const { char } = runtime;
      pinStatus(runtime);
      switch (action) {
        case "DISPATCH":
          return dutyScript(runtime, step);
        case "START":
          await sitDown(runtime, step);
          await step(char.playLoop("working"));
          refreshMonitor(runtime);
          return;
        case "SUB_START": {
          const parent = runtime.data.parentThreadId
            ? agents.get(runtime.data.parentThreadId)
            : undefined;
          if (parent?.onStage) {
            const parentSlot = slotOf(parent);
            await walkTo(runtime, step, parentSlot.stand);
            char.facing = parentSlot.facing;
            await step(char.playLoop("talking_on_stand"));
            char.speak("Nhận việc!", SPEECH_SEC);
            await step(wait(runtime, SPEECH_SEC));
            await step(char.playOnce("ticket"));
          }
          await sitDown(runtime, step);
          await step(char.playLoop("working"));
          return;
        }
        case "ATTENTION":
          await sitDown(runtime, step);
          await step(char.playLoop("high_press"));
          return;
        case "ERROR":
          await standUp(runtime, step);
          await step(char.playOnce("fall_down"));
          await step(char.playOnce("sorry"));
          await sitDown(runtime, step);
          await step(char.playLoop("sigh"));
          return;
        case "COMPLETE":
          await standUp(runtime, step);
          burstConfetti(char.x, char.y - 60);
          await step(char.playOnce("cheer_main"));
          return idleScript(runtime, step);
        case "IDLE":
          return idleScript(runtime, step);
      }
    });
  };

  const dutyScript = async (runtime: AgentRuntime, step: <T>(p: Promise<T>) => Promise<T>) => {
    const { char } = runtime;
    switch (runtime.data.duty) {
      case "working":
        await sitDown(runtime, step);
        return step(char.playLoop("working"));
      case "approval":
      case "input":
        await sitDown(runtime, step);
        return step(char.playLoop("high_press"));
      case "error":
        await sitDown(runtime, step);
        return step(char.playLoop("sigh"));
      case "idle":
        return idleScript(runtime, step);
    }
  };

  const idleScript = async (runtime: AgentRuntime, step: <T>(p: Promise<T>) => Promise<T>) => {
    const { char } = runtime;
    for (;;) {
      runtime.idleKind = "standby";
      pinStatus(runtime);
      const slot = slotOf(runtime);
      if (char.seated) await standUp(runtime, step);
      else await walkTo(runtime, step, slot.stand);
      char.facing = slot.facing;
      refreshMonitor(runtime);
      await step(char.playLoop("standby"));
      await step(wait(runtime, standbySeconds(Math.random)));

      if (shouldLeave(onStageCount(), Math.random)) {
        await step(char.playOnce("leaving"));
        await walkTo(runtime, step, layout.spots.door);
        runtime.onStage = false;
        char.container.visible = false;
        runtime.idleKind = null;
        refreshMonitor(runtime);
        return;
      }

      const talkTargets = [...agents.values()].filter(
        (a) => a !== runtime && a.onStage && !a.char.walking,
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
    }
  };

  const runIdleActivity = async (
    runtime: AgentRuntime,
    step: <T>(p: Promise<T>) => Promise<T>,
    activity: IdleActivity,
    talkTargets: readonly AgentRuntime[],
  ) => {
    const { char } = runtime;
    switch (activity) {
      case "slacking":
        occupied.slacking = runtime;
        await sitDown(runtime, step);
        runtime.idleKind = "slacking";
        refreshMonitor(runtime);
        await step(char.playLoop("working"));
        await step(wait(runtime, IDLE_ACTION_SEC));
        occupied.slacking = null;
        return;
      case "sleep":
        await sitDown(runtime, step);
        runtime.idleKind = "sleep";
        pinStatus(runtime);
        await step(char.playLoop("sleeping"));
        await step(wait(runtime, IDLE_ACTION_SEC));
        runtime.idleKind = null;
        pinStatus(runtime);
        await step(char.playExit());
        return;
      case "coffee":
        runtime.idleKind = "coffee";
        await walkTo(runtime, step, layout.spots.water);
        char.facing = -1;
        await step(char.playOnce("drink_coffee"));
        await step(char.playOnce("drink_coffee"));
        return;
      case "treadmill":
        occupied.treadmill = runtime;
        runtime.idleKind = "treadmill";
        await walkTo(runtime, step, layout.spots.treadmill);
        char.facing = 1;
        await step(char.playLoop("running_treadmill"));
        await step(wait(runtime, IDLE_ACTION_SEC));
        await step(char.playExit());
        occupied.treadmill = null;
        return;
      case "toilet":
        occupied.toilet = runtime;
        runtime.idleKind = "toilet";
        await walkTo(runtime, step, layout.spots.toilet);
        char.facing = -1;
        await step(char.playLoop("pooping"));
        await step(wait(runtime, IDLE_ACTION_SEC));
        await step(char.playExit());
        occupied.toilet = null;
        return;
      case "talk": {
        const target = talkTargets[Math.floor(Math.random() * talkTargets.length)];
        if (!target) return;
        runtime.idleKind = "talk";
        const targetCell = cellAt(target.char.x, target.char.y);
        const spot = [1, -1, 0]
          .flatMap((dc) => [0, 1, -1].map((dr) => ({ c: targetCell.c + dc, r: targetCell.r + dr })))
          .find(
            (cell) =>
              (cell.c !== targetCell.c || cell.r !== targetCell.r) &&
              !layout.isBlocked(cell.c, cell.r),
          );
        if (!spot) return;
        await walkTo(runtime, step, spot);
        char.facing = target.char.x >= char.x ? 1 : -1;
        await step(char.playLoop("talking_on_stand"));
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
    const char = new Character(labelStyle);
    const colors = agentColors(data.threadId);
    char.setColors(colors.scarf, colors.horn);
    char.setLabel(data.label);
    char.setUiScale(1 / zoom);
    char.container.visible = false;
    const runtime: AgentRuntime = {
      data,
      char,
      generation: 0,
      onStage: false,
      lastIdle: null,
      idleKind: null,
      hoverFor: null,
      removed: false,
    };
    char.container.on("pointertap", () => options.onSelect(runtime.data.threadId));
    char.container.on("pointerover", () => {
      runtime.hoverFor = 0;
    });
    char.container.on("pointerout", () => {
      runtime.hoverFor = null;
    });
    stage.addChild(char.container);
    agents.set(data.threadId, runtime);
    return runtime;
  };

  const removeAgent = (runtime: AgentRuntime) => {
    startScript(runtime, async (step) => {
      if (runtime.onStage) {
        await step(runtime.char.playOnce("leaving"));
        await walkTo(runtime, step, layout.spots.door);
      }
      finalizeRemoval(runtime);
    });
    runtime.removed = true;
    if (!runtime.onStage) finalizeRemoval(runtime);
  };

  const finalizeRemoval = (runtime: AgentRuntime) => {
    if (!agents.has(runtime.data.threadId)) return;
    agents.delete(runtime.data.threadId);
    runtime.onStage = false;
    refreshMonitor(runtime);
    runtime.char.destroy();
  };

  const startle = (runtime: AgentRuntime) => {
    startScript(runtime, async (step) => {
      if (runtime.char.seated) await standUp(runtime, step);
      await step(runtime.char.playOnce("peek"));
      runtime.char.speak("!", 1);
      return dutyScript(runtime, step);
    });
  };

  // ---- cat ------------------------------------------------------------------------------

  const spawnCat = () => {
    const rows = layout.spots.corridorRows;
    const row = rows[Math.floor(Math.random() * rows.length)] ?? 4;
    const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const g = new Container();
    const legs = new Graphics();
    const body = new Graphics()
      .ellipse(0, -10, 11, 6)
      .fill(0x222226)
      .circle(10, -16, 6)
      .fill(0x222226)
      .poly([6, -20, 8, -26, 11, -21])
      .fill(0x222226)
      .poly([11, -21, 14, -26, 15, -19])
      .fill(0x222226)
      .moveTo(-10, -12)
      .quadraticCurveTo(-20, -18, -16, -26)
      .stroke({ color: 0x222226, width: 2.5, cap: "round" })
      .circle(12, -17, 1.2)
      .fill(0xffe066);
    g.addChild(legs, body);
    g.scale.x = dir;
    const x = dir === 1 ? TILE : layout.width - TILE;
    stage.addChild(g);
    cat = { g, legs, x, y: (row + 0.5) * TILE + FEET_OFFSET, dir, age: 0 };
  };

  const tickCat = (dt: number) => {
    if (!cat) {
      catCooldown -= dt;
      if (catCooldown <= 0) spawnCat();
      return;
    }
    cat.age += dt;
    const near =
      pointer && Math.hypot(pointer.x - cat.x, pointer.y - (cat.y - 10)) < CAT_FLEE_RADIUS;
    const speed = CAT_SPEED * (near ? CAT_FLEE_MULTIPLIER : 1);
    cat.x += cat.dir * speed * dt;
    const stride = Math.sin(cat.age * (near ? 28 : 9)) * 3;
    cat.legs
      .clear()
      .rect(-7 + stride, -6, 2.5, 6)
      .fill(0x222226)
      .rect(5 - stride, -6, 2.5, 6)
      .fill(0x222226);
    cat.g.position.set(cat.x, cat.y);
    cat.g.zIndex = cat.y;
    const out = cat.x < TILE * 0.5 || cat.x > layout.width - TILE * 0.5;
    if (out || cat.age > CAT_LIFETIME_SEC) {
      cat.g.destroy({ children: true });
      cat = null;
      catCooldown = 60 + Math.random() * 90;
    }
  };

  // ---- frame loop -----------------------------------------------------------------------

  const updateFrameRate = () => {
    app.ticker.maxFPS = document.hidden
      ? DEEP_HIDDEN_FPS
      : document.hasFocus()
        ? RENDER_FPS
        : HIDDEN_FPS;
  };

  app.ticker.add((ticker) => {
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
      runtime.char.tick(dt);
      if (runtime.hoverFor !== null) {
        runtime.hoverFor += dt;
        if (runtime.hoverFor >= HOVER_STARTLE_SEC) {
          runtime.hoverFor = null;
          if (runtime.idleKind === "slacking" || runtime.idleKind === "sleep") startle(runtime);
        }
      }
    }
    for (let i = confetti.length - 1; i >= 0; i -= 1) {
      const piece = confetti[i]!;
      piece.life -= dt;
      piece.vy += 320 * dt;
      piece.g.x += piece.vx * dt;
      piece.g.y += piece.vy * dt;
      piece.g.rotation += dt * 8;
      piece.g.alpha = Math.min(1, piece.life * 2);
      if (piece.life <= 0) {
        piece.g.destroy();
        confetti.splice(i, 1);
      }
    }
    tickCat(dt);
  });

  app.stage.on("pointermove", (event) => {
    const local = world.toLocal(event.global);
    pointer = { x: local.x, y: local.y };
  });
  app.stage.on("pointerleave", () => {
    pointer = null;
  });

  const resizeObserver = new ResizeObserver(() => fit());
  resizeObserver.observe(host);
  const themeObserver = new MutationObserver(() => {
    const next = readTheme();
    if (next === theme) return;
    theme = next;
    app.renderer.background.color = OFFICE_BACKGROUND[theme];
    rebuildFurniture();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", updateFrameRate);
  window.addEventListener("focus", updateFrameRate);
  window.addEventListener("blur", updateFrameRate);

  rebuildFurniture();
  fit();

  return {
    update: (state) => {
      const deskCount = state.agents.reduce((max, agent) => Math.max(max, agent.desk + 1), 0);
      const wanted = officeLayout(deskCount);
      if (wanted.desks.length !== layout.desks.length) {
        layout = wanted;
        rebuildFurniture();
        fitAge = FIT_SETTLE_SEC;
        fit();
      }

      const seen = new Set<ThreadId>();
      for (const data of state.agents) {
        seen.add(data.threadId);
        const existing = agents.get(data.threadId);
        if (!existing || existing.removed) {
          if (existing) finalizeRemoval(existing);
          const runtime = addAgent(data);
          runAction(runtime, "DISPATCH");
          continue;
        }
        const previous = existing.data;
        existing.data = data;
        existing.char.setLabel(data.label);
        if (data.speech && data.speech !== previous.speech)
          existing.char.speak(data.speech, SPEECH_SEC);
        if (data.desk !== previous.desk) {
          // Moved to another desk: walk there and resume the current duty.
          existing.char.seated = false;
          runAction(existing, "DISPATCH");
          continue;
        }
        const action = dutyAction(previous.duty, data.duty, data.parentThreadId !== null);
        if (action) runAction(existing, existing.onStage ? action : "DISPATCH");
        else pinStatus(existing);
        refreshMonitor(existing);
      }
      for (const runtime of agents.values()) {
        if (!seen.has(runtime.data.threadId) && !runtime.removed) removeAgent(runtime);
      }

      selected = state.selectedThreadId;
      for (const runtime of agents.values())
        runtime.char.setSelected(runtime.data.threadId === selected);
    },
    destroy: () => {
      destroyed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", updateFrameRate);
      window.removeEventListener("focus", updateFrameRate);
      window.removeEventListener("blur", updateFrameRate);
      for (const timer of timers.splice(0)) timer.resolve();
      for (const runtime of agents.values()) runtime.char.interrupt();
      app.destroy(true, { children: true });
    },
  };
}
