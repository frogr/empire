import { describe, expect, it } from 'vitest';
import { Rand } from './rng';
import { computeFOV } from './fov';
import { T, FLAG_WALK, GameMap } from './map';
import { generateLocalMap, LocalCtx } from './mapgen';
import { Game } from './game';
import { fixtureSeeds } from './testutil';
import type { NeighborhoodSeed } from './content/types';

const seeds = fixtureSeeds();

function ctxFor(id: string): LocalCtx {
  const hood = seeds.find((s) => s.id === id)!;
  return {
    hood,
    state: {
      id,
      stats: { prosperity: 0.4, crime: 0.55, infrastructure: 0.5, faith: 0.5, cult: 0.2 },
      population: 70000,
      flooded: false,
      subway: hood.subway,
      residue: [
        { type: 'graffiti', density: 'med', year: 2031, text: 'THE WATER REMEMBERS' },
        { type: 'shrine', density: 'low', year: 2029, text: 'a shrine to the dark of 2029' },
        { type: 'burn', density: 'low', year: 2030 },
        { type: 'barricade', density: 'low', year: 2034 },
      ],
      faiths: {},
      control: {},
    },
    religions: [],
    factions: [],
  };
}

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
});

describe('fov', () => {
  const opaque = (x: number, y: number) =>
    x < 0 || y < 0 || x >= 10 || y >= 10 || x === 5;

  it('sees adjacent tiles and is blocked by walls', () => {
    const seen = new Set<string>();
    computeFOV(2, 5, 8, opaque, (x, y) => seen.add(`${x},${y}`));
    expect(seen.has('3,5')).toBe(true);
    expect(seen.has('5,5')).toBe(true);
    expect(seen.has('7,5')).toBe(false);
  });
});

function connectivity(map: GameMap, sx: number, sy: number): number {
  const passable = (x: number, y: number) =>
    map.inBounds(x, y) &&
    ((map.flags[map.idx(x, y)] & FLAG_WALK) !== 0 || map.t(x, y) === T.DoorClosed);
  let total = 0;
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (passable(x, y)) total++;
  const seen = new Uint8Array(map.w * map.h);
  const stack = [[sx, sy]];
  seen[map.idx(sx, sy)] = 1;
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
  return reached / total;
}

describe('mapgen', () => {
  it('is deterministic from seed', () => {
    const a = generateLocalMap('m1-test', ctxFor('bushwick'));
    const b = generateLocalMap('m1-test', ctxFor('bushwick'));
    expect(a.spawn).toEqual(b.spawn);
    expect(a.map.glyph.every((v, i) => v === b.map.glyph[i])).toBe(true);
  });

  it('generates every area type walkable and mostly connected', () => {
    for (const s of seeds) {
      const gen = generateLocalMap('area-sweep', ctxFor(s.id));
      expect(gen.map.walkable(gen.spawn.x, gen.spawn.y), s.area_type).toBe(true);
      const ratio = connectivity(gen.map, gen.spawn.x, gen.spawn.y);
      expect(ratio, `${s.area_type} connectivity ${ratio.toFixed(2)}`).toBeGreaterThan(0.75);
    }
  });

  it('stamps history residue into the map', () => {
    const gen = generateLocalMap('residue-test', ctxFor('bushwick'));
    const descs = [...gen.map.desc.values()].join(' | ');
    expect(descs).toContain('THE WATER REMEMBERS');
    expect(descs).toContain('2029');
  });

  it('places a live station when lines survive', () => {
    const gen = generateLocalMap('station-test', ctxFor('bushwick'));
    expect(gen.map.station).not.toBeNull();
  });
});

const boot = (seed: string): Game => {
  const g = new Game(seed, fixtureSeeds());
  g.act({ k: 'interact' }); // confirm the default origin in the boot menu
  return g;
};

describe('game', () => {
  it('boots, plays, and travels deterministically', () => {
    const run = (seed: string) => {
      const g = boot(seed);
      const r = new Rand(seed, 'fuzz-input');
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
      for (let i = 0; i < 300; i++) {
        const roll = r.float();
        if (roll < 0.55) {
          const [dx, dy] = r.pick(dirs);
          g.act({ k: 'move', dx, dy });
        } else if (roll < 0.62) g.act({ k: 'wait' });
        else if (roll < 0.72) g.act({ k: 'interact' });
        else if (roll < 0.78) g.act({ k: 'fire' });
        else if (roll < 0.84) g.act({ k: 'talk' });
        else if (roll < 0.88) g.act({ k: 'vault' });
        else if (roll < 0.92) g.act({ k: 'pickup' });
        else if (roll < 0.97) g.act({ k: 'cancel' });
        else g.act({ k: 'citymap' });
      }
      return `${g.hoodId}:${g.px},${g.py},${g.turn}`;
    };
    expect(run('fuzz')).toBe(run('fuzz'));
  });

  it('travels to an adjacent neighborhood via the city map', () => {
    const g = boot('travel-test');
    expect(g.hoodId).toBe('bushwick');
    g.act({ k: 'citymap' });
    g.act({ k: 'move', dx: -1, dy: 0 }); // selection geometry: red_basin is nearest to the west
    g.act({ k: 'interact' });
    expect(g.hoodId).toBe('red_basin');
    expect(g.map.walkable(g.px, g.py)).toBe(true);
    // And back.
    g.act({ k: 'citymap' });
    g.act({ k: 'move', dx: 1, dy: 0 });
    g.act({ k: 'interact' });
    expect(g.hoodId).toBe('bushwick');
  });

  it('death leaves a grave, a stash, an obituary — and the world goes on', () => {
    const g = boot('mortality');
    const before = (g as never as { pc: { name: string } }).pc.name;
    // Beat the character down until the nerve save finally fails.
    let guard = 0;
    while (g.world.graves.length === 0 && guard++ < 50) {
      (g as never as { damagePlayer(d: number, s: string, k: string): void })
        .damagePlayer(999, 'the test harness hits you', 'blunt');
    }
    expect(g.world.graves.length).toBe(1);
    const grave = g.world.graves[0];
    expect(grave.name).toBe(before);
    expect(g.world.chronicle.some((c) => c.tags.includes('obituary'))).toBe(true);
    // The stash (corpse at minimum) is on the ground where they fell.
    const pile = g.map.items.get(g.map.idx(grave.x, grave.y));
    expect(pile?.some((s) => s.id === 'corpse')).toBe(true);
    // A successor can step into the same world.
    g.act({ k: 'interact' });
    const after = (g as never as { pc: { name: string } }).pc;
    expect(after).toBeTruthy();
    expect(g.world.graves.length).toBe(1);
  });

  it('serves the journal and news screens', () => {
    const g = boot('journal-test');
    g.act({ k: 'journal' });
    g.act({ k: 'news' });
    expect(g.outbox.length).toBe(2);
    expect(g.outbox[0].lines.length).toBeGreaterThan(10);
    const text = g.outbox[0].lines.map((l) => l.text).join('\n');
    expect(text).not.toMatch(/#\w+#/);
  });

  it('stays inside the perf budgets (PRD §3.3, generous CI margins)', () => {
    const t0 = performance.now();
    const g = boot('perf');
    const genMs = performance.now() - t0;
    expect(genMs).toBeLessThan(3000); // budget: 6s for full worldgen

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
    expect(perTurn).toBeLessThan(8);
  });

  it('fills a view buffer with the player visible', () => {
    const g = boot('viewtest');
    const w = 100, h = 40;
    const glyph = new Uint16Array(w * h);
    g.fillView(w, h, glyph, new Uint32Array(w * h), new Uint32Array(w * h));
    expect(Array.from(glyph)).toContain(64);
  });
});

// Sanity that the fixture covers every area type we ship generators for.
it('fixture covers all area types', () => {
  const types = new Set<string>(seeds.map((s) => s.area_type));
  const all: NeighborhoodSeed['area_type'][] = [
    'rowhouse', 'grid_dense', 'industrial', 'projects', 'parkland', 'civic', 'suburban', 'waterfront',
  ];
  expect(all.filter((t) => !types.has(t))).toEqual([]);
});
