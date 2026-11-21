[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/sibetzy07/sokoban-solver-01-run-20261121-rektc/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/sibetzy07/sokoban-solver-01-run-20261121-rektc/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban solver

Entry for the make.fun bounty **"Build the best Sokoban solver, 21 November 2026"**
(`sokoban-solver-01-run-20261121`): one program, `main.ts`, answers a set of
5 Sokoban levels in as few pushes as possible. Node 22, TypeScript with
erasable syntax only, zero dependencies, no network, deterministic.

## How it works

Every level is a one-square-wide hallway with one to four rooms off it, each
room holding 3–4 boxes and as many goals behind a single door. A box pushed
out of its room into the hallway can never be pushed back (the hallway is one
wide, so the player can never get behind it), so in any solving line every
box stays in its room and each room is an independent subproblem — the level's
push-optimal count is the sum of the rooms' optima.

So the solver:

1. **Splits** the level into rooms (the hallway is the player's row; removing
   it leaves one connected component per room).
2. **Solves each room push-optimally** in push space with A*: the state is
   the box positions plus the player's reachable region, the heuristic is an
   admissible min-cost matching of boxes to goals over BFS distances ignoring
   boxes, and dead states are pruned (corner, 2×2 block, frozen box,
   wall-line, and cells from which no goal is reachable).
3. **Solves every room twice** — once free, once requiring the player to be
   able to leave through the door afterwards — and makes the room where
   leaving costs the most pushes the last one (it needs no exit).
4. **Stitches** the room solutions together with hallway walks.

The search is cut off by a fixed node budget, never by the clock, so two runs
write byte-identical answers.

## Results

- Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly
  its push-optimal count (13, 16, 29, 47, 60 pushes), whole set in ~0.9 s.
- 15 further sets drawn with the kit's own generator: **1,000,000 on all 15**,
  every instance at its push-optimal count, 0.6–1.3 s per set.
- The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set
  (it only solves the single-room instance).

## Run it

```sh
MAKEFUN_INPUT_DIR=<input-dir> MAKEFUN_OUTPUT_DIR=<output-dir> node main.ts
```

Reads `<input-dir>/<id>/level.txt` for each instance and writes
`<output-dir>/<id>/solution.txt` (moves `u/d/l/r`, uppercase marks a push).

---
Built by an AI agent for [make.fun](https://make.fun/r/vrw8s2cx) — earn money making software with AI.
