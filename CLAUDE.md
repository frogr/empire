# EMPIRE://36

Turn-based, glyph-rendered roguelike set in NYC 2036. Full product spec lives in
`docs/PRD.md` — read it before adding features. Current status: **M0 complete**
(walking skeleton: renderer, one procgen neighborhood, turn loop, FOV, log).
Next milestone: M1 (worldgen pipeline, 2026→2036 history sim, chronicle).

## Commands

- `npm run dev` — Vite dev server on http://localhost:5136 (`?seed=foo` to pin a world)
- `npm run check` — typecheck
- `npm test` — vitest (determinism, connectivity, perf budgets)
- `npm run build` — typecheck + production build

## Architecture (do not erode these)

- **Two threads.** All simulation lives in the Web Worker (`src/sim/`). The
  render thread (`src/main.ts`, `src/render/`) only draws and captures input.
  They communicate via `src/bridge/protocol.ts`; view buffers cross as
  **transferable ArrayBuffers** and ping-pong back through a worker-side pool.
  Never structured-clone large objects across the boundary.
- **Typed arrays, no per-tile objects.** `GameMap` is flat `Uint16Array`/
  `Uint32Array`/`Uint8Array`. Actors are structure-of-arrays in `Game`.
- **Glyph atlas renderer.** `src/render/atlas.ts` lazily rasterizes each
  (codepoint, color) pair once; the frame loop is run-batched bg fillRects +
  one drawImage per glyph. Full-grid redraw every rAF.
- **Determinism.** Every random draw comes from a `Rand(seed, stream)` (sfc32),
  one named stream per subsystem ('map', 'turns', 'player'...). Same seed =>
  same world; tests enforce this. Never use `Math.random()` inside `src/sim/`.

## Performance budgets (hard targets, PRD §3.3)

Render frame < 4ms · player turn < 8ms typical · worldgen < 6s · save < 2MB ·
memory < 400MB. The perf overlay (F9 in game) shows render/turn ms, fps, blit
count. `sim.test.ts` has a perf smoke test; keep it honest as the sim grows.

## Writing style (flavor text)

Terse, concrete, darkly funny, no purple sludge. Reads like a great message
log, not a novel. All flavor banks currently in `src/sim/flavor.ts` — these
migrate to JSON content packs under `/content/` in M1 (schemas in PRD §6).

## Keys (M0 subset)

WASD/arrows move (bump opens doors) · `.`/space wait · `e` interact ·
`x` examine · `?` help · `F9` perf overlay
