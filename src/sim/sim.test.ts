import { describe, expect, it } from 'vitest';
import { Rand } from './rng';
import { computeFOV } from './fov';
import { generateMap, T, FLAG_WALK } from './map';
import { Game } from './game';

describe('rng', () => {
  it('is deterministic per seed+stream', () => {
    const a = new Rand('hello', 'map');
    const b = new Rand('hello', 'map');
    for (let i = 0; i < 100; i++) expect(a.float()).toBe(b.float());
  });

  it('differs across streams', () => {
    const a = new Rand('hello', 'map');
    const b = new Rand('hello', 'turns');
    const same = Array.from({ length: 20 }, () => a.float() === b.float());
    expect(same.every(Boolean)).toBe(false);
  });

  it('int stays in range', () => {
    const r = new Rand('x', 'y');
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
  });
});

describe('fov', () => {
  // 10x10 room: wall column at x=5, origin at (2,5).
  const opaque = (x: number, y: number) =>
    x < 0 || y < 0 || x >= 10 || y >= 10 || x === 5;

  it('sees adjacent tiles and is blocked by walls', () => {
    const seen = new Set<string>();
    computeFOV(2, 5, 8, opaque, (x, y) => seen.add(`${x},${y}`));
    expect(seen.has('2,5')).toBe(true);
    expect(seen.has('3,5')).toBe(true);
    expect(seen.has('5,5')).toBe(true); // the wall itself is visible
    expect(seen.has('7,5')).toBe(false); // but not what's behind it
    expect(seen.has('9,5')).toBe(false);
  });
});

const sameArray = (a: Uint16Array | Uint32Array, b: Uint16Array | Uint32Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

describe('mapgen', () => {
  it('is deterministic from seed', () => {
    const a = generateMap('m0-test');
    const b = generateMap('m0-test');
    expect(a.spawn).toEqual(b.spawn);
    expect(sameArray(a.map.glyph, b.map.glyph)).toBe(true);
    expect(sameArray(a.map.fg, b.map.fg)).toBe(true);
  });

  it('differs across seeds', () => {
    const a = generateMap('seed-a');
    const b = generateMap('seed-b');
    expect(sameArray(a.map.glyph, b.map.glyph)).toBe(false);
  });

  it('spawns the player on walkable ground', () => {
    const { map, spawn } = generateMap('walkable');
    expect(map.walkable(spawn.x, spawn.y)).toBe(true);
  });

  it('keeps the world connected (doors count as passable)', () => {
    const { map, spawn } = generateMap('connect');
    const passable = (x: number, y: number) =>
      map.inBounds(x, y) &&
      ((map.flags[map.idx(x, y)] & FLAG_WALK) !== 0 || map.t(x, y) === T.DoorClosed);

    let total = 0;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) if (passable(x, y)) total++;
    }

    const seen = new Uint8Array(map.w * map.h);
    const stack = [[spawn.x, spawn.y]];
    seen[map.idx(spawn.x, spawn.y)] = 1;
    let reached = 0;
    while (stack.length) {
      const [x, y] = stack.pop()!;
      reached++;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (!passable(nx, ny)) continue;
        const i = map.idx(nx, ny);
        if (!seen[i]) { seen[i] = 1; stack.push([nx, ny]); }
      }
    }
    expect(reached / total).toBeGreaterThan(0.9);
  });
});

describe('game', () => {
  it('survives a few hundred random actions deterministically', () => {
    const run = (seed: string) => {
      const g = new Game(seed);
      const r = new Rand(seed, 'fuzz-input');
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
      for (let i = 0; i < 300; i++) {
        const roll = r.float();
        if (roll < 0.7) {
          const [dx, dy] = r.pick(dirs);
          g.act({ k: 'move', dx, dy });
        } else if (roll < 0.8) g.act({ k: 'wait' });
        else if (roll < 0.9) g.act({ k: 'interact' });
        else g.act({ k: 'cancel' });
      }
      return `${g.player.x},${g.player.y},${g.turn}`;
    };
    expect(run('fuzz')).toBe(run('fuzz'));
    const g = new Game('fuzz2');
    g.act({ k: 'wait' });
    expect(g.turn).toBe(1);
  });

  it('stays inside the perf budgets (PRD §3.3, generous CI margins)', () => {
    const t0 = performance.now();
    const g = new Game('perf');
    const genMs = performance.now() - t0;
    expect(genMs).toBeLessThan(2000); // budget: 6s incl. 10-year history sim (M1)

    const w = 120, h = 50;
    const glyph = new Uint16Array(w * h);
    const fg = new Uint32Array(w * h);
    const bg = new Uint32Array(w * h);
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
    const r = new Rand('perf', 'bench-input');
    const t1 = performance.now();
    const TURNS = 1000;
    for (let i = 0; i < TURNS; i++) {
      const [dx, dy] = r.pick(dirs);
      g.act({ k: 'move', dx, dy });
      g.fillView(w, h, glyph, fg, bg);
    }
    const perTurn = (performance.now() - t1) / TURNS;
    expect(perTurn).toBeLessThan(8); // budget: <8ms typical Tier 1 turn
  });

  it('fills a view buffer without leaving garbage', () => {
    const g = new Game('viewtest');
    const w = 100, h = 40;
    const glyph = new Uint16Array(w * h);
    const fg = new Uint32Array(w * h);
    const bg = new Uint32Array(w * h);
    g.fillView(w, h, glyph, fg, bg);
    // The player must be somewhere in view.
    expect(Array.from(glyph)).toContain(64); // '@'
  });
});
