import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region } from "../types";
import type { HouseGenContext } from "./context";

function rect(name: string, surface: Region["surface"], x0: number, z0: number, x1: number, z1: number): Region {
  return { name, surface, type: "rectangle", points: [[x0, z0], [x1, z1]] };
}

function poly(name: string, surface: Region["surface"], pts: Array<[number, number]>): Region {
  // Spec: polygon points are conceptually (p1, p2, ... pn, p1). We close if needed.
  if (pts.length >= 3) {
    const [fx, fz] = pts[0]!;
    const [lx, lz] = pts[pts.length - 1]!;
    if (fx !== lx || fz !== lz) pts = [...pts, [fx, fz]];
  }
  return { name, surface, type: "polygon", points: pts };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Plot-only generator (flat).
 *
 * IMPORTANT (current milestone):
 * - Matches the plot-region example in `web/src/world/houseModel/requirements.txt`.
 * - All regions from the example are generated for every house, using lot-local coordinates.
 * - zsize is fixed at 30 (per spec).
 * - Polygons are used for backyard, houseregion, nearfrontlawn.
 */
export function generatePlotModel(house: HouseConfig, ctx: HouseGenContext): FloorModel {
  const xsize = ctx.xsize;
  const zsize = ctx.zsize;

  // ---- Template coordinates taken from the requirements example (modeled after 43 Jenmat Dr.)
  // The example lot width is 12. We scale X to fit each lot's xsize (10..16).
  const X_REF = 12;
  const sx = xsize / X_REF;

  const X = (x: number) => clamp(x * sx, 0, xsize);

  // Z coordinates (lot-local, zsize=30) match the example exactly.
  const Z_BACKYARD_TOP = 8;
  const Z_BACKYARD_NOTCH = 7;

  const Z_HOUSE_FRONT_MAIN = 19.5;
  const Z_HOUSE_FRONT_BUMP = 22.5;

  const Z_SIDEWALK_START = 25;
  const Z_SIDEWALK_END = 26.5;
  const Z_LOT_END = zsize;

  // X coordinates (scaled) match the example's structure.
  const xNotch0 = X(7);
  const xNotch1 = X(11);

  const xDriveway = X(5.5);   // driveway width + left edge of walkway/edgefrontlawn
  const xWalkRight = X(7.5);  // right edge of walkway + left edge of nearfrontlawn
  const xBumpRight = xNotch1; // matches example (11)

  // Defensive ordering (should already hold under the scaling above)
  const notch0 = clamp(Math.min(xNotch0, xNotch1), 0, xsize);
  const notch1 = clamp(Math.max(xNotch0, xNotch1), 0, xsize);

  const drivewayX = clamp(xDriveway, 0, xsize);
  const walkX = clamp(Math.max(xWalkRight, drivewayX + 0.05), 0, xsize);
  const bumpRight = clamp(Math.max(xBumpRight, walkX + 0.05), 0, xsize);

  // ---- Plot regions (must fully cover the lot, with no overlaps)
  // Names/surfaces/types correspond to the example exactly.
  const regions: Region[] = [
    // backyard (polygon)
    poly("backyard", "grass", [
      [0, 0],
      [xsize, 0],
      [xsize, Z_BACKYARD_TOP],
      [notch1, Z_BACKYARD_TOP],
      [notch1, Z_BACKYARD_NOTCH],
      [notch0, Z_BACKYARD_NOTCH],
      [notch0, Z_BACKYARD_TOP],
      [0, Z_BACKYARD_TOP],
    ]),

    // houseregion (polygon)
    poly("houseregion", "black", [
      [0, Z_BACKYARD_TOP],
      [notch0, Z_BACKYARD_TOP],
      [notch0, Z_BACKYARD_NOTCH],
      [notch1, Z_BACKYARD_NOTCH],
      [notch1, Z_BACKYARD_TOP],
      [xsize, Z_BACKYARD_TOP],
      [xsize, Z_HOUSE_FRONT_MAIN],
      [bumpRight, Z_HOUSE_FRONT_MAIN],
      [bumpRight, Z_HOUSE_FRONT_BUMP],
      [drivewayX, Z_HOUSE_FRONT_BUMP],
      [drivewayX, Z_HOUSE_FRONT_MAIN],
      [0, Z_HOUSE_FRONT_MAIN],
    ]),

    // nearfrontlawn (polygon)
    poly("nearfrontlawn", "grass", [
      [walkX, Z_HOUSE_FRONT_BUMP],
      [walkX, Z_SIDEWALK_START],
      [xsize, Z_SIDEWALK_START],
      [xsize, Z_HOUSE_FRONT_MAIN],
      [bumpRight, Z_HOUSE_FRONT_MAIN],
      [bumpRight, Z_HOUSE_FRONT_BUMP],
    ]),

    // walkway (rectangle)
    rect("walkway", "concrete_medium", drivewayX, Z_HOUSE_FRONT_BUMP, walkX, Z_SIDEWALK_START),

    // edgefrontlawn (rectangle)
    rect("edgefrontlawn", "grass", drivewayX, Z_SIDEWALK_END, xsize, Z_LOT_END),

    // neardriveway (rectangle)
    rect("neardriveway", "concrete_dark", 0, Z_HOUSE_FRONT_MAIN, drivewayX, Z_SIDEWALK_START),

    // edgedriveway (rectangle)
    rect("edgedriveway", "concrete_dark", 0, Z_SIDEWALK_END, drivewayX, Z_LOT_END),

    // sidewalk (rectangle) — fixed by spec
    rect("sidewalk", "concrete_light", 0, Z_SIDEWALK_START, xsize, Z_SIDEWALK_END),
  ];

  return { regions, construction: [], objects: [] };
}
