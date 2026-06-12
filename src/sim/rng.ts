// Seeded, deterministic PRNG. One stream per subsystem, all derived from the
// world seed (PRD §3.4): same seed + same inputs => same world.

export type RNGFn = () => number;

// xmur3 string hash -> 32-bit seed generator
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function sfc32(a: number, b: number, c: number, d: number): RNGFn {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export class Rand {
  private fn: RNGFn;

  constructor(seed: string, stream: string) {
    const gen = xmur3(`${seed}::${stream}`);
    this.fn = sfc32(gen(), gen(), gen(), gen());
    // sfc32 needs a few warmup rounds to decorrelate from the hash
    for (let i = 0; i < 12; i++) this.fn();
  }

  float(): number {
    return this.fn();
  }

  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.fn() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.fn() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.fn() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.fn() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
