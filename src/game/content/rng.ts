/**
 * Seeded pseudo-random number generator.
 *
 * Every random choice in ward generation flows through one of these, so a shift
 * is fully determined by its seed. That is what makes a generated ward testable:
 * a test can name a seed and get the same eight patients every run, and a player
 * can replay an interesting night rather than losing it.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform real in [min, max). */
  real(min: number, max: number): number;
  /** Normally distributed, clamped to [min, max]. */
  gauss(mean: number, sd: number, min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T;
  /** `count` distinct elements, in random order. */
  sample<T>(items: readonly T[], count: number): T[];
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * mulberry32 — small, fast, and good enough for content generation.
 * Chosen over Math.random precisely because it is seedable and portable, so the
 * same seed produces the same ward in a browser and in a test runner.
 */
export function makeRng(seed: number | string): Rng {
  let state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    real: (min, max) => min + next() * (max - min),
    gauss(mean, sd, min, max) {
      // Box-Muller, matching the engine's own patient sampler.
      const u1 = Math.max(next(), 1e-10);
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.min(max, Math.max(min, mean + sd * z));
    },
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle(items) {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    sample(items, count) {
      return rng.shuffle(items).slice(0, Math.min(count, items.length));
    },
  };

  return rng;
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A short, human-typeable seed, so a good shift can be written down and replayed. */
export function randomSeed(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
