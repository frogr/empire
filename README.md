# EMPIRE://36

A top-down, glyph-rendered, turn-based roguelike set in New York City, 2036.
A new mayor took office in January 2026; every world seed simulates the decade
that followed — collapses, miracles, cults, leagues, wars between landlords
and gods — and drops you into what's left. Full design doc: `docs/PRD.md`.

**Status: v2 (M0–M7) — legible, alive, deep.**

- 122 real NYC neighborhoods, procgen streets/blocks/interiors per area type;
  a city map that actually looks like New York, with borough landmass, rivers,
  routes, and a travel panel
- 2026→2036 history sim: ~90 event templates founding faiths, factions, leagues;
  browsable chronicle; physical residue (graffiti, shrines, flood lines, burn scars)
- Living city: Tier 1 actors in your bubble, Tier 2 neighborhood records,
  Tier 3 citywide daily tick — and a street director that stages what the sim
  decides near *you*: crowds, vigils, brawls, rat swarms, blackouts, shakedowns,
  Ledger editions at dawn and dusk, rumors that greet you on arrival
- Directed encounters with choices: muggers who'd rather be paid, watchman
  stops, faction checkpoint tolls (standing waves you through), faith recruiters
- Quests with a journal: deliveries (some are bait), fetch/scavenge work,
  debt collection, faith errands, faction tasks; gold-marked givers on the
  street always have work; rewards in cash, items, favor, and standing
- Loot worth bending for: dumpster diving, locked stash doors (crowbar or
  shoulder), relics of the decade, lootable corpse cash; shops stock to the
  block's prosperity and close overnight
- A contextual hint bar that always shows what you can press right now
- Characters with origins, use-trained skills, injuries; bump-to-attack combat
  with body parts; permadeath with graves, stashes, obituaries, and successors
  in the same world
- Server saves (username+password, argon2id), autosave, localStorage fallback,
  runs recording; CRT shader; pure keyboard

## Run it

```sh
npm install
npm run server   # API + saves on :8136
npm run dev      # client on http://localhost:5136 (proxies /api)
npm test         # 51 tests: determinism, connectivity, perf budgets, E2E sim
```

Pin a world with `?seed=anything`. Seeds are shareable; same seed, same decade.

## Deploy

`Dockerfile` + `fly.toml` included: `fly launch --copy-config && fly volumes
create empire_data --size 1 && fly deploy`. Any box that runs Node 22 works:
`npm run build && npm start`.

## Keys

WASD/arrows move · `.`/space wait · `r` rest · `e` interact · `g` pick up ·
`i` inventory · `c` character · `t` talk · `f` fight · `v` vault · `x` examine ·
`m` city map/travel · `J` chronicle · `N` news · `?` help · `F9` perf ·
`F10` CRT · `shift+Q` save & quit

You don't need to memorize any of that: the hint bar above the message log
always shows what you can press right now.
