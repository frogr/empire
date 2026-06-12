// The street director (M6): paces beats so something is always almost
// happening. It only *decides* — picks a beat type and a scene that fits the
// block — and Game stages it. One scene at a time; everything from the
// deterministic 'director' stream.

import { Rand } from './rng';
import { SCENES } from './content';
import type { AreaType, NeighborhoodState, StreetSceneDef } from './content/types';

export const BEAT_COOLDOWN = 8; // min turns between beats
export const BEAT_CHANCE = 0.1; // per-turn roll once off cooldown

export type BeatKind = 'message' | 'scene' | 'encounter';

export interface BeatContext {
  hour: number;
  areaType: AreaType;
  state: NeighborhoodState;
  sceneActive: boolean;
  encounterReady: boolean; // Game gates encounters (mode, candidates, cooldown)
}

export interface Beat {
  kind: BeatKind;
  scene?: StreetSceneDef;
}

function hourMatches(pre: StreetSceneDef['pre'], hour: number): boolean {
  if (!pre || pre.hourMin === undefined || pre.hourMax === undefined) return true;
  return pre.hourMin <= pre.hourMax
    ? hour >= pre.hourMin && hour < pre.hourMax
    : hour >= pre.hourMin || hour < pre.hourMax; // wraps midnight
}

export class Director {
  readonly r: Rand;
  lastBeat = 0;
  lastEncounter = 0;
  blackoutUntil = 0;

  constructor(seed: string) {
    this.r = new Rand(seed, 'director');
  }

  /** Roll for a beat this turn. Null = the street minds its own business. */
  tick(turn: number, ctx: BeatContext): Beat | null {
    if (turn - this.lastBeat < BEAT_COOLDOWN) return null;
    if (!this.r.chance(BEAT_CHANCE)) return null;
    this.lastBeat = turn;
    const roll = this.r.float();
    if (roll >= 0.9 && ctx.encounterReady) {
      this.lastEncounter = turn;
      return { kind: 'encounter' };
    }
    if (roll >= 0.55 && !ctx.sceneActive) {
      const scene = this.pickScene(ctx);
      if (scene) return { kind: 'scene', scene };
    }
    return { kind: 'message' };
  }

  pickScene(ctx: BeatContext): StreetSceneDef | null {
    const fits = SCENES.filter((s) => {
      const pre = s.pre;
      if (!hourMatches(pre, ctx.hour)) return false;
      if (pre?.areaTypes && !pre.areaTypes.includes(ctx.areaType)) return false;
      if (pre?.stat) {
        for (const [k, min] of Object.entries(pre.stat)) {
          if ((ctx.state.stats[k as keyof typeof ctx.state.stats] ?? 0) < (min as number)) return false;
        }
      }
      if (s.behavior === 'blackout' && this.blackoutUntil > 0) return false;
      return true;
    });
    if (!fits.length) return null;
    let total = 0;
    for (const s of fits) total += s.weight;
    let roll = this.r.float() * total;
    for (const s of fits) {
      roll -= s.weight;
      if (roll <= 0) return s;
    }
    return fits[fits.length - 1];
  }
}
