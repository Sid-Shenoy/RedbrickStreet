import type { HouseConfig } from "../../types/config";

export function lotLocalToWorld(house: HouseConfig, localX: number, localZ: number): { x: number; z: number } {
  const { x, z, xsize, zsize } = house.bounds;

  // Even houses: straightforward.
  if (house.houseNumber % 2 === 0) {
    return { x: x + localX, z: z + localZ };
  }

  // Odd houses: mirrored so that "front" remains at lot-local z=30 (road side) consistently.
  return { x: x + (xsize - localX), z: z + (zsize - localZ) };
}
