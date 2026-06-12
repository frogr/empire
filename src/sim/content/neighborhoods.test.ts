import { describe, expect, it } from 'vitest';
import { loadNeighborhoods } from './neighborhoods';
import { Game } from '../game';

describe('neighborhoods.json (the real city)', () => {
  const seeds = loadNeighborhoods();
  const byId = new Map(seeds.map((s) => [s.id, s]));

  it('covers the five boroughs at scale', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(100);
    const boroughs = new Set(seeds.map((s) => s.borough));
    expect(boroughs.size).toBe(5);
  });

  it('adjacency is symmetric and references existing ids', () => {
    for (const s of seeds) {
      expect(s.adjacent.length).toBeGreaterThan(0);
      for (const a of s.adjacent) {
        const other = byId.get(a);
        expect(other, `${s.id} -> ${a}`).toBeTruthy();
        expect(other!.adjacent, `${a} should list ${s.id}`).toContain(s.id);
      }
    }
  });

  it('the city is one connected graph', () => {
    const seen = new Set<string>([seeds[0].id]);
    const queue = [seeds[0].id];
    while (queue.length) {
      const cur = byId.get(queue.pop()!)!;
      for (const a of cur.adjacent) {
        if (!seen.has(a)) { seen.add(a); queue.push(a); }
      }
    }
    expect(seen.size).toBe(seeds.length);
  });

  it('stats and positions are in range', () => {
    for (const s of seeds) {
      expect(s.pos[0]).toBeGreaterThanOrEqual(0);
      expect(s.pos[0]).toBeLessThanOrEqual(100);
      expect(s.pos[1]).toBeGreaterThanOrEqual(0);
      expect(s.pos[1]).toBeLessThanOrEqual(100);
      for (const k of ['prosperity', 'crime', 'infrastructure', 'faith'] as const) {
        expect(s.stats_2026[k], `${s.id}.${k}`).toBeGreaterThan(0);
        expect(s.stats_2026[k], `${s.id}.${k}`).toBeLessThan(1);
      }
      expect(s.stats_2026.population).toBeGreaterThan(1000);
    }
  });

  it('boots a full-city world inside the 6s worldgen budget', () => {
    const t0 = performance.now();
    const g = new Game('full-city', seeds);
    g.act({ k: 'interact' }); // pick an origin; generates the first local map
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(6000);
    expect(g.hoodId).toBeTruthy();
    expect(g.world.chronicle.length).toBeGreaterThan(25);
    g.act({ k: 'journal' });
    expect(g.outbox.length).toBe(1);
  });
});
