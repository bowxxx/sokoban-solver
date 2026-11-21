// A push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// The levels this contest draws are a hallway with independent rooms off it:
// a box can never leave its room, so a level's push-optimal count is the sum of
// its rooms' optima. This solver cuts the level into rooms, solves each room
// on its own with A* over pushes, and joins the rooms by the player's walk.
//
// A room's search: a state is the boxes' squares and the player's reachable
// region (named by its lowest square, which names the region exactly, since
// regions are disjoint connected components). The estimate is the minimum
// assignment of boxes to goals by grid distance (admissible and consistent:
// each push moves one box one square, and each box must reach a distinct
// goal). Two sound prunings: a box on a dead square (one from which no pull
// reaches a goal) and a box in a frozen 2 x 2 block of walls and boxes with a
// box off its goal. The first solved state popped is push-optimal.
//
// Pure and deterministic: every budget is a count of work, never the clock,
// and ties break by square and insertion order, so two runs write the same
// bytes. Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input
// MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, walk letter, push letter]. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** Work budgets, in states expanded: deterministic on every run, never the clock. */
const ASTAR_CAP = 250_000;
const BFS_CAP = 250_000;
const GREEDY_CAP = 100_000;
const GREEDY_PUSHES = 500;
const TOTAL_BUDGET = 3_000_000;
let spent = 0;

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };
type Solved = { pushes: number; moves: string };

/** A level in XSB (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals: goals.sort((a, b) => a - b), boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pulled onto some goal. */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goals } = lv;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The lowest square of the region reachable from `from` around walls and the
 * boxes in `occupied`, marking it in `seen` with `stamp`. The lowest square
 * names the region: regions are disjoint, so two regions never share one.
 */
function regionLow(lv: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = lv;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block with a box off its goal. */
function frozenBlock(lv: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = lv;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(lv: Level, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const { w, wall } = lv;
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** Popcounts for masks 0..15 (rooms hold at most 4 boxes). */
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/**
 * The minimum assignment of `boxes` to goals by grid distance, or Infinity
 * when no box reaches every goal it could take. `dist[j]` holds the BFS
 * distances from goal j over the walls alone. Admissible and consistent.
 */
function assignment(boxes: number[], dist: Int32Array[], scratch: Float64Array): number {
  const n = boxes.length;
  if (n > 4) {
    // Rooms never hold more than 4 boxes; past that, the sum of each box's
    // nearest goal distance stays admissible and cheap.
    let total = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const c = dist[j][b];
        if (c >= 0 && c < m) m = c;
      }
      if (m === Infinity) return Infinity;
      total += m;
    }
    return total;
  }
  const full = (1 << n) - 1;
  scratch.fill(Infinity, 0, full + 1);
  scratch[0] = 0;
  for (let mask = 0; mask <= full; mask++) {
    const base = scratch[mask];
    if (base === Infinity) continue;
    const k = POPCOUNT[mask];
    if (k >= n) continue;
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      const c = dist[j][boxes[k]];
      if (c < 0) continue;
      const nm = mask | (1 << j);
      const v = base + c;
      if (v < scratch[nm]) scratch[nm] = v;
    }
  }
  return scratch[full];
}

/**
 * The push-optimal solution of `level` (mode 0: A* on pushes + assignment;
 * mode 1: plain BFS over pushes; mode 2: greedy best-first on the
 * assignment), searching at most `cap` states: {pushes, moves}, or null.
 */
function solvePush(lv: Level, cap: number, mode: number): Solved | null {
  const { w, wall, goals } = lv;
  const size = wall.length;
  const n = lv.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(lv);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stampSeen = 0;
  let stampMark = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (lv.boxes.some((b) => !live[b])) return null;
  if (solved(lv.boxes)) return { pushes: 0, moves: '' };

  // Grid distances from each goal over the walls alone, for the assignment.
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (const [dx, dy] of DIRS) {
        const nq = p + dy * w + dx;
        if (!wall[nq] && d[nq] < 0) {
          d[nq] = d[p] + 1;
          q.push(nq);
        }
      }
    }
    return d;
  });
  const scratch = new Float64Array(1 << n);

  // A state's key: the region's lowest square and the boxes' squares, as
  // digits in base `size` (exact while size ** (boxes + 1) stays under 2 ** 53;
  // a joined string past that, for the whole-level fallback).
  const numeric = Math.pow(size, n + 1) < 2 ** 53;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numeric) return low + ':' + boxes.join(',');
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states in the order found: boxes, player square, parent, pushes so far, key.
  const sBoxes: number[][] = [lv.boxes.slice()];
  const sPlayer: number[] = [lv.player];
  const sParent: number[] = [-1];
  const sG: number[] = [0];
  const sKey: (number | string)[] = [];
  const best = new Map<number | string, number>();
  for (const b of lv.boxes) occupied[b] = 1;
  const low0 = regionLow(lv, occupied, lv.player, seen, ++stampSeen, stack);
  for (const b of lv.boxes) occupied[b] = 0;
  sKey.push(keyOf(lv.boxes, low0));
  best.set(sKey[0], 0);
  if (mode !== 1 && assignment(lv.boxes, dist, scratch) === Infinity) return null;

  // The open list: a heap on [f, -g, sequence], so ties go to the deeper
  // state, then the earlier one. Deterministic on every run.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const t = heap[i]; heap[i] = heap[p]; heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const t = heap[i]; heap[i] = heap[c]; heap[c] = t;
        i = c;
      }
    }
    return top;
  };
  const h0 = mode === 1 ? 0 : assignment(lv.boxes, dist, scratch);
  heapPush([h0, 0, 0, 0]);
  let seq = 1;
  let found = -1;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (best.get(sKey[s]) !== s) continue; // a better route to this state superseded it
    const boxes = sBoxes[s];
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (spent >= TOTAL_BUDGET) return null;
    spent++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stampSeen;
    regionLow(lv, occupied, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        if (seen[behind] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(lv, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const nlow = regionLow(lv, occupied, b, mark, ++stampMark, stack);
        const key = keyOf(next, nlow);
        const g2 = sG[s] + 1;
        const prev = best.get(key);
        if (prev !== undefined && (mode === 2 || sG[prev] <= g2)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        if (sBoxes.length >= cap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        let h = 0;
        if (mode !== 1) {
          h = assignment(next, dist, scratch);
          if (h === Infinity) {
            occupied[t] = 0;
            occupied[b] = 1;
            continue;
          }
        }
        if (mode === 2 && g2 > GREEDY_PUSHES) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sG.push(g2);
        sKey.push(key);
        best.set(key, idx);
        heapPush([mode === 2 ? h : g2 + h, -g2, seq++, idx]);
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = lv.player;
  let boxes = lv.boxes;
  for (const s of path) {
    const nb = sBoxes[s];
    const from = boxes.find((b) => !nb.includes(b))!;
    const to = nb.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(lv, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nb;
  }
  return { pushes: path.length, moves };
}

type Room = { boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when a box starts in the hallway, or a part
 * holds more or fewer boxes than goals.
 */
function roomsOf(lv: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = lv;
  const live = liveSquares(lv);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The level's moves: each room solved on its own, in turn, the player walking on. */
function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const rooms = roomsOf(lv);
  if (rooms === null) {
    const r = solvePush(lv, BFS_CAP, 0) ?? solvePush(lv, BFS_CAP, 1) ?? solvePush(lv, GREEDY_CAP, 2);
    return r ? r.moves : '';
  }
  rooms.sort((a, b) => a.boxes[0] - b.boxes[0]);
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    const wall = lv.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: lv.w,
      h: lv.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePush(sub, ASTAR_CAP, 0) ?? solvePush(sub, BFS_CAP, 1) ?? solvePush(sub, GREEDY_CAP, 2);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(lv.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
