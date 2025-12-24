export interface RNG {
  next(): number; // [0,1)
  float(min: number, max: number): number;
  int(minInclusive: number, maxInclusive: number): number;
  bool(pTrue?: number): boolean;
  pick<T>(arr: readonly T[]): T;
}

function xmur3(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seedString: string): RNG {
  const seedGen = xmur3(seedString);
  const rand = mulberry32(seedGen());

  return {
    next: () => rand(),
    float: (min, max) => min + (max - min) * rand(),
    int: (minInclusive, maxInclusive) => {
      const r = rand();
      const span = maxInclusive - minInclusive + 1;
      return minInclusive + Math.floor(r * span);
    },
    bool: (pTrue = 0.5) => rand() < pTrue,
    pick: <T,>(arr: readonly T[]) => {
      if (arr.length === 0) throw new Error("pick() called with empty array");
      const idx = Math.floor(rand() * arr.length);
      return arr[idx]!;
    },
  };
}
