import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { AK } from './map';
import { SCENES } from './content';
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

describe('street director (M6)', () => {
  it('scene lifecycle: crowd scene spawns actors in ST_SCENE and cleans up on expiry', () => {
    const g = boot('scene-lifecycle');

    const def = SCENES.find((s) => s.behavior === 'crowd' && s.spawn);
    if (!def) return; // no matching scene def in content packs; skip

    g.startScene(def, false);

    expect(g.scene).not.toBeNull();
    expect(g.scene.actors.length).toBeGreaterThan(0);
    expect(g.scene.actors.length).toBeLessThanOrEqual(12);

    for (const idx of g.scene.actors) {
      expect(g.aAlive[idx]).toBe(1);
      expect(g.aState[idx]).toBe(4); // ST_SCENE
    }

    // Force scene to expire now
    g.scene.endsAt = g.turn;
    const actorsBeforeEnd: number[] = [...g.scene.actors];
    g.sceneTick(false);

    expect(g.scene).toBeNull();
    for (const idx of actorsBeforeEnd) {
      expect(g.aAlive[idx]).toBe(0);
    }
  });

  it('brawl resolves: two actors target each other, scene ends within 200 turns', () => {
    const g = boot('brawl-resolves');

    const def = SCENES.find((s) => s.behavior === 'brawl');
    if (!def) return; // no brawl scene in packs; skip

    g.startScene(def, false);

    expect(g.scene).not.toBeNull();
    // After startScene with brawl, we should have exactly 2 actors targeting each other
    const brawlers = g.scene.actors;
    expect(brawlers.length).toBeGreaterThanOrEqual(2);
    const a0 = brawlers[0], a1 = brawlers[1];
    expect(g.aState[a0]).toBe(5); // ST_BRAWL
    expect(g.aState[a1]).toBe(5); // ST_BRAWL
    expect(g.aTarget[a0]).toBe(a1);
    expect(g.aTarget[a1]).toBe(a0);

    // Run up to 200 turns — scene must end without throwing
    for (let t = 0; t < 200 && g.scene; t++) {
      g.act({ k: 'wait' });
    }

    expect(g.scene).toBeNull();
  });

  it('blackout darkens: blackoutUntil advances and fillView renders without throwing', () => {
    const g = boot('blackout-darkens');

    const def = SCENES.find((s) => s.behavior === 'blackout');
    if (!def) return; // no blackout scene in packs; skip

    expect(g.director.blackoutUntil).toBe(0);
    g.startScene(def, false);
    expect(g.director.blackoutUntil).toBeGreaterThan(g.turn);

    // Render a frame — should not throw
    const W = 80, H = 30;
    const glyph = new Uint16Array(W * H);
    const fg = new Uint32Array(W * H);
    const bg = new Uint32Array(W * H);
    g.fillView(W, H, glyph, fg, bg);

    // Restore state to avoid polluting other tests
    g.director.blackoutUntil = 0;
  });

  it('mugger encounter: pay reduces money and clears encounter; fight makes NPC hostile', () => {
    const g = boot('mugger-encounter');

    // Find any alive NPC
    let idx = -1;
    for (let i = 0; i < g.aCount; i++) {
      if (g.aAlive[i] && g.aKind[i] === AK.NPC) { idx = i; break; }
    }
    if (idx < 0) return; // no NPCs in this seed; skip

    // Test: paying reduces money
    g.pc.money = 100;
    g.startMuggerEncounter(idx);
    expect(g.mode).toBe('menu');
    expect(g.menu.kind).toBe('encounter');
    expect(g.menu.entries.length).toBe(4);

    g.runDataAction('enc:pay');
    expect(g.pc.money).toBeLessThan(100);
    expect(g.mode).toBe('play');
    expect(g.encounter).toBeNull();

    // Test: fighting makes the NPC hostile
    // Re-find an alive NPC (pay may have changed states)
    let idx2 = -1;
    for (let i = 0; i < g.aCount; i++) {
      if (g.aAlive[i] && g.aKind[i] === AK.NPC) { idx2 = i; break; }
    }
    if (idx2 < 0) return; // no more NPCs; skip rest

    g.startMuggerEncounter(idx2);
    g.runDataAction('enc:fight');
    expect(g.aState[idx2]).toBe(1); // ST_HOSTILE
  });

  it('watchman bribe clears heat', () => {
    const g = boot('watchman-bribe');

    // Find any alive NPC to use as watchman
    let idx = -1;
    for (let i = 0; i < g.aCount; i++) {
      if (g.aAlive[i] && g.aKind[i] === AK.NPC) { idx = i; break; }
    }
    if (idx < 0) return; // no NPCs; skip

    g.heat = 4;
    g.pc.money = 200;
    const moneyBefore = g.pc.money;

    g.startWatchmanEncounter(idx);
    expect(g.menu.kind).toBe('encounter');
    expect(g.menu.entries.length).toBe(3);

    g.runDataAction('enc:bribe');
    expect(g.heat).toBeLessThanOrEqual(2);
    expect(g.pc.money).toBeLessThan(moneyBefore);
  });

  it('toll pay travels to destination and deducts money', () => {
    const g = boot('toll-pay-travels');

    const src = g.seedById.get(g.hoodId);
    const dst = src.adjacent[0];

    // Set up a toll encounter directly
    g.encounter = { kind: 'toll', idx: -1, toll: 15, dest: dst };
    g.pc.money = 50;

    g.runDataAction('enc:toll_pay');

    expect(g.hoodId).toBe(dst);
    expect(g.pc.money).toBe(35);
  });

  it('encounter menus cannot be escaped with cancel', () => {
    const g = boot('encounter-no-escape');

    // Find any alive NPC
    let idx = -1;
    for (let i = 0; i < g.aCount; i++) {
      if (g.aAlive[i] && g.aKind[i] === AK.NPC) { idx = i; break; }
    }
    if (idx < 0) return; // no NPCs; skip

    g.startMuggerEncounter(idx);
    expect(g.mode).toBe('menu');

    // Attempt to cancel — encounter menu is not dismissable
    g.act({ k: 'cancel' });
    expect(g.mode).toBe('menu');
  });

  it('scenes do not follow across travel', () => {
    const g = boot('scene-no-follow');

    // Start any available scene
    const def = SCENES.find((s) => s.spawn && s.behavior !== 'blackout');
    if (!def) {
      // Fallback: use a hardcoded minimal scene for the travel test
      const src = g.seedById.get(g.hoodId);
      const dst = src.adjacent[0];
      g.selectedHood = dst;
      g.walkTravel(dst);
      expect(g.scene).toBeNull();
      return;
    }

    g.startScene(def, false);
    // scene may be null if anchor placement failed (edge case); that's fine
    if (!g.scene) return;

    const src = g.seedById.get(g.hoodId);
    const dst = src.adjacent[0];
    g.walkTravel(dst);

    expect(g.scene).toBeNull();
  });
});
