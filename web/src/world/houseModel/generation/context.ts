import type { HouseConfig } from "../../../types/config";
import type { BrickTextureFile } from "../types";
import type { RNG } from "../../../utils/seededRng";
import { makeRng } from "../../../utils/seededRng";

const BRICK_TEXTURES: BrickTextureFile[] = [
  "brick_normal.jpg",
  "brick_golden.jpg",
  "brick_grey.jpg",
  "brick_red.jpg",
  "brick_white.jpg",
];

export interface HouseGenContext {
  streetSeed: string;
  seed: string; // `${streetSeed}/house/${house.houseNumber}`
  rng: RNG;     // for future intelligent variation (deterministic)
  xsize: number;
  zsize: number;

  // Deterministically chosen per-house exterior brick texture (never brick_dark.jpg).
  brickTexture: BrickTextureFile;
}

export function makeHouseGenContext(house: HouseConfig, streetSeed: string): HouseGenContext {
  const seed = `${streetSeed}/house/${house.houseNumber}`;
  const { xsize, zsize } = house.bounds;

  if (zsize !== 30) {
    throw new Error(`House ${house.houseNumber} has zsize=${zsize}, expected 30`);
  }

  // Use a dedicated derived seed so brick selection never changes if room-generation RNG usage changes.
  const brickTexture = makeRng(`${seed}/brick`).pick(BRICK_TEXTURES);

  return {
    streetSeed,
    seed,
    rng: makeRng(seed),
    xsize,
    zsize,
    brickTexture,
  };
}
