// Sokoban solver — make.fun bounty "sokoban-solver-01-run-20261121".
//
// Idea: every level is a one-square-wide hallway with one to four rooms off
// it, each room holding 3-4 boxes and as many goals, opening onto the hallway
// through a single door. A box pushed out of its room into the hallway can
// never be pushed back (the hallway is one wide, so the player can never get
// behind it), so in any solving line every box stays in its room and each
// room is an independent subproblem. The level's push-optimal count is the
// sum of the rooms' optima.
//
// So: split the level into rooms, solve each room push-optimally in push
// space with A* (admissible min-cost box-to-goal matching over BFS distances
// ignoring boxes, plus corner / 2x2 / freeze / wall-line / dead-cell
// pruning), solve every room twice — once free, once requiring the player to
// be able to leave through the door afterwards — make the room where leaving
// costs the most pushes the last one (it needs no exit), and stitch the room
// solutions together with hallway walks.
//
// Deterministic: fixed node budgets, no clock, no randomness, fixed tie
// breaks. Node 22, TypeScript with erasable syntax only, no dependencies.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Deterministic cap on A* expansions per room search (never the clock). */
const MAX_EXPANSIONS = 500000;

const DIRS = [
  { dx: 0, dy: -1, ch: 'u', push: 'U' },
  { dx: 0, dy: 1, ch: 'd', push: 'D' },
  { dx: -1, dy: 0, ch: 'l', push: 'L' },
  { dx: 1, dy: 0, ch: 'r', push: 'R' },
];

interface Level {
  w: number;
  h: number;
  floor: Uint8Array; // 1 = walkable (anything but '#')
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

interface Room {
  cells: number[]; // room floor cells
  inRoom: Uint8Array; // mask over the board
  boxes: number[];
  goals: number[];
  portals: number[]; // room cells adjacent to a hallway cell
  entries: number[]; // hallway cells adjacent to a portal
}

interface RoomSolution {
  pushes: number;
  moves: string; // walks lowercase, pushes uppercase; player starts at the entry
  endPlayer: number; // player cell when the room's moves end
  expansions: number;
}

/** Parse XSB: '#' wall, ' ' floor, '.' goal, '$' box, '*' box on goal, '@' player, '+' player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const n = w * h;
  const floor = new Uint8Array(n);
  const goal = new Uint8Array(n);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      floor[i] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  if (player < 0) throw new Error('no player in level');
  return { w, h, floor, goal, boxes, player };
}

/** A mask with 1s on the given cells. */
function blockedMask(cells: readonly number[], n: number): Uint8Array {
  const m = new Uint8Array(n);
  for (const c of cells) m[c] = 1;
  return m;
}

/** BFS over walkable cells, treating `blocked` as obstacles. Returns the
 *  parent map (parent[start] = -1) and the reached set. */
function bfsParents(
  start: number,
  blocked: Uint8Array,
  floor: Uint8Array,
  w: number,
  h: number,
): { parent: Int32Array; seen: Uint8Array } {
  const n = w * h;
  const parent = new Int32Array(n).fill(-2);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  parent[start] = -1;
  seen[start] = 1;
  queue[qt++] = start;
  while (qh < qt) {
    const c = queue[qh++];
    const x = c % w;
    const y = (c / w) | 0;
    if (x > 0) {
      const nb = c - 1;
      if (!seen[nb] && floor[nb] === 1 && !blocked[nb]) { seen[nb] = 1; parent[nb] = c; queue[qt++] = nb; }
    }
    if (x + 1 < w) {
      const nb = c + 1;
      if (!seen[nb] && floor[nb] === 1 && !blocked[nb]) { seen[nb] = 1; parent[nb] = c; queue[qt++] = nb; }
    }
    if (y > 0) {
      const nb = c - w;
      if (!seen[nb] && floor[nb] === 1 && !blocked[nb]) { seen[nb] = 1; parent[nb] = c; queue[qt++] = nb; }
    }
    if (y + 1 < h) {
      const nb = c + w;
      if (!seen[nb] && floor[nb] === 1 && !blocked[nb]) { seen[nb] = 1; parent[nb] = c; queue[qt++] = nb; }
    }
  }
  return { parent, seen };
}

/** The move string (lowercase) from `start` to `target` along a BFS parent map; '' if unreachable. */
function pathString(parent: Int32Array, start: number, target: number, w: number): string {
  const chars: string[] = [];
  let cur = target;
  while (cur !== start) {
    const p = parent[cur];
    if (p < 0) return '';
    const d = cur - p;
    if (d === 1) chars.push('r');
    else if (d === -1) chars.push('l');
    else if (d === w) chars.push('d');
    else if (d === -w) chars.push('u');
    else return '';
    cur = p;
  }
  chars.reverse();
  return chars.join('');
}

/** Split the level into rooms: the hallway is the player's row; removing it
 *  leaves one connected component per room. */
function findRooms(level: Level): Room[] {
  const { w, h, floor, boxes, player } = level;
  const hy = (player / w) | 0;
  const inHallwayRow = (c: number): boolean => ((c / w) | 0) === hy;
  const boxSet = new Set(boxes);
  const visited = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let c = 0; c < w * h; c++) {
    if (floor[c] !== 1 || inHallwayRow(c) || visited[c] === 1) continue;
    const comp: number[] = [];
    const queue: number[] = [c];
    visited[c] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      comp.push(cur);
      const x = cur % w;
      const y = (cur / w) | 0;
      if (x > 0) {
        const nb = cur - 1;
        if (floor[nb] === 1 && !inHallwayRow(nb) && visited[nb] === 0) { visited[nb] = 1; queue.push(nb); }
      }
      if (x + 1 < w) {
        const nb = cur + 1;
        if (floor[nb] === 1 && !inHallwayRow(nb) && visited[nb] === 0) { visited[nb] = 1; queue.push(nb); }
      }
      if (y > 0) {
        const nb = cur - w;
        if (floor[nb] === 1 && !inHallwayRow(nb) && visited[nb] === 0) { visited[nb] = 1; queue.push(nb); }
      }
      if (y + 1 < h) {
        const nb = cur + w;
        if (floor[nb] === 1 && !inHallwayRow(nb) && visited[nb] === 0) { visited[nb] = 1; queue.push(nb); }
      }
    }
    const compBoxes = comp.filter((cell) => boxSet.has(cell)).sort((a, b) => a - b);
    if (compBoxes.length === 0) continue; // empty pocket, nothing to solve
    const goals = comp.filter((cell) => level.goal[cell] === 1);
    const portals: number[] = [];
    const entries: number[] = [];
    const entrySet = new Set<number>();
    for (const cell of comp) {
      const x = cell % w;
      const y = (cell / w) | 0;
      const nbs: number[] = [];
      if (x > 0) nbs.push(cell - 1);
      if (x + 1 < w) nbs.push(cell + 1);
      if (y > 0) nbs.push(cell - w);
      if (y + 1 < h) nbs.push(cell + w);
      for (const nb of nbs) {
        if (inHallwayRow(nb) && floor[nb] === 1) {
          portals.push(cell);
          if (!entrySet.has(nb)) { entrySet.add(nb); entries.push(nb); }
          break;
        }
      }
    }
    const inRoom = new Uint8Array(w * h);
    for (const cell of comp) inRoom[cell] = 1;
    rooms.push({ cells: comp, inRoom, boxes: compBoxes, goals, portals, entries });
  }
  return rooms;
}

/** Push-optimal A* for one room. The player starts at `entryCell` (a hallway
 *  cell next to the room's door); boxes may only be pushed within the room.
 *  When `requireExit` is set, the goal also requires the player to be able to
 *  reach a door cell afterwards (so the next room can be reached). Returns
 *  null when no solution is found within the expansion budget. */
function solveRoom(room: Room, level: Level, entryCell: number, requireExit: boolean): RoomSolution | null {
  const { w, h, floor, goal } = level;
  const n = w * h;
  const nb = room.boxes.length;
  if (nb === 0) return { pushes: 0, moves: '', endPlayer: entryCell, expansions: 0 };

  // BFS distances from each goal over room cells, boxes ignored.
  const goalDist: Int32Array[] = [];
  for (const g of room.goals) {
    const dist = new Int32Array(n).fill(-1);
    const q: number[] = [g];
    dist[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!;
      const x = cur % w;
      const y = (cur / w) | 0;
      if (x > 0) {
        const nb2 = cur - 1;
        if (room.inRoom[nb2] === 1 && dist[nb2] === -1) { dist[nb2] = dist[cur]! + 1; q.push(nb2); }
      }
      if (x + 1 < w) {
        const nb2 = cur + 1;
        if (room.inRoom[nb2] === 1 && dist[nb2] === -1) { dist[nb2] = dist[cur]! + 1; q.push(nb2); }
      }
      if (y > 0) {
        const nb2 = cur - w;
        if (room.inRoom[nb2] === 1 && dist[nb2] === -1) { dist[nb2] = dist[cur]! + 1; q.push(nb2); }
      }
      if (y + 1 < h) {
        const nb2 = cur + w;
        if (room.inRoom[nb2] === 1 && dist[nb2] === -1) { dist[nb2] = dist[cur]! + 1; q.push(nb2); }
      }
    }
    goalDist.push(dist);
  }
  // Dead cells: room cells from which no goal is reachable, boxes ignored.
  const deadCell = new Uint8Array(n);
  for (const cell of room.cells) {
    let ok = false;
    for (let gi = 0; gi < room.goals.length; gi++) {
      if (goalDist[gi]![cell] >= 0) { ok = true; break; }
    }
    if (!ok) deadCell[cell] = 1;
  }

  /** Is the neighbour of `cell` in direction (dx, dy) a wall (edge or '#')? */
  const wallOnSide = (cell: number, dx: number, dy: number): boolean => {
    const x = cell % w;
    const y = (cell / w) | 0;
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= w || ny < 0 || ny >= h) return true;
    return floor[ny * w + nx] === 0;
  };

  /** The box at `cell` leans on a wall on the (wdx, wdy) side and can only
   *  slide along the wall. It is dead when no goal lies in the wall segment
   *  AND the box cannot slide off either end of the segment (an end where
   *  the wall stops is an escape: the box slides there and is pushed away). */
  const wallLineDead = (cell: number, wdx: number, wdy: number): boolean => {
    const steps: [number, number][] = wdy !== 0 ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    let closedEnds = 0;
    for (const [sdx, sdy] of steps) {
      let x = cell % w;
      let y = (cell / w) | 0;
      for (;;) {
        const c = y * w + x;
        if (floor[c] === 0) { closedEnds++; break; } // a wall cell: cannot slide past
        if (!wallOnSide(c, wdx, wdy)) break; // the wall stops: an escape
        if (goal[c] === 1) return false; // a goal in the segment
        x += sdx;
        y += sdy;
        if (x < 0 || x >= w || y < 0 || y >= h) { closedEnds++; break; } // board edge
      }
    }
    return closedEnds === 2;
  };

  /** Deadlock test for one box (not on a goal). Only ever prunes states from
   *  which the level can no longer be solved; hallway cells count as open. */
  const isDeadBox = (cell: number, boxSet: ReadonlySet<number>): boolean => {
    if (goal[cell] === 1) return false;
    if (deadCell[cell] === 1) return true;
    const x = cell % w;
    const y = (cell / w) | 0;
    const blocked = (nx: number, ny: number): boolean => {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) return true;
      const c = ny * w + nx;
      return floor[c] === 0 || boxSet.has(c);
    };
    const upWall = wallOnSide(cell, 0, -1);
    const downWall = wallOnSide(cell, 0, 1);
    const leftWall = wallOnSide(cell, -1, 0);
    const rightWall = wallOnSide(cell, 1, 0);
    if ((upWall && leftWall) || (upWall && rightWall) || (downWall && leftWall) || (downWall && rightWall)) return true;
    if (blocked(x, y - 1) && blocked(x, y + 1) && blocked(x - 1, y) && blocked(x + 1, y)) return true;
    for (let ox = -1; ox <= 0; ox++) {
      for (let oy = -1; oy <= 0; oy++) {
        const tx = x + ox;
        const ty = y + oy;
        if (tx < 0 || ty < 0 || tx + 1 >= w || ty + 1 >= h) continue;
        if (blocked(tx, ty) && blocked(tx + 1, ty) && blocked(tx, ty + 1) && blocked(tx + 1, ty + 1)) return true;
      }
    }
    if (upWall && wallLineDead(cell, 0, -1)) return true;
    if (downWall && wallLineDead(cell, 0, 1)) return true;
    if (leftWall && wallLineDead(cell, -1, 0)) return true;
    if (rightWall && wallLineDead(cell, 1, 0)) return true;
    return false;
  };

  /** Admissible heuristic: min-cost matching of boxes to goals over the
   *  box-ignoring BFS distances (each push moves one box one square). */
  const matchingCost = (boxes: readonly number[]): number => {
    if (boxes.length > room.goals.length) return Infinity;
    const used = new Array<boolean>(room.goals.length).fill(false);
    let best = Infinity;
    const rec = (i: number, cost: number): void => {
      if (cost >= best) return;
      if (i === boxes.length) { best = cost; return; }
      for (let j = 0; j < room.goals.length; j++) {
        if (used[j]) continue;
        const d = goalDist[j]![boxes[i]!]!;
        if (d < 0) continue;
        used[j] = true;
        rec(i + 1, cost + d);
        used[j] = false;
      }
    };
    rec(0, 0);
    return best;
  };

  interface State {
    boxes: number[]; // sorted
    player: number;
    g: number; // pushes so far
    h: number;
    parent: number; // index into states, -1 for the start
    seg: string; // walk + push that led here from the parent
  }

  const states: State[] = [];
  const closed = new Set<string>();
  const heap: number[] = [];
  const less = (a: number, b: number): boolean => {
    const sa = states[a]!;
    const sb = states[b]!;
    const fa = sa.g + sa.h;
    const fb = sb.g + sb.h;
    if (fa !== fb) return fa < fb;
    if (sa.h !== sb.h) return sa.h < sb.h;
    return a < b;
  };
  const heapPush = (i: number): void => {
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c]!, heap[p]!)) break;
      const t = heap[c]!;
      heap[c] = heap[p]!;
      heap[p] = t;
      c = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === p) break;
        const t = heap[p]!;
        heap[p] = heap[m]!;
        heap[m] = t;
        p = m;
      }
    }
    return top;
  };

  const reconstruct = (si: number, tail: string, endPlayer: number, expansions: number): RoomSolution => {
    const segs: string[] = [];
    let cur: number = si;
    while (cur !== -1) {
      const s = states[cur]!;
      if (s.seg !== '') segs.push(s.seg);
      cur = s.parent;
    }
    segs.reverse();
    return { pushes: states[si]!.g, moves: segs.join('') + tail, endPlayer, expansions };
  };

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const startH = matchingCost(startBoxes);
  if (startH === Infinity) return null;
  states.push({ boxes: startBoxes, player: entryCell, g: 0, h: startH, parent: -1, seg: '' });
  heapPush(0);
  let expansions = 0;
  while (heap.length > 0) {
    const si = heapPop();
    const st = states[si]!;
    const key = st.boxes.join(',') + '|' + st.player;
    if (closed.has(key)) continue;
    closed.add(key);
    if (expansions >= MAX_EXPANSIONS) return null;
    expansions++;
    const blocked = blockedMask(st.boxes, n);
    const { parent, seen } = bfsParents(st.player, blocked, floor, w, h);
    let solved = true;
    for (const b of st.boxes) {
      if (goal[b] !== 1) { solved = false; break; }
    }
    if (solved) {
      if (!requireExit) return reconstruct(si, '', st.player, expansions);
      let best: string | null = null;
      let bestPortal = -1;
      for (const p of room.portals) {
        if (seen[p] === 1) {
          const path = pathString(parent, st.player, p, w);
          if (best === null || path.length < best.length) { best = path; bestPortal = p; }
        }
      }
      if (best !== null) return reconstruct(si, best, bestPortal, expansions);
      // Solved but the player is walled off from every door: keep searching,
      // a box may have to be pushed aside to let the player out.
    }
    const boxSet = new Set(st.boxes);
    for (let bi = 0; bi < st.boxes.length; bi++) {
      const b = st.boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (const dir of DIRS) {
        const nx = bx + dir.dx;
        const ny = by + dir.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const dest = ny * w + nx;
        if (room.inRoom[dest] !== 1) continue;
        if (boxSet.has(dest)) continue;
        const hx = bx - dir.dx;
        const hy = by - dir.dy;
        if (hx < 0 || hx >= w || hy < 0 || hy >= h) continue;
        const behind = hy * w + hx;
        if (seen[behind] !== 1) continue;
        const newBoxes = [...st.boxes];
        newBoxes[bi] = dest;
        newBoxes.sort((a, b2) => a - b2);
        const newBoxSet = new Set(newBoxes);
        let dead = false;
        for (const nb2 of newBoxes) {
          if (isDeadBox(nb2, newBoxSet)) { dead = true; break; }
        }
        if (dead) continue;
        const newH = matchingCost(newBoxes);
        if (newH === Infinity) continue;
        const walk = pathString(parent, st.player, behind, w);
        states.push({ boxes: newBoxes, player: b, g: st.g + 1, h: newH, parent: si, seg: walk + dir.push });
        heapPush(states.length - 1);
      }
    }
  }
  return null;
}

/** Solve one whole level: rooms in turn, stitched with hallway walks. */
function solveLevel(level: Level): string {
  const rooms = findRooms(level);
  const inRoomBoxes = new Set<number>();
  for (const r of rooms) for (const b of r.boxes) inRoomBoxes.add(b);
  for (const b of level.boxes) {
    if (!inRoomBoxes.has(b)) throw new Error('a box is not in any room');
  }
  if (rooms.length === 0) {
    if (level.boxes.length === 0) return '';
    throw new Error('boxes but no rooms');
  }
  const plans: { room: Room; unc: RoomSolution; con: RoomSolution }[] = [];
  for (const room of rooms) {
    if (room.portals.length === 0) throw new Error('a room has no door');
    const entry = room.entries[0]!;
    const unc = solveRoom(room, level, entry, false);
    const con = solveRoom(room, level, entry, true);
    if (unc === null || con === null) throw new Error('a room has no solution');
    plans.push({ room, unc, con });
  }
  // The room where requiring an exit costs the most pushes goes last (it needs no exit).
  let lastIdx = 0;
  let maxPenalty = -Infinity;
  plans.forEach((p, i) => {
    const penalty = p.con.pushes - p.unc.pushes;
    if (penalty > maxPenalty) { maxPenalty = penalty; lastIdx = i; }
  });
  const order: number[] = plans.map((_, i) => i).filter((i) => i !== lastIdx);
  order.sort((a, b) => plans[a]!.room.portals[0]! - plans[b]!.room.portals[0]!);
  order.push(lastIdx);
  let playerPos = level.player;
  const curBoxes = new Set<number>(level.boxes);
  let out = '';
  for (const idx of order) {
    const p = plans[idx]!;
    const isLast = idx === lastIdx;
    const sol = isLast ? p.unc : p.con;
    const entry = p.room.entries[0]!;
    const blocked = blockedMask([...curBoxes], level.w * level.h);
    const { parent, seen } = bfsParents(playerPos, blocked, level.floor, level.w, level.h);
    if (seen[entry] !== 1) throw new Error('cannot reach a room door');
    out += pathString(parent, playerPos, entry, level.w);
    out += sol.moves;
    for (const b of p.room.boxes) curBoxes.delete(b);
    for (const g of p.room.goals) curBoxes.add(g);
    playerPos = sol.endPlayer;
  }
  return out;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
    moves = solveLevel(parseLevel(text));
  } catch {
    moves = ''; // valid empty answer: 0 points for this instance, but the set stays answered
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
}
