import type { HouseConfig } from "../../types/config";
import type { HouseModel, Region } from "./types";
import { makeRng } from "../../utils/seededRng";

function rect(name: string, surface: Region["surface"], x0: number, z0: number, x1: number, z1: number): Region {
  return { name, surface, type: "rectangle", points: [[x0, z0], [x1, z1]] };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function generateHouseModel(house: HouseConfig, streetSeed: string): HouseModel {
  // Lot-local coordinates are ALWAYS 0..xsize and 0..zsize (zsize=30),
  // with "front" at z=30 and sidewalk at z=25..26.5 for EVERY house.
  const seed = `${streetSeed}/house/${house.houseNumber}`;
  const rng = makeRng(seed);

  const xsize = house.bounds.xsize;
  const zsize = house.bounds.zsize;

  if (zsize !== 30) {
    // You can relax this later, but for now it keeps things sane.
    throw new Error(`House ${house.houseNumber} has zsize=${zsize}, expected 30`);
  }

  // --- Choose a rectangular house footprint inside the lot ---
  const leftMargin = rng.float(0.7, 2.2);
  const rightMargin = rng.float(0.7, 2.2);

  const hx0 = clamp(leftMargin, 0, xsize - 6);
  const hx1 = clamp(xsize - rightMargin, hx0 + 6, xsize);

  const houseDepth = rng.float(10.0, 13.5);
  const houseFrontZ = rng.float(18.5, 22.5);
  const houseBackZ = clamp(houseFrontZ - houseDepth, 5.5, houseFrontZ - 6.0);

  // Plot bands:
  // [0..houseBackZ] backyard
  // [houseBackZ..houseFrontZ] mid band (side yards + house)
  // [houseFrontZ..25] front band (driveway + lawn + walkway)
  // [25..26.5] sidewalk (fixed)
  // [26.5..30] edge strip (front edge)
  const regions: Region[] = [];

  // Backyard
  regions.push(rect("backyard", "grass", 0, 0, xsize, houseBackZ));

  // Mid band split into: left yard, house, right yard
  if (hx0 > 0.001) regions.push(rect("sideyard_left", "grass", 0, houseBackZ, hx0, houseFrontZ));
  regions.push(rect("houseregion", "black", hx0, houseBackZ, hx1, houseFrontZ));
  if (hx1 < xsize - 0.001) regions.push(rect("sideyard_right", "grass", hx1, houseBackZ, xsize, houseFrontZ));

  // Front band: driveway + lawns + walkway
  const drivewaySide = rng.bool(0.5) ? "left" : "right";
  const drivewayWidth = clamp(rng.float(2.8, 4.8), 2.5, xsize * 0.45);

  let lawnX0 = 0;
  let lawnX1 = xsize;

  if (drivewaySide === "left") {
    regions.push(rect("driveway", "concrete_dark", 0, houseFrontZ, drivewayWidth, 25));
    lawnX0 = drivewayWidth;
  } else {
    regions.push(rect("driveway", "concrete_dark", xsize - drivewayWidth, houseFrontZ, xsize, 25));
    lawnX1 = xsize - drivewayWidth;
  }

  // Walkway within lawn strip
  const walkwayWidth = clamp(rng.float(0.9, 1.3), 0.8, 1.5);
  const walkwayX0 = clamp(rng.float(lawnX0 + 0.4, lawnX1 - walkwayWidth - 0.4), lawnX0, lawnX1 - walkwayWidth);
  const walkwayX1 = walkwayX0 + walkwayWidth;

  // Lawn split into up to 2 rectangles to avoid overlap with walkway
  if (walkwayX0 > lawnX0 + 0.001) regions.push(rect("frontyard_lawn_a", "grass", lawnX0, houseFrontZ, walkwayX0, 25));
  regions.push(rect("walkway", "concrete_medium", walkwayX0, houseFrontZ, walkwayX1, 25));
  if (walkwayX1 < lawnX1 - 0.001) regions.push(rect("frontyard_lawn_b", "grass", walkwayX1, houseFrontZ, lawnX1, 25));

  // Side lawn behind driveway (if any gap exists in mid band front portion)
  // (optional; keeps full coverage simpler visually)
  // Nothing needed because bands already cover all z ranges; x ranges are covered.

  // Sidewalk (required exact coordinates)
  regions.push(rect("sidewalk", "concrete_light", 0, 25, xsize, 26.5));

  // Edge strip at front
  regions.push(rect("front_edge", "grass", 0, 26.5, xsize, 30));

  // --- Floors: simple partitions that cover the house footprint rectangle ---
  // First floor: split into 4 rectangles (2x2)
  const splitX = hx0 + (hx1 - hx0) * rng.float(0.45, 0.60);
  const splitZ = houseBackZ + (houseFrontZ - houseBackZ) * rng.float(0.45, 0.60);

  const firstFloorRegions: Region[] = [
    rect("ff_room_a", "concrete_light", hx0, houseBackZ, splitX, splitZ),
    rect("ff_room_b", "concrete_light", splitX, houseBackZ, hx1, splitZ),
    rect("ff_room_c", "concrete_light", hx0, splitZ, splitX, houseFrontZ),
    rect("ff_room_d", "concrete_light", splitX, splitZ, hx1, houseFrontZ),
  ];

  // Second floor: different split for variety
  const splitX2 = hx0 + (hx1 - hx0) * rng.float(0.40, 0.65);
  const splitZ2 = houseBackZ + (houseFrontZ - houseBackZ) * rng.float(0.40, 0.65);

  const secondFloorRegions: Region[] = [
    rect("sf_room_a", "concrete_light", hx0, houseBackZ, splitX2, splitZ2),
    rect("sf_room_b", "concrete_light", splitX2, houseBackZ, hx1, splitZ2),
    rect("sf_room_c", "concrete_light", hx0, splitZ2, splitX2, houseFrontZ),
    rect("sf_room_d", "concrete_light", splitX2, splitZ2, hx1, houseFrontZ),
  ];

  return {
    seed,
    plot: { regions, objects: [] },
    firstFloor: { regions: firstFloorRegions, objects: [] },
    secondFloor: { regions: secondFloorRegions, objects: [] },
  };
}
