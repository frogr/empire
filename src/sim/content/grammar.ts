// Tracery-style grammar engine (PRD §6): '#slot#' expands recursively from the
// rule set; '{key}' interpolates sim state from ctx. Deterministic via Rand.

import { Rand } from '../rng';

const MAX_DEPTH = 8;

export type GrammarRules = Record<string, string[]>;
export type GrammarCtx = Record<string, string | number>;

export class Grammar {
  private rules: GrammarRules;

  constructor(...ruleSets: GrammarRules[]) {
    this.rules = {};
    for (const set of ruleSets) {
      for (const [k, v] of Object.entries(set)) {
        this.rules[k] = this.rules[k] ? this.rules[k].concat(v) : [...v];
      }
    }
  }

  expand(template: string, rand: Rand, ctx: GrammarCtx = {}): string {
    return this.expandDepth(template, rand, ctx, 0);
  }

  private expandDepth(template: string, rand: Rand, ctx: GrammarCtx, depth: number): string {
    let out = template.replace(/\{(\w+)\}/g, (_, key: string) =>
      key in ctx ? String(ctx[key]) : `{${key}}`,
    );
    if (depth >= MAX_DEPTH) return out;
    out = out.replace(/#(\w+)#/g, (_, slot: string) => {
      const options = this.rules[slot];
      if (!options || options.length === 0) return `[${slot}]`;
      return this.expandDepth(rand.pick(options), rand, ctx, depth + 1);
    });
    return out;
  }

  has(slot: string): boolean {
    return slot in this.rules;
  }
}

/** Sentence-case a generated string without touching interior capitals. */
export function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
