// FILE: astar.ts
// Purpose: 4-way grid pathfinding for office characters, who walk tile to tile.
// Layer: Web office logic (pure)
// Exports: findPath, TilePoint

export interface TilePoint {
  readonly c: number;
  readonly r: number;
}

const STEPS: readonly TilePoint[] = [
  { c: 1, r: 0 },
  { c: -1, r: 0 },
  { c: 0, r: 1 },
  { c: 0, r: -1 },
];

/**
 * Shortest 4-way path from `start` to `goal`, both included, or null when unreachable.
 * The goal itself may be blocked (a seat or a doorway), so callers can path onto furniture spots.
 */
// ponytail: linear open-list scan, fine for a ~15x13 office; use a binary heap if the grid grows.
export function findPath(
  cols: number,
  rows: number,
  isBlocked: (c: number, r: number) => boolean,
  start: TilePoint,
  goal: TilePoint,
): TilePoint[] | null {
  const key = (c: number, r: number) => r * cols + c;
  const inside = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows;
  if (!inside(start.c, start.r) || !inside(goal.c, goal.r)) return null;
  const goalKey = key(goal.c, goal.r);
  const heuristic = (c: number, r: number) => Math.abs(c - goal.c) + Math.abs(r - goal.r);
  const gScore = new Map<number, number>([[key(start.c, start.r), 0]]);
  const cameFrom = new Map<number, number>();
  const open = new Map<number, number>([[key(start.c, start.r), heuristic(start.c, start.r)]]);
  const closed = new Set<number>();

  while (open.size > 0) {
    let current = -1;
    let best = Infinity;
    for (const [candidate, f] of open) {
      if (f < best) {
        best = f;
        current = candidate;
      }
    }
    if (current === goalKey) {
      const path: TilePoint[] = [];
      for (let k: number | undefined = current; k !== undefined; k = cameFrom.get(k)) {
        path.push({ c: k % cols, r: Math.floor(k / cols) });
      }
      return path.toReversed();
    }
    open.delete(current);
    closed.add(current);
    const cc = current % cols;
    const cr = Math.floor(current / cols);
    for (const step of STEPS) {
      const nc = cc + step.c;
      const nr = cr + step.r;
      const next = key(nc, nr);
      if (!inside(nc, nr) || closed.has(next)) continue;
      if (next !== goalKey && isBlocked(nc, nr)) continue;
      const tentative = (gScore.get(current) ?? Infinity) + 1;
      if (tentative >= (gScore.get(next) ?? Infinity)) continue;
      cameFrom.set(next, current);
      gScore.set(next, tentative);
      open.set(next, tentative + heuristic(nc, nr));
    }
  }
  return null;
}
