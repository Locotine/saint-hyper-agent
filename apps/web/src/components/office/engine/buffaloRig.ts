// FILE: buffaloRig.ts
// Purpose: Procedural side-view water buffalo (black body, tintable horns and scarf) and its
//          per-frame poses for every office animation. Drawn once; posed by transforms.
// Layer: Web office renderer
// Exports: createBuffaloRig, BuffaloRig, poseFor, Pose

import { Container, Graphics } from "pixi.js";

import { ANIMS, coffeeCupVisible, type OfficeAnim } from "../officeBehavior.logic";

export interface Pose {
  /** Feet offset from the anchor. */
  readonly x: number;
  readonly y: number;
  /** 0 standing, 1 seated (legs forward, body raised onto the chair seat). */
  readonly sit: number;
  readonly lean: number;
  readonly squash: number;
  readonly head: number;
  readonly legA: number;
  readonly legB: number;
  readonly armFront: number;
  readonly armBack: number;
  readonly eyes: "open" | "closed" | "happy";
  readonly prop: "cup" | "ticket" | null;
  readonly sweat: boolean;
}

const BASE: Pose = {
  x: 0,
  y: 0,
  sit: 0,
  lean: 0,
  squash: 1,
  head: 0,
  legA: 0,
  legB: 0,
  armFront: 0.25,
  armBack: -0.25,
  eyes: "open",
  prop: null,
  sweat: false,
};

const TAU = Math.PI * 2;
const wave = (frame: number, period: number, phase = 0) => Math.sin((frame / period) * TAU + phase);
const ease = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
/** Blinks for three frames every `period` frames. */
const blink = (frame: number, period: number): Pose["eyes"] =>
  frame % period >= period - 3 ? "closed" : "open";

export function poseFor(anim: OfficeAnim, frame: number): Pose {
  const total = ANIMS[anim].frames;
  const t = frame / total;
  switch (anim) {
    case "walking_h":
    case "walking_up": {
      const swing = wave(frame, 16) * (anim === "walking_h" ? 0.55 : 0.35);
      return {
        ...BASE,
        y: -Math.abs(wave(frame, 16)) * 2.5,
        lean: 0.06,
        legA: swing,
        legB: -swing,
        armFront: -swing * 0.8,
        armBack: swing * 0.8,
      };
    }
    case "standby": {
      if (frame < 18) {
        const k = ease(frame / 18);
        return { ...BASE, squash: 1 - 0.06 * Math.sin(k * Math.PI), head: -0.1 * (1 - k) };
      }
      return {
        ...BASE,
        squash: 1 + wave(frame, 40) * 0.015,
        head: wave(frame, 40, 1) * 0.06,
        eyes: blink(frame, 40),
      };
    }
    case "working":
      return {
        ...BASE,
        sit: 1,
        lean: 0.12,
        head: 0.05 + wave(frame, 67, 0.3) * 0.03,
        armFront: 1.25 + Math.max(0, wave(frame, 6)) * 0.25,
        armBack: 1.15 + Math.max(0, wave(frame, 6, Math.PI)) * 0.25,
        eyes: blink(frame, 67),
      };
    case "high_press":
      return {
        ...BASE,
        sit: 1,
        x: wave(frame, 4) * 1.2,
        lean: 0.2,
        head: 0.12,
        armFront: 1.3 + Math.max(0, wave(frame, 3)) * 0.35,
        armBack: 1.2 + Math.max(0, wave(frame, 3, Math.PI)) * 0.35,
        sweat: true,
      };
    case "sigh": {
      const slump = Math.sin(t * Math.PI);
      return {
        ...BASE,
        sit: 1,
        lean: 0.1 + slump * 0.25,
        squash: 1 - slump * 0.06,
        head: 0.1 + slump * 0.35,
        armFront: 0.4,
        armBack: 0.3,
        eyes: slump > 0.4 ? "closed" : "open",
      };
    }
    case "off_chair":
    case "on_chair": {
      // on_chair is off_chair played backwards.
      const k = ease(anim === "off_chair" ? t : 1 - t);
      return {
        ...BASE,
        sit: 1 - k,
        y: -Math.sin(k * Math.PI) * 10,
        lean: 0.15 * Math.sin(k * Math.PI),
        legA: 0.3 * Math.sin(k * Math.PI),
        legB: -0.3 * Math.sin(k * Math.PI),
      };
    }
    case "peek": {
      const k = Math.sin(t * Math.PI);
      return { ...BASE, lean: 0.3 * k, head: 0.15 * k - 0.1, x: 4 * k, eyes: "open" };
    }
    case "drink_coffee": {
      const lift = frame >= 27 && frame < 65 ? Math.sin(((frame - 27) / 38) * Math.PI) : 0;
      return {
        ...BASE,
        armFront: 0.9 + lift * 1.3,
        head: -lift * 0.3,
        eyes: lift > 0.5 ? "closed" : blink(frame, 36),
        prop: coffeeCupVisible(frame) || lift > 0 ? "cup" : null,
      };
    }
    case "sleeping": {
      if (frame < 47) {
        return {
          ...BASE,
          sit: 1,
          lean: 0.28,
          head: 0.55 + wave(frame, 47) * 0.05,
          squash: 1 + wave(frame, 47) * 0.03,
          armFront: 0.5,
          armBack: 0.4,
          eyes: "closed",
        };
      }
      const k = ease((frame - 47) / 19);
      return {
        ...BASE,
        sit: 1,
        lean: 0.28 * (1 - k),
        head: 0.55 * (1 - k) - 0.15 * Math.sin(k * Math.PI),
        armFront: 0.5 + 1.2 * Math.sin(k * Math.PI),
        eyes: k > 0.6 ? "open" : "closed",
      };
    }
    case "running_treadmill": {
      const speed = frame < 27 ? 16 - (frame / 27) * 8 : 8;
      const swing = wave(frame, speed) * 0.8;
      return {
        ...BASE,
        y: -Math.abs(wave(frame, speed)) * 4,
        lean: 0.12,
        legA: swing,
        legB: -swing,
        armFront: -swing,
        armBack: swing,
        sweat: frame > 40,
      };
    }
    case "pooping": {
      const crouch = frame < 66 ? ease(frame / 30) : 1;
      return {
        ...BASE,
        sit: crouch * 0.7,
        squash: 1 - crouch * 0.05 + (frame >= 66 ? wave(frame, 12) * 0.03 : 0),
        lean: crouch * 0.15,
        head: crouch * 0.15,
        eyes: frame >= 66 && frame % 24 < 12 ? "closed" : "open",
        armFront: 0.5,
      };
    }
    case "talking_on_seat":
    case "talking_on_stand": {
      const seated = anim === "talking_on_seat" ? 1 : 0;
      return {
        ...BASE,
        sit: seated,
        head: wave(frame, 12) * 0.08,
        armFront: 0.6 + Math.max(0, wave(frame, 24)) * 0.9,
        squash: 1 + wave(frame, 12) * 0.015,
        eyes: blink(frame, 48),
      };
    }
    case "cheer_main":
    case "cheer1_sub":
    case "cheer2_sub": {
      const period = anim === "cheer_main" ? 24 : 20;
      const hop = Math.max(0, wave(frame, period));
      return {
        ...BASE,
        y: -hop * (anim === "cheer2_sub" ? 10 : 16),
        squash: 1 + hop * 0.05,
        armFront: 2.6 + wave(frame, period / 2) * 0.25,
        armBack: anim === "cheer1_sub" ? 0.3 : -2.6,
        eyes: "happy",
      };
    }
    case "salute": {
      const k = Math.sin(t * Math.PI);
      return {
        ...BASE,
        armFront: 0.3 + k * 2.4,
        head: -0.05 * k,
        eyes: k > 0.3 ? "happy" : "open",
      };
    }
    case "sorry": {
      const k = Math.sin(t * Math.PI);
      return {
        ...BASE,
        lean: 0.55 * k,
        head: 0.4 * k,
        armFront: 0.1,
        armBack: -0.1,
        eyes: "closed",
      };
    }
    case "fall_down": {
      const down = frame < 16 ? ease(frame / 16) : frame < 34 ? 1 : 1 - ease((frame - 34) / 14);
      return {
        ...BASE,
        lean: down * 1.35,
        x: -down * 10,
        y: down * 2,
        legA: down * 0.6,
        legB: down * 0.8,
        armFront: 1.6 * down,
        eyes: down > 0.5 ? "closed" : "open",
      };
    }
    case "leaving":
      return { ...BASE, armFront: 2.4 + wave(frame, 8) * 0.4, eyes: "happy" };
    case "ticket": {
      const k = Math.sin(t * Math.PI);
      return { ...BASE, armFront: 0.6 + k * 1.2, prop: "ticket", head: -0.08 * k };
    }
  }
}

export interface BuffaloRig {
  readonly root: Container;
  readonly setColors: (scarf: number, horn: number) => void;
  readonly apply: (pose: Pose) => void;
}

const BODY = 0x16161a;
const BODY_LIGHT = 0x2b2b31;
const SNOUT = 0x3a3a42;

function limb(width: number, length: number): Graphics {
  return new Graphics().roundRect(-width / 2, 0, width, length, width / 2).fill(BODY);
}

/** Side-view buffalo facing right; the container's origin is between the feet. */
export function createBuffaloRig(): BuffaloRig {
  const root = new Container();
  const shadow = new Graphics().ellipse(0, 0, 20, 6).fill({ color: 0x000000, alpha: 0.18 });
  const figure = new Container();

  const legBack = limb(8, 16);
  legBack.position.set(-8, -16);
  const legFront = limb(8, 16);
  legFront.position.set(8, -16);
  const armBack = limb(7, 16);
  armBack.position.set(0, -36);

  const torso = new Container();
  const body = new Graphics()
    .ellipse(0, -30, 20, 18)
    .fill(BODY)
    .ellipse(-4, -36, 10, 7)
    .fill({ color: BODY_LIGHT, alpha: 0.6 });
  const tail = new Graphics()
    .moveTo(-19, -32)
    .quadraticCurveTo(-27, -28, -25, -20)
    .stroke({ color: BODY, width: 3, cap: "round" });

  const scarf = new Graphics()
    .roundRect(-6, -48, 26, 8, 4)
    .fill(0xffffff)
    .roundRect(-10, -46, 7, 16, 3)
    .fill(0xffffff);

  const head = new Container();
  head.position.set(10, -50);
  const skull = new Graphics()
    .ellipse(0, -2, 15, 13)
    .fill(BODY)
    .ellipse(-9, -6, 5, 3.5)
    .fill(BODY_LIGHT)
    .ellipse(13, 4, 9, 7)
    .fill(SNOUT)
    .circle(17, 3, 1.4)
    .fill(0x000000)
    .circle(12, 5, 1.4)
    .fill(0x000000);
  const horns = new Graphics()
    .moveTo(-6, -11)
    .bezierCurveTo(-16, -14, -22, -24, -16, -30)
    .bezierCurveTo(-18, -22, -10, -18, -2, -14)
    .closePath()
    .fill(0xffffff)
    .moveTo(4, -13)
    .bezierCurveTo(10, -20, 6, -28, 0, -30)
    .bezierCurveTo(10, -30, 16, -20, 10, -11)
    .closePath()
    .fill(0xffffff);
  const eyeOpen = new Graphics().circle(5, -4, 3).fill(0xffffff).circle(6, -4, 1.6).fill(0x000000);
  const eyeClosed = new Graphics()
    .moveTo(2, -4)
    .lineTo(8, -4)
    .stroke({ color: 0xffffff, width: 1.6, cap: "round" });
  const eyeHappy = new Graphics()
    .moveTo(2, -3)
    .quadraticCurveTo(5, -8, 8, -3)
    .stroke({ color: 0xffffff, width: 1.6, cap: "round" });
  const sweat = new Graphics()
    .moveTo(-4, -22)
    .quadraticCurveTo(-8, -15, -4, -13)
    .quadraticCurveTo(0, -15, -4, -22)
    .fill(0x8fd3ff);
  head.addChild(horns, skull, eyeOpen, eyeClosed, eyeHappy, sweat);

  const armFront = new Container();
  armFront.addChild(limb(7, 17));
  armFront.position.set(6, -38);
  const cup = new Graphics()
    .roundRect(-4, 14, 9, 10, 2)
    .fill(0xffffff)
    .rect(-4, 14, 9, 3)
    .fill(0x8a5a3b);
  const ticket = new Graphics()
    .roundRect(-6, 12, 14, 18, 2)
    .fill(0xfff6d5)
    .rect(-3, 17, 8, 1.5)
    .fill(0xb0a070);
  armFront.addChild(cup, ticket);

  torso.addChild(tail, armBack, body, scarf, head, armFront);
  figure.addChild(legBack, legFront, torso);
  root.addChild(shadow, figure);

  return {
    root,
    setColors: (scarfColor, hornColor) => {
      scarf.tint = scarfColor;
      horns.tint = hornColor;
    },
    apply: (pose) => {
      figure.position.set(pose.x, pose.y - pose.sit * 14);
      shadow.scale.set(1 - pose.sit * 0.2 + Math.min(0, pose.y) * 0.01);
      torso.rotation = pose.lean;
      torso.pivot.set(0, -14);
      torso.position.set(0, -14);
      torso.scale.set(1 / Math.sqrt(pose.squash), pose.squash);
      head.rotation = pose.head;
      // Seated legs point forward over the chair edge.
      legBack.rotation = pose.legB - pose.sit * 1.35;
      legFront.rotation = pose.legA - pose.sit * 1.35;
      armFront.rotation = -pose.armFront;
      armBack.rotation = -pose.armBack;
      eyeOpen.visible = pose.eyes === "open";
      eyeClosed.visible = pose.eyes === "closed";
      eyeHappy.visible = pose.eyes === "happy";
      cup.visible = pose.prop === "cup";
      ticket.visible = pose.prop === "ticket";
      sweat.visible = pose.sweat;
    },
  };
}
