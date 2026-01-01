import type { HouseConfig } from "../../types/config";

export function lotLocalToWorld(house: HouseConfig, localX: number, localZ: number): { x: number; z: number } {
  const { x, z, xsize, zsize } = house.bounds;

  // Even houses: straightforward.
  if (house.houseNumber % 2 === 0) {
    return { x: x + localX, z: z + localZ };
  }

  // Odd houses: mirror Z only so the lot-local "front" remains at localZ=30 (road side),
  // while lot-local +x consistently maps to world +x (needed for right-edge padding).
  return { x: x + localX, z: z + (zsize - localZ) };
}
