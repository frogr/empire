// The city map must look like New York: every neighborhood pinned to its own
// borough's land in the silhouette template, and the rendered screen must be
// geography, not scattered dots on black.

import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { CITYMAP } from './content';
import { loadNeighborhoods } from './content/neighborhoods';
import { fixtureSeeds } from './testutil';

const BOROUGH_CHAR: Record<string, string> = {
  manhattan: 'm', brooklyn: 'b', queens: 'q', bronx: 'x', staten_island: 's',
};

describe('citymap template', () => {
  it('has the declared dimensions', () => {
    expect(CITYMAP.rows.length).toBe(CITYMAP.h);
    for (const row of CITYMAP.rows) expect(row.length).toBe(CITYMAP.w);
  });

  it('places every real neighborhood on its own borough land', () => {
    for (const s of loadNeighborhoods()) {
      const tx = Math.min(CITYMAP.w - 1, Math.round(s.pos[0]));
      const ty = Math.min(CITYMAP.h - 1, Math.round(s.pos[1] / 2));
      expect(CITYMAP.rows[ty].charAt(tx), `${s.id} (${s.borough}) at template ${tx},${ty}`)
        .toBe(BOROUGH_CHAR[s.borough]);
    }
  });
});

describe('citymap screen', () => {
  const W = 100, H = 40;
  const render = (g: Game) => {
    const glyph = new Uint16Array(W * H);
    const fg = new Uint32Array(W * H);
    const bg = new Uint32Array(W * H);
    g.fillView(W, H, glyph, fg, bg);
    return { glyph, fg, bg };
  };

  it('renders landmass and water, not a black void', () => {
    const g = new Game('citymap-test', fixtureSeeds());
    g.act({ k: 'interact' }); // confirm default origin
    g.act({ k: 'citymap' });
    const { glyph, bg } = render(g);
    const counts = new Map<number, number>();
    for (let i = 0; i < bg.length; i++) counts.set(bg[i], (counts.get(bg[i]) ?? 0) + 1);
    // More than 30% of cells must be something other than the darkest void.
    const distinct = [...counts.keys()].length;
    const voidCount = Math.max(...[...counts.values()]);
    expect(distinct).toBeGreaterThan(4); // void, water, several borough land tints
    expect(voidCount / bg.length).toBeLessThan(0.7);
    expect([...glyph].includes(64), 'the @ marker is on the map').toBe(true);
    const meta = g.meta(0);
    expect(meta.pulse.length).toBeGreaterThanOrEqual(2); // you + cursor breathe
    expect(meta.hints.some((h) => h.key === 'e')).toBe(true);
  });

  it('is deterministic frame to frame', () => {
    const mk = () => {
      const g = new Game('citymap-det', fixtureSeeds());
      g.act({ k: 'interact' });
      g.act({ k: 'citymap' });
      return render(g);
    };
    const a = mk(), b = mk();
    expect(a.glyph.every((v, i) => v === b.glyph[i])).toBe(true);
    expect(a.fg.every((v, i) => v === b.fg[i])).toBe(true);
    expect(a.bg.every((v, i) => v === b.bg[i])).toBe(true);
  });
});
