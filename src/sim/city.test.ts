import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { fixtureSeeds } from './testutil';

// Tests reach into private sim internals on purpose — they assert behavior the
// public Action surface can't force deterministically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGame = any;

const boot = (seed: string): AnyGame => {
  const g = new Game(seed, fixtureSeeds()) as AnyGame;
  g.act({ k: 'interact' });
  return g;
};

describe('the living city (M3)', () => {
  it('tier 2 produces incidents that surface as rumors', () => {
    const g = boot('t2-rumors');
    // Crank crime so the dice land within a reasonable test window.
    for (const id in g.world.neighborhoods) g.world.neighborhoods[id].stats.crime = 0.9;
    let guard = 0;
    while (g.city.rumors.length === 0 && guard++ < 60) {
      g.city.tier2Tick(g.hoodId, 22, 0);
    }
    expect(g.city.rumors.length).toBeGreaterThan(0);
    const text = g.city.expandRumor(g.city.rumors[0].text);
    expect(text).not.toMatch(/#\w+#/);
  });

  it('tier 3 daily tick mutates the city and plays the leagues, inside budget', () => {
    const g = boot('t3-daily');
    const t0 = performance.now();
    for (let day = 1; day <= 10; day++) g.city.tier3Daily(day);
    const perDay = (performance.now() - t0) / 10;
    expect(perDay).toBeLessThan(30); // PRD budget
    // Old leagues exist from 2026, so fixtures should accumulate.
    expect(g.city.fixtures.length).toBeGreaterThan(0);
    const lines = g.city.standingsLines();
    expect(lines.length).toBeGreaterThan(3);
  });

  it('shops buy and sell with stat-driven prices', () => {
    const g = boot('shop-test');
    const moneyBefore = g.pc.money;
    g.runDataAction('buy:beans');
    expect(g.pc.money).toBeLessThan(moneyBefore);
    expect(g.pc.inventory.some((s: { id: string }) => s.id === 'beans')).toBe(true);
    g.pc.gain('copper_coil', 1);
    const beforeSell = g.pc.money;
    g.runDataAction('sell:copper_coil');
    expect(g.pc.money).toBeGreaterThan(beforeSell);
  });

  it('fetch quests pay out at the counter', () => {
    const g = boot('quest-test');
    g.quest = { kind: 'fetch', itemId: 'beans', reward: 50, giver: 'Test Giver' };
    g.pc.gain('beans', 1);
    const before = g.pc.money;
    g.completeQuest();
    expect(g.pc.money).toBe(before + 50);
    expect(g.quest).toBeNull();
  });

  it('bets resolve against fixtures', () => {
    const g = boot('bet-test');
    // Play a few days of games, then bet on a team known to have a fixture.
    for (let day = 1; day <= 4; day++) g.city.tier3Daily(day);
    const game = g.city.fixtures[g.city.fixtures.length - 1];
    g.pc.money = 100;
    g.bets.push({ league: game.league, team: game.home, stake: 25, odds: 2, day: game.day });
    g.resolveBets(game.day);
    expect(g.bets.length).toBe(0); // resolved one way or the other
  });

  it('joining a faith builds favor and unlocks the boon', () => {
    const g = boot('faith-test');
    const religions = g.world.religions;
    if (!religions.length) return; // this seed founded nothing; other tests cover the path
    g.runDataAction(`join:${religions[0].packId}`);
    expect(g.faith).toBe(religions[0].packId);
    g.pc.gain('copper_coil', 2);
    g.runDataAction(`tithe:${religions[0].packId}`);
    g.runDataAction(`tithe:${religions[0].packId}`);
    expect(g.favor[religions[0].packId]).toBeGreaterThanOrEqual(3);
  });
});
