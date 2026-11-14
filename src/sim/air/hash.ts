/**
 * Integer hashes and a seeded generator. The air must be the same for the same place, time
 * and seed whatever order it is asked in, so random features come from hashing their
 * coordinates instead of from a stream of random numbers.
 */

/** 32-bit hash of three integers and a seed (a murmur3-style finaliser over a mix). */
export function hash3(a: number, b: number, c: number, seed: number): number {
  let h =
    Math.imul(a | 0, 0x8da6b343) ^ Math.imul(b | 0, 0xd8163841) ^ Math.imul(c | 0, 0xcb1ab31f);
  h = (h ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1) from a hash. */
export const unit = (h: number) => h / 4_294_967_296;

/** Next value in [0, 1) from a hash chain: each call re-hashes the previous hash. */
export const rehash = (h: number) => hash3(h, 0x27d4eb2f, 0x165667b1, 0x9e3779b9);

/** Seeded generator (mulberry32) for building fixed tables once at construction. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
