# EMPIRE://36

A top-down, glyph-rendered, turn-based roguelike set in New York City, 2036.
A new mayor took office in January 2026; every world seed simulates the decade
that followed — collapses, miracles, cults, leagues, wars between landlords
and gods — and drops you into what's left. Full design doc: `docs/PRD.md`.

**Status: v1 feature-complete (M0–M4).**

- 122 real NYC neighborhoods, procgen streets/blocks/interiors per area type
- 2026→2036 history sim: ~90 event templates founding faiths, factions, leagues;
  browsable chronicle; physical residue (graffiti, shrines, flood lines, burn scars)
- Living city: Tier 1 actors in your bubble, Tier 2 neighborhood records,
  Tier 3 citywide daily tick — crimes, deaths, rituals, and standings happen
  whether or not you're watching, and reach you as rumors
- Characters with origins, use-trained skills, injuries; bump-to-attack combat
  with body parts; permadeath with graves, stashes, obituaries, and successors
  in the same world
- Economy (bodegas, fences, betting books), faith membership with favor and
  boons, courier/fetch quests, per-borough heat
- Server saves (username+password, argon2id), autosave, localStorage fallback,
  runs recording; CRT shader; pure keyboard

## Run it

```sh
npm install
npm run server   # API + saves on :8136
npm run dev      # client on http://localhost:5136 (proxies /api)
npm test         # 33 tests: determinism, connectivity, perf budgets, E2E sim
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
