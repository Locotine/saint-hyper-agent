// FILE: furniture.ts
// Purpose: Procedural front-on office furniture (floor, walls, desks, chairs, monitors, treadmill,
//          toilet, water bar) in light and dark palettes. Every piece is depth-sorted by its base y.
// Layer: Web office renderer
// Exports: buildFurniture, OfficeTheme, FurnitureSet, MonitorHandle, OFFICE_BACKGROUND

import { Container, Graphics } from "pixi.js";

import { TILE, type DeskSlot, type OfficeLayout } from "../officeLayout.logic";

export type OfficeTheme = "light" | "dark";

export const OFFICE_BACKGROUND: Readonly<Record<OfficeTheme, number>> = {
  light: 0xf7f7f7,
  dark: 0x1c1c1c,
};

interface Palette {
  readonly floor: number;
  readonly floorLine: number;
  readonly wall: number;
  readonly wallTop: number;
  readonly deskTop: number;
  readonly deskFront: number;
  readonly chair: number;
  readonly chairBoss: number;
  readonly monitor: number;
  readonly metal: number;
  readonly accent: number;
  readonly plant: number;
}

const PALETTES: Readonly<Record<OfficeTheme, Palette>> = {
  light: {
    floor: 0xffffff,
    floorLine: 0xeeeef1,
    wall: 0xe4e4e9,
    wallTop: 0xd4d4db,
    deskTop: 0xfbfbfc,
    deskFront: 0xdcdce2,
    chair: 0x3a3b42,
    chairBoss: 0x8a4b2c,
    monitor: 0x26272d,
    metal: 0xb7b8c0,
    accent: 0x4f8ef7,
    plant: 0x5aa469,
  },
  dark: {
    floor: 0x26272b,
    floorLine: 0x2e2f34,
    wall: 0x34353b,
    wallTop: 0x3f4047,
    deskTop: 0x3a3b42,
    deskFront: 0x2b2c32,
    chair: 0x55565f,
    chairBoss: 0x9a5a38,
    monitor: 0x141418,
    metal: 0x6b6c75,
    accent: 0x5b9bff,
    plant: 0x4c8c59,
  },
};

export interface MonitorHandle {
  readonly setColor: (color: number, glow: boolean) => void;
}

export interface FurnitureSet {
  /** Always behind everything (floor, back wall). */
  readonly floor: Container;
  /** Depth-sorted pieces; add them to the same sortable layer as characters. */
  readonly pieces: readonly Container[];
  readonly monitors: readonly MonitorHandle[];
}

function piece(z: number): Graphics {
  const g = new Graphics();
  g.zIndex = z;
  return g;
}

function buildDesk(slot: DeskSlot, p: Palette): { parts: Container[]; monitor: MonitorHandle } {
  const left = slot.desk[0].c * TILE + 4;
  const width = TILE * 2 - 8;
  const top = slot.desk[0].r * TILE + 10;
  const depth = TILE - 30;
  // Below a seated character (feet at row + 46) so arms reaching over the desk stay visible.
  const desk = piece(slot.desk[0].r * TILE + 40);
  desk
    .roundRect(left, top, width, depth, 6)
    .fill(slot.boss ? 0xc9a27a : p.deskTop)
    .roundRect(left, top + depth - 4, width, 18, 5)
    .fill(slot.boss ? 0x9c7653 : p.deskFront)
    .rect(left + 6, top + depth + 12, 5, 12)
    .fill(p.metal)
    .rect(left + width - 11, top + depth + 12, 5, 12)
    .fill(p.metal);

  // Monitor on the desk edge nearest the seat, screen facing the seat (3/4 view).
  const monitorX = slot.facing === 1 ? left + 52 : left + width - 52;
  const screen = new Graphics();
  const monitor = new Container();
  monitor.zIndex = slot.desk[0].r * TILE + 41;
  const monitorFrame = new Graphics();
  monitorFrame
    .rect(monitorX - 2, top + 10, 4, 12)
    .fill(p.metal)
    .roundRect(monitorX - 10, top + 20, 20, 4, 2)
    .fill(p.metal)
    .roundRect(monitorX - 18 * 0.5 - 8, top - 18, 34, 30, 4)
    .fill(p.monitor);
  screen.position.set(monitorX - 14, top - 14);
  monitor.addChild(monitorFrame, screen);
  const glow = new Graphics();
  glow.position.set(monitorX, top + 8);
  monitor.addChildAt(glow, 0);
  const drawScreen = (color: number, on: boolean) => {
    screen.clear().roundRect(0, 0, 28, 22, 3).fill(color);
    if (on) {
      for (let line = 0; line < 4; line += 1) {
        screen
          .rect(4, 4 + line * 4, 8 + ((line * 7) % 13), 1.6)
          .fill({ color: 0xffffff, alpha: 0.55 });
      }
    }
    glow.clear();
    if (on) glow.ellipse(0, 0, 34, 18).fill({ color, alpha: 0.16 });
  };
  drawScreen(0x1a1b1f, false);

  // Chair: back behind the sitter, seat in front of the floor.
  const seatX = (slot.seat.c + 0.5) * TILE;
  const seatY = (slot.seat.r + 0.5) * TILE + 14;
  const chairColor = slot.boss ? p.chairBoss : p.chair;
  const chairBack = piece(seatY - 2);
  const backX = seatX - slot.facing * 18;
  chairBack
    .roundRect(backX - 5, seatY - 46, 10, 38, 5)
    .fill(chairColor)
    .roundRect(seatX - 16, seatY - 16, 32, 9, 4)
    .fill(chairColor)
    .rect(seatX - 2, seatY - 8, 4, 10)
    .fill(p.metal)
    .roundRect(seatX - 14, seatY + 2, 28, 4, 2)
    .fill(p.metal);
  if (slot.boss) chairBack.roundRect(backX - 7, seatY - 52, 14, 10, 5).fill(chairColor);

  return {
    parts: [chairBack, desk, monitor],
    monitor: { setColor: drawScreen },
  };
}

export function buildFurniture(layout: OfficeLayout, theme: OfficeTheme): FurnitureSet {
  const p = PALETTES[theme];
  const floor = new Container();
  const width = layout.width;
  const height = layout.height;

  const ground = new Graphics()
    .roundRect(TILE * 0.5, TILE * 0.5, width - TILE, height - TILE, 18)
    .fill(p.floor);
  for (let c = 1; c < layout.cols - 1; c += 1) {
    ground.rect(c * TILE, TILE, 1, height - TILE * 2).fill(p.floorLine);
  }
  for (let r = 1; r < layout.rows - 1; r += 1) {
    ground.rect(TILE, r * TILE, width - TILE * 2, 1).fill(p.floorLine);
  }
  // Back wall strip and the side wall edges.
  ground
    .roundRect(TILE * 0.5, TILE * 0.2, width - TILE, TILE * 0.8, 14)
    .fill(p.wall)
    .rect(TILE * 0.5, TILE * 0.9, width - TILE, 6)
    .fill(p.wallTop)
    .roundRect(TILE * 0.3, TILE * 0.5, 12, height - TILE, 6)
    .fill(p.wall)
    .roundRect(width - TILE * 0.3 - 12, TILE * 0.5, 12, height - TILE, 6)
    .fill(p.wall)
    .roundRect(TILE * 0.5, height - TILE * 0.55, width - TILE, 10, 5)
    .fill(p.wall);
  // Doorway in the left wall.
  const door = layout.spots.door;
  ground
    .rect(TILE * 0.25, door.r * TILE + 6, 22, TILE - 12)
    .fill(p.floor)
    .rect(TILE * 0.25, door.r * TILE + 6, 4, TILE - 12)
    .fill(p.accent);
  // Zone rugs.
  ground
    .roundRect(TILE * 1.2, TILE * 5.2, TILE * 5.6, TILE * 2.6, 14)
    .fill({ color: p.accent, alpha: 0.07 })
    .roundRect(TILE * 1.2, TILE * 9.2, TILE * 5.6, TILE * 3.4, 14)
    .fill({ color: p.plant, alpha: 0.07 });
  floor.addChild(ground);

  const pieces: Container[] = [];
  const monitors: MonitorHandle[] = [];
  for (const slot of layout.desks) {
    const desk = buildDesk(slot, p);
    pieces.push(...desk.parts);
    monitors.push(desk.monitor);
  }

  // Water bar along the top wall.
  const bar = piece(TILE * 2 - 8);
  bar
    .roundRect(TILE * 1.1, TILE * 1.05, TILE * 2.8, TILE * 0.7, 6)
    .fill(p.deskTop)
    .roundRect(TILE * 1.1, TILE * 1.6, TILE * 2.8, 14, 5)
    .fill(p.deskFront)
    .roundRect(TILE * 1.4, TILE * 0.55, 22, 34, 6)
    .fill({ color: 0x8fd3ff, alpha: 0.85 })
    .roundRect(TILE * 1.35, TILE * 1.05, 28, 14, 4)
    .fill(p.metal)
    .roundRect(TILE * 2.6, TILE * 1.1, 10, 12, 2)
    .fill(0xffffff)
    .roundRect(TILE * 2.9, TILE * 1.1, 10, 12, 2)
    .fill(0xffffff);
  pieces.push(bar);

  // Treadmill: the runner stands on the left cell, the console is on the right.
  const tm = layout.spots.treadmill;
  const treadmill = piece((tm.r + 0.5) * TILE - 1);
  treadmill
    .roundRect(tm.c * TILE + 2, tm.r * TILE + 26, TILE * 2 - 4, 26, 8)
    .fill(p.monitor)
    .roundRect(tm.c * TILE + 8, tm.r * TILE + 30, TILE * 2 - 30, 16, 6)
    .fill(p.chair)
    .rect((tm.c + 2) * TILE - 18, tm.r * TILE - 8, 5, 38)
    .fill(p.metal)
    .roundRect((tm.c + 2) * TILE - 28, tm.r * TILE - 14, 24, 12, 4)
    .fill(p.monitor)
    .rect((tm.c + 2) * TILE - 24, tm.r * TILE - 11, 14, 5)
    .fill(p.accent);
  pieces.push(treadmill);

  // Toilet stall: partitions above and below the bowl.
  const wc = layout.spots.toilet;
  const stallBack = piece((wc.r - 1) * TILE + TILE - 2);
  stallBack
    .roundRect(wc.c * TILE - 6, (wc.r - 1) * TILE + 20, TILE * 2 + 6, TILE * 0.6, 6)
    .fill(p.wall)
    .roundRect(wc.c * TILE + 10, wc.r * TILE + 6, 24, 18, 6)
    .fill(0xffffff)
    .roundRect(wc.c * TILE + 6, wc.r * TILE + 18, 32, 26, 13)
    .fill(0xffffff)
    .ellipse(wc.c * TILE + 22, wc.r * TILE + 30, 11, 7)
    .fill(0xdfe7ee);
  const stallFront = piece((wc.r + 1) * TILE + TILE - 2);
  stallFront
    .roundRect(wc.c * TILE - 6, (wc.r + 1) * TILE + 24, TILE * 2 + 6, TILE * 0.55, 6)
    .fill(p.wall)
    .roundRect((wc.c + 1) * TILE + 20, (wc.r + 1) * TILE + 32, 12, 8, 4)
    .fill(0x5ccf7a);
  pieces.push(stallBack, stallFront);

  // Plants in the corners.
  for (const [c, r] of [
    [15, 1],
    [1, layout.rows - 2],
    [15, layout.rows - 2],
  ] as const) {
    const plant = piece((r + 1) * TILE - 6);
    const x = (c + 0.5) * TILE;
    const y = (r + 1) * TILE - 10;
    plant
      .roundRect(x - 10, y - 16, 20, 18, 4)
      .fill(p.deskFront)
      .circle(x, y - 28, 14)
      .fill(p.plant)
      .circle(x - 9, y - 22, 9)
      .fill(p.plant)
      .circle(x + 9, y - 22, 9)
      .fill(p.plant);
    pieces.push(plant);
  }

  return { floor, pieces, monitors };
}
