import type { HouseConfig } from "../../../types/config";
import type { RNG } from "../../../utils/seededRng";
import { makeRng } from "../../../utils/seededRng";

export interface HouseGenContext {
  streetSeed: string;
  seed: string; // `${streetSeed}/house/${house.houseNumber}`
  rng: RNG;     // for future intelligent variation (deterministic)
  xsize: number;
  zsize: number;
}

export function makeHouseGenContext(house: HouseConfig, streetSeed: string): HouseGenContext {
  const seed = `${streetSeed}/house/${house.houseNumber}`;
  const { xsize, zsize } = house.bounds;

  if (zsize !== 30) {
    throw new Error(`House ${house.houseNumber} has zsize=${zsize}, expected 30`);
  }

  return {
    streetSeed,
    seed,
    rng: makeRng(seed),
    xsize,
    zsize,
  };
}
