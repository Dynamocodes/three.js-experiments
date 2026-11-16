/** A seeded random number generator: call it for a number in [0, 1). */
export interface Rng {
  (): number;
  /** A number in [min, max). */
  range(min: number, max: number): number;
  /** A random element of `items`. */
  pick<T>(items: readonly T[]): T;
}

/** Seeded PRNG (mulberry32). Same seed => same forest on every load. */
export function createRng(seed = 1): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    range: (min: number, max: number) => min + next() * (max - min),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  });
}
