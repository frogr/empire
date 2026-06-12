import { describe, expect, it } from 'vitest';
import { Rand } from '../rng';
import { Grammar } from '../content/grammar';
import { simulateHistory } from './history';
import { EVENTS, GRAMMAR_RULES, RELIGIONS, FACTIONS } from '../content';
import type { NeighborhoodSeed } from '../content/types';

const fixture: NeighborhoodSeed[] = [
  mk('alpha_point', 'brooklyn', 'waterfront', true, ['A', 'C'], 0.3),
  mk('brickline', 'brooklyn', 'rowhouse', false, ['L'], 0.4),
  mk('cargo_flats', 'brooklyn', 'industrial', true, [], 0.35),
  mk('delta_hill', 'queens', 'rowhouse', false, ['7'], 0.5),
  mk('east_basin', 'queens', 'waterfront', true, ['A'], 0.45),
  mk('fairmont', 'manhattan', 'grid_dense', false, ['1', '2'], 0.8),
  mk('gates_row', 'manhattan', 'grid_dense', true, ['4'], 0.7),
  mk('harbor_et', 'staten_island', 'suburban', true, ['SIR'], 0.55),
  mk('iron_court', 'bronx', 'projects', false, ['6'], 0.25),
  mk('junction_v', 'bronx', 'rowhouse', false, ['2', '5'], 0.35),
];

function mk(
  id: string, borough: NeighborhoodSeed['borough'], area: NeighborhoodSeed['area_type'],
  coastal: boolean, subway: string[], prosperity: number,
): NeighborhoodSeed {
  return {
    id, name: id.replace(/_/g, ' '), borough, area_type: area, coastal, subway,
    pos: [50, 50],
    adjacent: [],
    stats_2026: { population: 50000, prosperity, crime: 0.5, infrastructure: 0.5, faith: 0.5 },
  };
}
// Ring adjacency so spread/cult mechanics have something to walk on.
fixture.forEach((s, i) => {
  s.adjacent = [fixture[(i + 1) % fixture.length].id, fixture[(i + fixture.length - 1) % fixture.length].id];
});

describe('grammar', () => {
  it('expands slots and interpolates ctx deterministically', () => {
    const g = new Grammar({ adj: ['rainy', 'dark'], noun: ['city #adj#'] });
    const a = g.expand('#noun# in {year}', new Rand('s', 'g'), { year: 2031 });
    const b = g.expand('#noun# in {year}', new Rand('s', 'g'), { year: 2031 });
    expect(a).toBe(b);
    expect(a).toMatch(/^city (rainy|dark) in 2031$/);
  });

  it('marks missing slots instead of crashing', () => {
    const g = new Grammar({});
    expect(g.expand('#nope#', new Rand('s', 'g'))).toBe('[nope]');
  });

  it('has rules for every slot referenced by the content packs', () => {
    const g = new Grammar(GRAMMAR_RULES);
    const texts: string[] = [];
    for (const e of EVENTS) {
      texts.push(e.chronicle, e.news ?? '');
      for (const r of e.residue ?? []) texts.push(r.grammar ?? '');
    }
    for (const r of RELIGIONS) texts.push(...r.greeting, ...r.rumor, r.ritual.text);
    for (const f of FACTIONS) texts.push(...f.barks, ...f.rumor);
    const missing = new Set<string>();
    for (const t of texts) {
      for (const m of t.matchAll(/#(\w+)#/g)) if (!g.has(m[1])) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });
});

describe('history sim', () => {
  it('is deterministic', () => {
    const a = simulateHistory('decade-test', fixture);
    const b = simulateHistory('decade-test', fixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces a readable decade', () => {
    const w = simulateHistory('decade-read', fixture);
    expect(w.chronicle.length).toBeGreaterThan(20);
    expect(w.chronicle.every((c) => c.year >= 2026 && c.year <= 2036)).toBe(true);
    // No unexpanded grammar or ctx left in the prose.
    for (const c of w.chronicle) {
      expect(c.text).not.toMatch(/#\w+#/);
      expect(c.text).not.toMatch(/\{\w+\}/);
      expect(c.text).not.toMatch(/\[\w+\]/);
    }
    // Stats stay in bounds.
    for (const id in w.neighborhoods) {
      for (const v of Object.values(w.neighborhoods[id].stats)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('founds organizations across seeds', () => {
    let religions = 0, factions = 0, residue = 0;
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const w = simulateHistory(seed, fixture);
      religions += w.religions.length;
      factions += w.factions.length;
      for (const id in w.neighborhoods) residue += w.neighborhoods[id].residue.length;
    }
    expect(religions).toBeGreaterThan(0);
    expect(factions).toBeGreaterThan(0);
    expect(residue).toBeGreaterThan(10);
  });

  it('different seeds give different decades', () => {
    const a = simulateHistory('seed-1', fixture);
    const b = simulateHistory('seed-2', fixture);
    expect(JSON.stringify(a.chronicle)).not.toBe(JSON.stringify(b.chronicle));
  });

  it('stays inside the worldgen budget', () => {
    const t0 = performance.now();
    simulateHistory('budget', fixture);
    expect(performance.now() - t0).toBeLessThan(500); // total budget 6s incl. maps
  });
});
