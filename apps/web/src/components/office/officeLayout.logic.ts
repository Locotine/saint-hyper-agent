// FILE: officeLayout.logic.ts
// Purpose: Front-on office floor plan (camera tilted 28°, desks horizontal) that grows with the
//          number of agents: root supervisor desk on top, nested supervisors below it, then a
//          two-column grid of specialist desks; coffee bar, treadmill and WC in the left column.
// Layer: Web office logic (pure)
// Exports: officeLayout, OfficeLayout, DeskSlot, TILE, cellCenter, officeFitBoost

import type { TilePoint } from "./astar";
import type { OfficeTier } from "./officeModel.logic";

export const TILE = 64;
const COLS = 12;
const MIN_ROWS = 11;
const MIN_LEAVES = 4;
const ROOT_DESK_ROW = 1;
const NESTED_FIRST_ROW = 3;
/** Each desk row is followed by one corridor row. */
const BAND_ROWS = 2;
/**
 * Desk columns close to the amenity column and to each other, like the reference image: anchor
 * x, blocked cells, and the corridor cell a character stands on before sitting down. The centre
 * column (root and a lone nested supervisor) sits between the two specialist columns.
 */
type DeskColumn = "left" | "center" | "right";
const DESK_COLUMNS: Readonly<
  Record<
    DeskColumn,
    { readonly x: number; readonly cells: readonly number[]; readonly stand: number }
  >
> = {
  left: { x: 6 * TILE, cells: [5, 6], stand: 5 },
  center: { x: 7.5 * TILE, cells: [6, 7, 8], stand: 7 },
  right: { x: 9 * TILE, cells: [8, 9], stand: 9 },
};
/** Desk anchors sit this far below the top of their desk row. */
const DESK_ANCHOR_Y = 40;
/**
 * A seated character's feet sit this far below the desk anchor; raised from the pack's +14 so
 * head, shoulders and scarf clear the chair backrest as in the reference image.
 */
export const SEAT_OFFSET_Y = 10;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface DeskSlot {
  readonly index: number;
  readonly tier: OfficeTier;
  /** Specialist desk variant (0-4); 0 for supervisors. */
  readonly variant: number;
  /** Desk sprite anchor in world px; chair, monitor and the seated character hang off it. */
  readonly anchor: Point;
  /** Corridor cell below the chair; characters walk here before sitting down. */
  readonly stand: TilePoint;
  /** Desk cells, ordered left to right. */
  readonly desk: readonly TilePoint[];
}

export interface OfficeSpots {
  readonly door: TilePoint;
  readonly coffee: TilePoint;
  readonly treadmill: TilePoint;
  readonly toilet: TilePoint;
}

/** World anchors of the amenity sprites and where a character stands or sits on them. */
export interface OfficeAmenities {
  readonly coffeeCounter: Point;
  /** Behind the counter, like the barista in the reference image. */
  readonly barista: Point;
  readonly coffeeMachine: Point;
  readonly treadmill: Point;
  readonly runner: Point;
  readonly toilet: Point;
  readonly sitter: Point;
  readonly wcWall: Point;
  readonly wcDoor: Point;
}

export interface OfficeLayout {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** World box holding the furniture; the view fits this, not the walkable margin around it. */
  readonly content: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Index 0 is the root desk, then `nested` supervisor desks, then specialist desks. */
  readonly desks: readonly DeskSlot[];
  readonly spots: OfficeSpots;
  readonly amenities: OfficeAmenities;
  readonly isBlocked: (c: number, r: number) => boolean;
}

export function cellCenter(cell: TilePoint): Point {
  return { x: (cell.c + 0.5) * TILE, y: (cell.r + 0.5) * TILE };
}

export function seatPoint(slot: DeskSlot): Point {
  return { x: slot.anchor.x, y: slot.anchor.y + SEAT_OFFSET_Y };
}

function deskSlot(
  index: number,
  tier: OfficeTier,
  variant: number,
  column: DeskColumn,
  row: number,
): DeskSlot {
  const { x, cells, stand } = DESK_COLUMNS[column];
  return {
    index,
    tier,
    variant,
    anchor: { x, y: row * TILE + DESK_ANCHOR_Y },
    stand: { c: stand, r: row + 1 },
    desk: cells.map((c) => ({ c, r: row })),
  };
}

/** Desk index of the first specialist desk for `nested` nested supervisors. */
export function firstLeafDesk(nested: number): number {
  return 1 + nested;
}

/**
 * Layout for `nested` nested supervisors and `leaves` specialist desks (at least four). Nested
 * desks fill rows of two below the root, a lone one centred; one nested row is always reserved
 * so specialists do not move when a supervisor is promoted or demoted.
 */
export function officeLayout(counts: {
  readonly nested: number;
  readonly leaves: number;
}): OfficeLayout {
  const nestedRows = Math.max(1, Math.ceil(counts.nested / 2));
  const leafCount = Math.max(MIN_LEAVES, counts.leaves + (counts.leaves % 2));
  const desks: DeskSlot[] = [deskSlot(0, "root", 0, "center", ROOT_DESK_ROW)];
  for (let i = 0; i < counts.nested; i += 1) {
    const row = NESTED_FIRST_ROW + Math.floor(i / 2) * BAND_ROWS;
    const lone = i === counts.nested - 1 && i % 2 === 0;
    const column = lone ? "center" : i % 2 === 0 ? "left" : "right";
    desks.push(deskSlot(desks.length, "nested", 0, column, row));
  }
  const leafFirstRow = NESTED_FIRST_ROW + nestedRows * BAND_ROWS;
  for (let i = 0; i < leafCount; i += 1) {
    const row = leafFirstRow + Math.floor(i / 2) * BAND_ROWS;
    desks.push(deskSlot(desks.length, "leaf", i, i % 2 === 0 ? "left" : "right", row));
  }
  const lastDeskRow = desks[desks.length - 1]!.desk[0]!.r;
  const rows = Math.max(MIN_ROWS, lastDeskRow + 3);
  const cols = COLS;

  const spots: OfficeSpots = {
    door: { c: 0, r: 3 },
    coffee: { c: 4, r: 1 },
    treadmill: { c: 3, r: 4 },
    toilet: { c: 2, r: 8 },
  };
  const amenities: OfficeAmenities = {
    coffeeCounter: { x: 3 * TILE, y: TILE + DESK_ANCHOR_Y },
    barista: { x: 3 * TILE + 26, y: TILE + 6 },
    coffeeMachine: { x: 3 * TILE - 34, y: TILE + 14 },
    treadmill: { x: 3 * TILE, y: 4 * TILE + DESK_ANCHOR_Y },
    runner: { x: 3 * TILE + 10, y: 4 * TILE + DESK_ANCHOR_Y - 2 },
    toilet: { x: 2 * TILE + 20, y: 7 * TILE + 44 },
    sitter: { x: 2 * TILE + 28, y: 7 * TILE + 50 },
    wcWall: { x: 2 * TILE + 34, y: 7 * TILE + 46 },
    wcDoor: { x: 3 * TILE + 20, y: 7 * TILE + 58 },
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
  for (const slot of desks) for (const cell of slot.desk) block(cell.c, cell.r);
  // Coffee counter, treadmill, WC stall (toilet and door).
  block(2, 1);
  block(3, 1);
  block(2, 4);
  block(3, 4);
  block(2, 7);
  block(3, 7);
  // The doorway is a gap in the left wall.
  blocked[spots.door.r * cols + spots.door.c] = 0;

  // Desk chairs reach ~100px below their row; the WC stall (row 7) is the amenity column's end.
  const contentBottom = Math.max(lastDeskRow, 7) * TILE + 100;
  return {
    cols,
    rows,
    width: cols * TILE,
    height: rows * TILE,
    content: { x: TILE, y: 0, width: (cols - 2) * TILE, height: contentBottom },
    desks,
    spots,
    amenities,
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
