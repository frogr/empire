# EMPIRE://36

Turn-based, glyph-rendered roguelike set in NYC 2036. Full product spec lives in
`docs/PRD.md` — read it before adding features. Current status: **v1 complete
(M0–M4)**: history sim, living city (Tier 1/2/3), combat/death/legacy, economy,
faiths, leagues, server saves, CRT, content packs at volume. Remaining operator
step: public deploy (Dockerfile + fly.toml are ready).

## Commands

- `npm run server` — API/saves server on :8136 (SQLite at ./empire.db)
- `npm run dev` — Vite dev server on http://localhost:5136 (proxies /api; `?seed=foo` pins a world)
- `npm run check` — typecheck client + server
- `npm test` — vitest (determinism, connectivity, perf budgets, sim E2E)
- `npm run build` — typecheck + production build; `npm start` serves dist + API

## Code map

- `src/sim/worldgen/history.ts` — 2026→2036 yearly event loop (the chronicle)
- `src/sim/city.ts` — Tier 2/3 living-city sim (records, daily tick, rumors, leagues)
- `src/sim/game.ts` — turn resolution, travel, combat, economy, faith, save/restore
- `src/sim/mapgen.ts` — area-type local maps, stat-parameterized, residue stamping
- `src/sim/content/` — typed pack registry; `/content/packs/*.json` merge in automatically
- `server/` — Hono + better-sqlite3 + argon2id (auth, saves, runs)
- `src/main.ts` — client shell (title/auth/settings/game), autosave; `src/render/` — atlas, renderer, CRT

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

## Keys

WASD/arrows move (bump opens doors) · `.`/space wait · `r` rest · `e` interact ·
`g` pick up · `i` inventory · `c` character · `t` talk · `f` fight · `v` vault ·
`x` examine · `m` city map/travel · `J` chronicle · `N` news · `?` tabbed help ·
`F9` perf · `F10` CRT · `shift+Q` save & quit. A contextual hint bar above the
log (worker-computed `FrameMeta.hints`) always shows what works right now.
