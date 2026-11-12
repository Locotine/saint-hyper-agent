// FILE: character.ts
// Purpose: One office buffalo: an AnimatedSprite from its skin atlas, tile-path walking at
//          constant speed, and a floating overlay (nameplate with provider icon, tier badge,
//          status bubbles, speech). Every awaited step can be interrupted so a newer behaviour
//          script takes over immediately.
// Layer: Web office renderer
// Exports: Character, FEET_OFFSET

import {
  AnimatedSprite,
  Container,
  Graphics,
  type NineSliceSprite,
  Sprite,
  Text,
  type Ticker,
} from "pixi.js";

import {
  WALK_SPEED,
  animFps,
  walkDirection,
  type OfficeAnim,
  type OfficeDirection,
} from "../officeBehavior.logic";
import type { Point } from "../officeLayout.logic";
import {
  BUBBLE_SPRITES,
  TYPING_BUBBLE_FRAMES,
  type OfficeBubble,
  type SkinId,
} from "../officeModel.logic";
import type { OfficeAssets } from "./officeAssets";

/** Feet sit this far below a tile's centre so characters stand on the lower half of the tile. */
export const FEET_OFFSET = 14;
/** The overlay floats above the horns; seated, it clears the raised monitor too. */
const OVERLAY_Y = -66;
const SEATED_OVERLAY_Y = -82;
/** Buffaloes read a touch larger than the furniture, as in the reference image. */
const BODY_SCALE = 1.15;
const NAMEPLATE_BORDER = 10;
const ICON_SIZE = 14;
const BUBBLE_SCALE = 0.75;

type Waiter = () => void;

export interface CharacterStyle {
  readonly fontFamily: string;
  readonly fontSize: number;
}

export class Character {
  readonly container = new Container();
  /** Lives in the engine's UI layer so desks in front never cover it. */
  readonly overlay = new Container();
  private readonly body: AnimatedSprite;
  private readonly selection = new Graphics();
  private readonly plate: Container = new Container();
  private readonly plateBg: NineSliceSprite;
  private readonly plateText: Text;
  private readonly plateIcon: Sprite;
  private badge: Sprite | null = null;
  private readonly bubbles = new Container();
  private readonly typing: AnimatedSprite;
  private readonly speech = new Container();
  private readonly speechBg: NineSliceSprite;
  private readonly speechText: Text;

  x = 0;
  y = 0;
  facing: 1 | -1 = 1;
  seated = false;
  /** Fixed zIndex inside a desk group while seated; null sorts by feet y on the floor. */
  layerZ: number | null = null;
  direction: OfficeDirection = "SW";
  anim: OfficeAnim = "idle";
  private skin: SkinId;
  private walkAnim: OfficeAnim = "walk";
  private onceWaiter: Waiter | null = null;
  private path: Point[] = [];
  private arriveWaiter: Waiter | null = null;
  private speechUntil = 0;
  private clock = 0;
  private bubbleKey = "";

  constructor(
    private readonly assets: OfficeAssets,
    skin: SkinId,
    style: CharacterStyle,
  ) {
    this.skin = skin;
    this.body = new AnimatedSprite(assets.animation(skin, "SW", "idle"));
    this.body.autoUpdate = false;
    this.body.anchor.set(0.5, 0.85);
    this.body.scale.set(BODY_SCALE);
    this.container.addChild(this.selection, this.body);
    this.container.eventMode = "static";
    this.container.cursor = "pointer";

    this.plateBg = assets.nineSlice("ui/nameplate_light_9slice.png", NAMEPLATE_BORDER);
    this.plateIcon = assets.sprite("ui/provider_local.png");
    this.plateIcon.width = ICON_SIZE;
    this.plateIcon.height = ICON_SIZE;
    this.plateText = new Text({
      text: "",
      style: { fontFamily: style.fontFamily, fontSize: style.fontSize, fill: 0x1e2028 },
    });
    this.plateText.resolution = 3;
    this.plateText.anchor.set(0, 0.5);
    this.plate.addChild(this.plateBg, this.plateIcon, this.plateText);

    this.typing = assets.animated(TYPING_BUBBLE_FRAMES);
    this.typing.autoUpdate = false;
    this.typing.animationSpeed = 4 / 60;
    this.typing.play();

    this.speechBg = assets.nineSlice("ui/speech_frame_light_9slice.png", 12);
    this.speechText = new Text({
      text: "",
      style: { fontFamily: style.fontFamily, fontSize: style.fontSize, fill: 0x1e2028 },
    });
    this.speechText.resolution = 3;
    this.speechText.anchor.set(0.5, 0.5);
    this.speech.addChild(this.speechBg, this.speechText);
    this.speech.visible = false;

    this.overlay.addChild(this.plate, this.bubbles, this.speech);
    this.overlay.eventMode = "none";
    this.play("SW", "idle");
  }

  setSkin(skin: SkinId): void {
    if (skin === this.skin) return;
    this.skin = skin;
    this.play(this.direction, this.anim, this.body.loop);
  }

  /** Nameplate text, provider icon and tier badge (null for specialists). */
  setLabel(text: string, providerIcon: string, badge: string | null): void {
    this.plateIcon.texture = this.assets.texture(providerIcon);
    if (this.badge?.label !== badge) {
      this.badge?.destroy();
      this.badge = null;
      if (badge) {
        this.badge = this.assets.sprite(badge);
        this.badge.label = badge;
        this.overlay.addChild(this.badge);
      }
    }
    this.plateText.text = text;
    const pad = 7;
    const w = pad + ICON_SIZE + 4 + this.plateText.width + pad;
    const h = Math.max(20, this.plateText.height + 6);
    this.plateBg.width = w;
    this.plateBg.height = h;
    this.plateBg.position.set(-w / 2, -h);
    this.plateIcon.position.set(-w / 2 + pad + ICON_SIZE / 2, -h / 2);
    this.plateText.position.set(-w / 2 + pad + ICON_SIZE + 4, -h / 2);
    if (this.badge) this.badge.position.set(-w / 2 - 14, -h / 2 + 10);
    this.layoutBubbles(w, h);
  }

  setBubbles(list: readonly OfficeBubble[]): void {
    const key = list.join(",");
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    this.bubbles.removeChildren().forEach((child) => {
      if (child !== this.typing) child.destroy();
    });
    for (const bubble of list) {
      const sprite = bubble === "typing" ? this.typing : this.assets.sprite(BUBBLE_SPRITES[bubble]);
      sprite.anchor.set(0.5, 0.95);
      sprite.scale.set(BUBBLE_SCALE);
      this.bubbles.addChild(sprite);
    }
    this.layoutBubbles(this.plateBg.width, this.plateBg.height);
  }

  private layoutBubbles(plateWidth: number, plateHeight: number): void {
    this.bubbles.children.forEach((child, i) => child.position.set(i * 30, 0));
    this.bubbles.position.set(plateWidth / 2 - 4, -plateHeight - 2);
    this.speech.position.set(0, -plateHeight - (this.bubbles.children.length > 0 ? 34 : 4));
  }

  /** Keeps the overlay a constant on-screen size whatever the zoom. */
  setUiScale(scale: number): void {
    this.overlay.scale.set(scale);
  }

  setSelected(selected: boolean): void {
    this.selection.clear();
    if (selected) this.selection.ellipse(0, 0, 22, 8).stroke({ color: 0x4f8ef7, width: 2.5 });
  }

  /** Shows `text` in a speech frame for `seconds`. */
  speak(text: string, seconds: number): void {
    this.speechUntil = this.clock + seconds;
    this.speechText.text = text;
    const w = this.speechText.width + 20;
    const h = this.speechText.height + 12;
    this.speechBg.width = w;
    this.speechBg.height = h;
    this.speechBg.position.set(-w / 2, -h);
    this.speechText.position.set(0, -h / 2);
    this.speech.visible = true;
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
    const waiters = [this.onceWaiter, this.arriveWaiter];
    this.onceWaiter = null;
    this.arriveWaiter = null;
    delete this.body.onComplete;
    for (const waiter of waiters) waiter?.();
  }

  private play(direction: OfficeDirection, anim: OfficeAnim, loop = true): void {
    this.direction = direction;
    this.anim = anim;
    this.body.textures = this.assets.animation(this.skin, direction, anim);
    this.body.animationSpeed = animFps(anim) / 60;
    this.body.loop = loop;
    this.body.gotoAndPlay(0);
  }

  /** Loops an animation until something else plays. */
  playLoop(direction: OfficeDirection, anim: OfficeAnim): void {
    delete this.body.onComplete;
    this.play(direction, anim);
  }

  /** Plays an animation once; resolves at its last frame. */
  playOnce(direction: OfficeDirection, anim: OfficeAnim): Promise<void> {
    this.play(direction, anim, false);
    return new Promise((resolve) => {
      this.onceWaiter = resolve;
      this.body.onComplete = () => {
        this.onceWaiter = null;
        resolve();
      };
    });
  }

  /** Walks the points at WALK_SPEED with `anim` (walk, coffee_walk or carry_report). */
  walk(points: readonly Point[], anim: OfficeAnim = "walk"): Promise<void> {
    this.path = [...points];
    this.walkAnim = anim;
    if (this.path.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.arriveWaiter = resolve;
    });
  }

  get walking(): boolean {
    return this.path.length > 0;
  }

  tick(dt: number, ticker: Ticker): void {
    this.clock += dt;
    if (this.speech.visible && this.clock >= this.speechUntil) this.speech.visible = false;
    if (this.path.length > 0) this.stepWalk(dt);
    this.body.update(ticker);
    if (this.typing.parent) this.typing.update(ticker);
    this.syncTransform();
  }

  private stepWalk(dt: number): void {
    let budget = WALK_SPEED * dt;
    while (budget > 0 && this.path.length > 0) {
      const target = this.path[0]!;
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
      const direction = walkDirection(dx, dy, this.facing);
      if (this.anim !== this.walkAnim || this.direction !== direction) {
        // Keep the stride phase when turning a corner so the legs do not snap.
        const keep = this.anim === this.walkAnim ? this.body.currentFrame : 0;
        this.play(direction, this.walkAnim);
        this.body.gotoAndPlay(keep % this.body.totalFrames);
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
      const holding = this.walkAnim === "coffee_walk";
      this.play(this.direction, holding ? "coffee_idle" : "idle");
      const waiter = this.arriveWaiter;
      this.arriveWaiter = null;
      waiter?.();
    }
  }

  private syncTransform(): void {
    // Sub-pixel positions: rounding at a fractional zoom makes walking shimmer.
    this.container.position.set(this.x, this.y);
    this.overlay.position.set(this.x, this.y + (this.seated ? SEATED_OVERLAY_Y : OVERLAY_Y));
    this.container.zIndex = this.layerZ ?? this.y;
  }

  destroy(): void {
    this.interrupt();
    if (!this.typing.parent) this.typing.destroy();
    this.container.destroy({ children: true });
    this.overlay.destroy({ children: true });
  }
}
