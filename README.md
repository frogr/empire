# EMPIRE://36

A top-down, glyph-rendered, turn-based roguelike set in New York City, 2036.
See `docs/PRD.md` for the full design document.

**Status: M0 — walking skeleton.** One procgen Bushwick, turn loop, FOV,
message log, 60fps glyph-atlas renderer with the sim in a Web Worker.

## Run it

```sh
npm install
npm run dev          # http://localhost:5136
npm test             # determinism + connectivity + perf budget tests
```

Pin a world with `?seed=anything` in the URL. Seeds are shareable.

## Keys

| Key | Action |
|---|---|
| WASD / arrows | move (bump opens doors) |
| `.` / space | wait one turn |
| `e` | interact (doors, shrines, altars) |
| `x` | examine mode (move cursor, `x`/Esc exits) |
| `?` | help |
| `F9` | performance overlay |
