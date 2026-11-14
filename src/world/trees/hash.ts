/**
 * Integer hashes for the scatter: every random choice of a tree comes from its global grid
 * cell (or its position), never from Math.random, so the same tree stands in the same place
 * on every visit and for every player.
 */

/** 32-bit avalanche hash of two integers (lowbias32 by Chris Wellons, combined). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca77) ^ Math.imul(seed, 0xc2b2ae3d);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1) from two integers and a stream number. */
export function rand2(x: number, y: number, stream: number): number {
  return hash2(x, y, stream) / 4294967296;
}

/** Small seeded generator for building geometry (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
