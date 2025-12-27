import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region } from "../types";
import type { HouseGenContext } from "./context";

const EPS = 1e-6;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function rect(name: string, surface: Region["surface"], x0: number, z0: number, x1: number, z1: number): Region {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  return { name, surface, type: "rectangle", points: [[minX, minZ], [maxX, maxZ]] };
}

function poly(name: string, surface: Region["surface"], pts: Array<[number, number]>): Region {
  // Spec: polygons are NOT explicitly closed; closure is implied by the consumer.
  return { name, surface, type: "polygon", points: pts };
}

/**
 * Plot generator (deterministic, seeded).
 *
 * Constraints satisfied:
 * - Exactly 8 regions: backyard, houseregion, frontlawn_near, frontlawn_far, driveway_near, driveway_far, sidewalk, walkway
 * - Sidewalk is ALWAYS rectangle (0,25) to (xsize,26.5)
 * - No overlaps; regions fully cover the lot (lot-local: x in [0,xsize], z in [0,30])
 * - Walkway connects the sidewalk up to the house front (meets the porch/bump edge)
 *
 * Variation (per-house, deterministic):
 * - Driveway can be left or right
 * - Driveway width varies realistically with lot width
 * - Walkway width varies
 * - House depth, porch/bump depth, bump span vary
 * - Optional rear extension notch varies
 */
export function generatePlotModel(house: HouseConfig, ctx: HouseGenContext): FloorModel {
  const { rng, xsize } = ctx;
  const zsize = 30; // enforced by ctx

  // Fixed sidewalk by spec (distance to road edge, width, etc.)
  const Z_SIDEWALK_START = 25;
  const Z_SIDEWALK_END = 26.5;
  const Z_LOT_END = zsize;

  // --------- Horizontal (X) decisions
  // Random driveway side (deterministic by seed); small bias prevents “perfect alternation”
  const drivewaySide: "left" | "right" = rng.bool(0.55) ? "left" : "right";

  // Walkway width: ~1.0–1.8m typical for a front path.
  const walkwayW = clamp(rng.float(1.0, 1.8), 0.9, 2.2);

  // Driveway width: typical single driveway 3.0–4.8m.
  // Ensure there is ALWAYS some lawn width remaining on the non-driveway side.
  const minLawnW = 2.2; // keep some visible grass even on small lots
  const drivewayW = clamp(rng.float(3.0, 4.8), 2.8, xsize - walkwayW - minLawnW);

  // Driveway + walkway positions (walkway is always immediately “inside” the driveway)
  let xDrive0 = 0;
  let xDrive1 = 0;
  let xWalk0 = 0;
  let xWalk1 = 0;

  if (drivewaySide === "left") {
    xDrive0 = 0;
    xDrive1 = drivewayW;
    xWalk0 = xDrive1;
    xWalk1 = clamp(xWalk0 + walkwayW, xWalk0 + 0.5, xsize - minLawnW);
  } else {
    xDrive1 = xsize;
    xDrive0 = xsize - drivewayW;
    xWalk1 = xDrive0;
    xWalk0 = clamp(xWalk1 - walkwayW, minLawnW, xWalk1 - 0.5);
  }

  assert(xDrive1 - xDrive0 > 0.5, `Plot gen house ${house.houseNumber}: driveway width too small`);
  assert(xWalk1 - xWalk0 > 0.4, `Plot gen house ${house.houseNumber}: walkway width too small`);
  assert(xDrive0 >= -EPS && xDrive1 <= xsize + EPS, `Plot gen house ${house.houseNumber}: driveway out of bounds`);
  assert(xWalk0 >= -EPS && xWalk1 <= xsize + EPS, `Plot gen house ${house.houseNumber}: walkway out of bounds`);

  // --------- Vertical (Z) decisions
  // House back line (end of backyard): 7–10m is common in these scaled lots.
  let zHouseBack = clamp(rng.float(7.2, 9.8), 6.8, 10.5);

  // House main front line (garage line): around 18.5–20.8 to leave realistic front yard.
  let zFrontMain = clamp(rng.float(18.6, 20.8), 18.0, 21.2);

  // Ensure the house has a plausible depth
  const minHouseDepth = 9.0;
  if (zFrontMain - zHouseBack < minHouseDepth) {
    // push front forward if needed (still keeping space to sidewalk)
    zFrontMain = Math.min(zFrontMain + (minHouseDepth - (zFrontMain - zHouseBack)), 21.2);
  }
  assert(zFrontMain - zHouseBack >= 8.5, `Plot gen house ${house.houseNumber}: house depth too small`);

  // Porch/bump depth (house protrusion towards sidewalk):
  // must stay behind the sidewalk start.
  const bumpMax = Z_SIDEWALK_START - 0.9 - zFrontMain; // leave ≥0.9m to sidewalk start
  const bumpDepth = clamp(rng.float(2.0, 3.5), 1.4, Math.max(1.4, bumpMax));
  const zFrontBump = zFrontMain + bumpDepth;

  assert(zFrontBump < Z_SIDEWALK_START - 0.2, `Plot gen house ${house.houseNumber}: bump too close to sidewalk`);

  // --------- Rear extension notch (optional)
  const hasRearExt = rng.bool(0.65);
  let zHouseBackExt = zHouseBack; // if no notch, ext == main
  let notchX0 = 0;
  let notchX1 = 0;

  if (hasRearExt) {
    const maxExt = Math.max(0, zHouseBack - 1.2);
    const rearExtDepth = clamp(rng.float(0.8, 1.6), 0.6, maxExt);
    if (rearExtDepth > 0.25) {
      zHouseBackExt = zHouseBack - rearExtDepth;

      // notch: keep it away from lot edges, realistic mid-lot extension
      const margin = Math.min(1.2, xsize * 0.12);
      const maxNotchW = Math.max(2.2, xsize - 2 * margin);
      const notchW = clamp(rng.float(xsize * 0.25, xsize * 0.45), 2.4, maxNotchW);

      notchX0 = clamp(rng.float(margin, xsize - margin - notchW), margin, xsize - margin - notchW);
      notchX1 = notchX0 + notchW;
    }
  }

  const useRearNotch = Math.abs(zHouseBackExt - zHouseBack) > 0.2 && notchX1 - notchX0 > 1.0;

  // --------- Front bump span (X)
  // Bump sits on the "lawn side" adjacent to the driveway/walkway (porch / forward section).
  if (drivewaySide === "left") {
    const extraPastWalk = rng.float(0.8, 2.4);
    const minBumpRight = xWalk1 + extraPastWalk;
    const bumpRightMax = xsize - 0.6;
    const bumpRight = clamp(rng.float(minBumpRight, minBumpRight + rng.float(0.8, 2.2)), minBumpRight, bumpRightMax);

    // --------- Build regions (LEFT driveway)
    const regions: Region[] = [];

    // backyard
    if (useRearNotch) {
      regions.push(
        poly("backyard", "grass", [
          [0, 0],
          [xsize, 0],
          [xsize, zHouseBack],
          [notchX1, zHouseBack],
          [notchX1, zHouseBackExt],
          [notchX0, zHouseBackExt],
          [notchX0, zHouseBack],
          [0, zHouseBack],
        ])
      );
    } else {
      regions.push(rect("backyard", "grass", 0, 0, xsize, zHouseBack));
    }

    // houseregion
    const housePts: Array<[number, number]> = [];
    if (useRearNotch) {
      housePts.push([0, zHouseBack]);
      housePts.push([notchX0, zHouseBack]);
      housePts.push([notchX0, zHouseBackExt]);
      housePts.push([notchX1, zHouseBackExt]);
      housePts.push([notchX1, zHouseBack]);
      housePts.push([xsize, zHouseBack]);
    } else {
      housePts.push([0, zHouseBack], [xsize, zHouseBack]);
    }

    housePts.push(
      [xsize, zFrontMain],
      [bumpRight, zFrontMain],
      [bumpRight, zFrontBump],
      [xDrive1, zFrontBump],
      [xDrive1, zFrontMain],
      [0, zFrontMain]
    );

    regions.push(poly("houseregion", "black", housePts));

    // frontlawn_near (always cover the strip between zFrontMain and zFrontBump when bump stops short of lot edge)
    const farGap = xsize - bumpRight;
    if (farGap > EPS) {
      regions.push(
        poly("frontlawn_near", "grass", [
          [xWalk1, zFrontBump],
          [xWalk1, Z_SIDEWALK_START],
          [xsize, Z_SIDEWALK_START],
          [xsize, zFrontMain],
          [bumpRight, zFrontMain],
          [bumpRight, zFrontBump],
        ])
      );
    } else {
      // If the bump reaches the lot edge exactly, the strip has zero width; a rectangle avoids degenerate polys.
      regions.push(rect("frontlawn_near", "grass", xWalk1, zFrontBump, xsize, Z_SIDEWALK_START));
    }

    // walkway
    regions.push(rect("walkway", "concrete_medium", xWalk0, zFrontBump, xWalk1, Z_SIDEWALK_START));

    // frontlawn_far (front strip beyond sidewalk, lawn side)
    regions.push(rect("frontlawn_far", "grass", xDrive1, Z_SIDEWALK_END, xsize, Z_LOT_END));

    // driveway_near (driveway behind sidewalk)
    regions.push(rect("driveway_near", "concrete_dark", xDrive0, zFrontMain, xDrive1, Z_SIDEWALK_START));

    // driveway_far (driveway beyond sidewalk)
    regions.push(rect("driveway_far", "concrete_dark", xDrive0, Z_SIDEWALK_END, xDrive1, Z_LOT_END));

    // sidewalk (fixed)
    regions.push(rect("sidewalk", "concrete_light", 0, Z_SIDEWALK_START, xsize, Z_SIDEWALK_END));

    return { regions, construction: [], objects: [] };
  } else {
    // drivewaySide === "right"
    const extraPastWalk = rng.float(0.8, 2.4);
    const maxBumpLeft = xWalk0 - extraPastWalk;
    const bumpLeftMin = 0.6;
    const bumpLeft = clamp(rng.float(maxBumpLeft - rng.float(0.8, 2.2), maxBumpLeft), bumpLeftMin, maxBumpLeft);

    // --------- Build regions (RIGHT driveway)
    const regions: Region[] = [];

    // backyard
    if (useRearNotch) {
      regions.push(
        poly("backyard", "grass", [
          [0, 0],
          [xsize, 0],
          [xsize, zHouseBack],
          [notchX1, zHouseBack],
          [notchX1, zHouseBackExt],
          [notchX0, zHouseBackExt],
          [notchX0, zHouseBack],
          [0, zHouseBack],
        ])
      );
    } else {
      regions.push(rect("backyard", "grass", 0, 0, xsize, zHouseBack));
    }

    // houseregion (bump on the LEFT side adjacent to driveway)
    const housePts: Array<[number, number]> = [];
    if (useRearNotch) {
      housePts.push([0, zHouseBack]);
      housePts.push([notchX0, zHouseBack]);
      housePts.push([notchX0, zHouseBackExt]);
      housePts.push([notchX1, zHouseBackExt]);
      housePts.push([notchX1, zHouseBack]);
      housePts.push([xsize, zHouseBack]);
    } else {
      housePts.push([0, zHouseBack], [xsize, zHouseBack]);
    }

    housePts.push(
      [xsize, zFrontMain],
      [xDrive0, zFrontMain],
      [xDrive0, zFrontBump],
      [bumpLeft, zFrontBump],
      [bumpLeft, zFrontMain],
      [0, zFrontMain]
    );

    regions.push(poly("houseregion", "black", housePts));

    // frontlawn_near (always cover the strip between zFrontMain and zFrontBump when bump stops short of lot edge)
    const farGap = bumpLeft; // distance from left boundary to bump
    if (farGap > EPS) {
      regions.push(
        poly("frontlawn_near", "grass", [
          [xWalk0, zFrontBump],
          [xWalk0, Z_SIDEWALK_START],
          [0, Z_SIDEWALK_START],
          [0, zFrontMain],
          [bumpLeft, zFrontMain],
          [bumpLeft, zFrontBump],
        ])
      );
    } else {
      // If the bump reaches the lot edge exactly, the strip has zero width; a rectangle avoids degenerate polys.
      regions.push(rect("frontlawn_near", "grass", 0, zFrontBump, xWalk0, Z_SIDEWALK_START));
    }

    // walkway
    regions.push(rect("walkway", "concrete_medium", xWalk0, zFrontBump, xWalk1, Z_SIDEWALK_START));

    // frontlawn_far (front strip beyond sidewalk, lawn side)
    regions.push(rect("frontlawn_far", "grass", 0, Z_SIDEWALK_END, xDrive0, Z_LOT_END));

    // driveway_near (driveway behind sidewalk)
    regions.push(rect("driveway_near", "concrete_dark", xDrive0, zFrontMain, xDrive1, Z_SIDEWALK_START));

    // driveway_far (driveway beyond sidewalk)
    regions.push(rect("driveway_far", "concrete_dark", xDrive0, Z_SIDEWALK_END, xDrive1, Z_LOT_END));

    // sidewalk (fixed)
    regions.push(rect("sidewalk", "concrete_light", 0, Z_SIDEWALK_START, xsize, Z_SIDEWALK_END));

    return { regions, construction: [], objects: [] };
  }
}
