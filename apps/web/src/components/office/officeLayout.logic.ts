// FILE: officeLayout.logic.ts
// Purpose: Front-on office floor plan that grows with the number of agents. Two desk columns,
//          one desk row per four map rows, amenities in the left wing (Marvis-style layout).
// Layer: Web office logic (pure)
// Exports: officeLayout, OfficeLayout, DeskSlot, TILE, cellCenter

import type { TilePoint } from "./astar";

export const TILE = 64;
const BASE_COLS = 17;
const BASE_ROWS = 14;
/** Desk rows sit every four map rows starting at row 2. */
const FIRST_DESK_ROW = 2;
const DESK_ROW_STEP = 4;
/** Seat columns: the left column faces right toward its desk, the right column faces left. */
const LEFT_SEAT_COL = 8;
const RIGHT_SEAT_COL = 14;

export interface DeskSlot {
  readonly index: number;
  readonly boss: boolean;
  /** Where the character sits; the chair occupies this cell. */
  readonly seat: TilePoint;
  /** Corridor cell beside the chair; characters walk here before climbing on. */
  readonly stand: TilePoint;
  /** Two desk cells, ordered left to right. */
  readonly desk: readonly [TilePoint, TilePoint];
  /** +1 faces right (toward a desk on the right), -1 faces left. */
  readonly facing: 1 | -1;
}

export interface OfficeSpots {
  readonly door: TilePoint;
  readonly water: TilePoint;
  readonly treadmill: TilePoint;
  readonly toilet: TilePoint;
  /** Full-width corridor rows the cat walks along. */
  readonly corridorRows: readonly number[];
}

export interface OfficeLayout {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly desks: readonly DeskSlot[];
  readonly spots: OfficeSpots;
  readonly isBlocked: (c: number, r: number) => boolean;
}

export function cellCenter(cell: TilePoint): { x: number; y: number } {
  return { x: (cell.c + 0.5) * TILE, y: (cell.r + 0.5) * TILE };
}

function deskSlot(index: number): DeskSlot {
  const row = FIRST_DESK_ROW + Math.floor(index / 2) * DESK_ROW_STEP;
  if (index % 2 === 0) {
    return {
      index,
      boss: index === 0,
      seat: { c: LEFT_SEAT_COL, r: row },
      stand: { c: LEFT_SEAT_COL - 1, r: row },
      desk: [
        { c: LEFT_SEAT_COL + 1, r: row },
        { c: LEFT_SEAT_COL + 2, r: row },
      ],
      facing: 1,
    };
  }
  return {
    index,
    boss: false,
    seat: { c: RIGHT_SEAT_COL, r: row },
    stand: { c: RIGHT_SEAT_COL + 1, r: row },
    desk: [
      { c: RIGHT_SEAT_COL - 2, r: row },
      { c: RIGHT_SEAT_COL - 1, r: row },
    ],
    facing: -1,
  };
}

/** Layout for `deskCount` desks; never smaller than Marvis' 17x14 room with six desks. */
export function officeLayout(deskCount: number): OfficeLayout {
  const desks = Array.from({ length: Math.max(6, deskCount) }, (_, index) => deskSlot(index));
  const lastDeskRow = desks[desks.length - 1]!.seat.r;
  const rows = Math.max(BASE_ROWS, lastDeskRow + DESK_ROW_STEP);
  const cols = BASE_COLS;
  const spots: OfficeSpots = {
    door: { c: 0, r: 4 },
    water: { c: 2, r: 2 },
    treadmill: { c: 4, r: 6 },
    toilet: { c: 2, r: 11 },
    corridorRows: Array.from({ length: desks.length / 2 }, (_, i) => FIRST_DESK_ROW + 2 + i * 4),
  };

  const blocked = new Uint8Array(cols * rows);
  const block = (c: number, r: number) => {
    if (c >= 0 && r >= 0 && c < cols && r < rows) blocked[r * cols + c] = 1;
  };
  for (let c = 0; c < cols; c += 1) {
    block(c, 0);
    block(c, rows - 1);
  }
  for (let r = 0; r < rows; r += 1) {
    block(0, r);
    block(cols - 1, r);
  }
  for (const slot of desks) {
    block(slot.seat.c, slot.seat.r);
    for (const cell of slot.desk) block(cell.c, cell.r);
  }
  // Water bar along the top wall, treadmill, toilet stall walls.
  block(1, 1);
  block(2, 1);
  block(3, 1);
  block(spots.treadmill.c, spots.treadmill.r);
  block(spots.treadmill.c + 1, spots.treadmill.r);
  block(spots.toilet.c, spots.toilet.r);
  block(spots.toilet.c + 1, spots.toilet.r - 1);
  block(spots.toilet.c + 1, spots.toilet.r + 1);
  // Corner plants.
  block(15, 1);
  block(1, rows - 2);
  block(15, rows - 2);
  // The doorway is a gap in the left wall.
  blocked[spots.door.r * cols + spots.door.c] = 0;

  return {
    cols,
    rows,
    width: cols * TILE,
    height: rows * TILE,
    desks,
    spots,
    isBlocked: (c, r) => c < 0 || r < 0 || c >= cols || r >= rows || blocked[r * cols + c] === 1,
  };
}

/**
 * First-fit zoom boost: a fresh office starts 10% zoomed in and eases back to a plain fit
 * (smoothstep over `progress` 0..1).
 */
export function officeFitBoost(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  const s = t * t * (3 - 2 * t);
  return 1.1 + (1 - 1.1) * s;
}
