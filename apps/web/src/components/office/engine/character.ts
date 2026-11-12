// FILE: character.ts
// Purpose: One office character: the buffalo rig stepped at 24fps through animation phases,
//          tile-path walking at constant speed, name label and speech bubble. Every awaited
//          step can be interrupted so a newer behaviour script takes over immediately.
// Layer: Web office renderer
// Exports: Character, FEET_OFFSET

import { Container, Graphics, Text } from "pixi.js";

import {
  ANIM_FPS,
  ANIMS,
  WALK_SPEED,
  phaseFrames,
  type AnimPhase,
  type OfficeAnim,
} from "../officeBehavior.logic";
import { createBuffaloRig, poseFor, type BuffaloRig } from "./buffaloRig";

/** Feet sit this far below a tile's centre so characters stand on the lower half of the tile. */
export const FEET_OFFSET = 14;

interface Point {
  readonly x: number;
  readonly y: number;
}

type Waiter = () => void;

export interface CharacterStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
}

export class Character {
  readonly container = new Container();
  private readonly rig: BuffaloRig;
  private readonly body = new Container();
  private readonly label = new Container();
  private readonly labelText: Text;
  private readonly labelBg = new Graphics();
  private readonly bubble = new Container();
  private readonly bubbleText: Text;
  private readonly bubbleBg = new Graphics();
  private readonly selection = new Graphics();

  x = 0;
  y = 0;
  facing: 1 | -1 = 1;
  seated = false;
  anim: OfficeAnim = "standby";
  private phase: AnimPhase = "loop";
  private frames: number[] = phaseFrames("standby", "loop");
  private frameIndex = 0;
  private frameAcc = 0;
  private looping = true;
  private phaseWaiter: Waiter | null = null;
  private path: Point[] = [];
  private arriveWaiter: Waiter | null = null;
  private tween: { from: Point; to: Point } | null = null;
  private bubbleUntil = 0;
  private bubblePinned: string | null = null;
  private clock = 0;

  constructor(style: CharacterStyle) {
    this.rig = createBuffaloRig();
    this.body.addChild(this.rig.root);
    this.labelText = new Text({
      text: "",
      style: { fontFamily: style.fontFamily, fontSize: style.fontSize, fill: 0xffffff },
    });
    this.labelText.resolution = 3;
    this.labelText.anchor.set(0.5, 0);
    this.label.addChild(this.labelBg, this.labelText);
    this.bubbleText = new Text({
      text: "",
      style: { fontFamily: style.fontFamily, fontSize: style.fontSize, fill: 0x1c1c1c },
    });
    this.bubbleText.resolution = 3;
    this.bubbleText.anchor.set(0.5, 1);
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.bubble.visible = false;
    this.container.addChild(this.selection, this.body, this.label, this.bubble);
    this.container.eventMode = "static";
    this.container.cursor = "pointer";
    this.applyFrame();
  }

  setColors(scarf: number, horn: number): void {
    this.rig.setColors(scarf, horn);
  }

  setLabel(text: string): void {
    if (this.labelText.text === text) return;
    this.labelText.text = text;
    const w = this.labelText.width + 12;
    const h = this.labelText.height + 4;
    this.labelBg
      .clear()
      .roundRect(-w / 2, -2, w, h, h / 2)
      .fill({ color: 0x1c1c1c, alpha: 0.78 });
  }

  /** Keeps label and bubble a constant on-screen size whatever the zoom. */
  setUiScale(scale: number): void {
    this.label.scale.set(scale);
    this.bubble.scale.set(scale);
    this.label.position.set(0, 6);
    this.bubble.position.set(0, -92);
  }

  setSelected(selected: boolean): void {
    this.selection.clear();
    if (selected) this.selection.ellipse(0, 0, 26, 9).stroke({ color: 0x4f8ef7, width: 2.5 });
  }

  /** Shows `text` for `seconds`; a pinned text (status icon) stays until cleared. */
  speak(text: string, seconds: number): void {
    this.bubbleUntil = this.clock + seconds;
    this.drawBubble(text);
  }

  pin(text: string | null): void {
    this.bubblePinned = text;
    if (text) this.drawBubble(text);
    else if (this.clock >= this.bubbleUntil) this.bubble.visible = false;
  }

  private drawBubble(text: string): void {
    this.bubbleText.text = text;
    const w = Math.max(24, this.bubbleText.width + 14);
    const h = this.bubbleText.height + 8;
    this.bubbleBg
      .clear()
      .roundRect(-w / 2, -h - 2, w, h, 8)
      .fill(0xffffff)
      .stroke({ color: 0x000000, alpha: 0.12, width: 1 })
      .poly([-5, -3, 5, -3, 0, 4])
      .fill(0xffffff);
    this.bubbleText.position.set(0, -6);
    this.bubble.visible = true;
  }

  place(point: Point): void {
    this.x = point.x;
    this.y = point.y;
    this.path = [];
    this.syncTransform();
  }

  /** Wakes every pending wait so the script that owned them can notice it was superseded. */
  interrupt(): void {
    this.path = [];
    this.tween = null;
    const waiters = [this.phaseWaiter, this.arriveWaiter];
    this.phaseWaiter = null;
    this.arriveWaiter = null;
    for (const waiter of waiters) waiter?.();
  }

  /** Plays the whole animation once; resolves at its last frame. */
  playOnce(anim: OfficeAnim, tween?: { from: Point; to: Point }): Promise<void> {
    this.tween = tween ?? null;
    this.setFrames(
      anim,
      "loop",
      Array.from({ length: ANIMS[anim].frames }, (_, i) => i),
      false,
    );
    return new Promise((resolve) => {
      this.phaseWaiter = resolve;
    });
  }

  /** Plays the enter segment (if any) then loops; resolves once the loop starts. */
  playLoop(anim: OfficeAnim): Promise<void> {
    this.tween = null;
    const enter = phaseFrames(anim, "enter");
    if (enter.length === 0) {
      this.setFrames(anim, "loop", phaseFrames(anim, "loop"), true);
      return Promise.resolve();
    }
    this.setFrames(anim, "enter", enter, false);
    return new Promise((resolve) => {
      this.phaseWaiter = () => {
        this.setFrames(anim, "loop", phaseFrames(anim, "loop"), true);
        resolve();
      };
    });
  }

  /** Plays the current loop's exit segment, if it has one. */
  playExit(): Promise<void> {
    const exit = this.phase === "loop" ? phaseFrames(this.anim, "exit") : [];
    if (exit.length === 0) return Promise.resolve();
    this.setFrames(this.anim, "exit", exit, false);
    return new Promise((resolve) => {
      this.phaseWaiter = resolve;
    });
  }

  walk(points: readonly Point[]): Promise<void> {
    this.path = [...points];
    if (this.path.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.arriveWaiter = resolve;
    });
  }

  get walking(): boolean {
    return this.path.length > 0;
  }

  private setFrames(anim: OfficeAnim, phase: AnimPhase, frames: number[], loop: boolean): void {
    this.anim = anim;
    this.phase = phase;
    this.frames = frames.length > 0 ? frames : [0];
    this.frameIndex = 0;
    this.frameAcc = 0;
    this.looping = loop;
    this.applyFrame();
  }

  tick(dt: number): void {
    this.clock += dt;
    if (this.bubble.visible && !this.bubblePinned && this.clock >= this.bubbleUntil) {
      this.bubble.visible = false;
    } else if (this.bubblePinned && this.clock >= this.bubbleUntil) {
      if (this.bubbleText.text !== this.bubblePinned) this.drawBubble(this.bubblePinned);
    }

    if (this.path.length > 0) this.stepWalk(dt);

    this.frameAcc += dt * ANIM_FPS;
    while (this.frameAcc >= 1) {
      this.frameAcc -= 1;
      if (this.frameIndex < this.frames.length - 1) {
        this.frameIndex += 1;
      } else if (this.looping) {
        this.frameIndex = 0;
      } else {
        const waiter = this.phaseWaiter;
        this.phaseWaiter = null;
        this.frameAcc = 0;
        waiter?.();
        break;
      }
    }
    if (this.tween && this.phase === "loop" && !this.looping) {
      const t = Math.min(1, (this.frameIndex + 1) / this.frames.length);
      this.x = this.tween.from.x + (this.tween.to.x - this.tween.from.x) * t;
      this.y = this.tween.from.y + (this.tween.to.y - this.tween.from.y) * t;
    }
    this.applyFrame();
    this.syncTransform();
  }

  private stepWalk(dt: number): void {
    let budget = WALK_SPEED * dt;
    while (budget > 0 && this.path.length > 0) {
      const target = this.path[0]!;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const distance = Math.hypot(dx, dy);
      // Flip only on a real horizontal move; vertical steps keep the last facing.
      if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
      const walkAnim: OfficeAnim = Math.abs(dx) >= Math.abs(dy) ? "walking_h" : "walking_up";
      if (this.anim !== walkAnim) {
        // Keep the stride phase when turning a corner so the legs do not snap.
        const keep = this.anim === "walking_h" || this.anim === "walking_up" ? this.frameIndex : 0;
        this.setFrames(walkAnim, "loop", phaseFrames(walkAnim, "loop"), true);
        this.frameIndex = keep % this.frames.length;
      }
      if (distance <= budget) {
        this.x = target.x;
        this.y = target.y;
        budget -= distance;
        this.path.shift();
      } else {
        this.x += (dx / distance) * budget;
        this.y += (dy / distance) * budget;
        budget = 0;
      }
    }
    if (this.path.length === 0) {
      this.setFrames("standby", "loop", phaseFrames("standby", "loop"), true);
      const waiter = this.arriveWaiter;
      this.arriveWaiter = null;
      waiter?.();
    }
  }

  private applyFrame(): void {
    this.rig.apply(poseFor(this.anim, this.frames[this.frameIndex] ?? 0));
  }

  private syncTransform(): void {
    // Sub-pixel positions: rounding at a fractional zoom makes walking shimmer.
    this.container.position.set(this.x, this.y);
    this.body.scale.x = this.facing;
    this.container.zIndex = this.y;
  }

  destroy(): void {
    this.interrupt();
    this.container.destroy({ children: true });
  }
}
