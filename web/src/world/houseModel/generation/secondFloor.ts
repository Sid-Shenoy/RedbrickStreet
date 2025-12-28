// web/src/world/houseModel/generation/secondFloor.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region, Surface, PolyPoints } from "../types";
import type { HouseGenContext } from "./context";
import { makeRng } from "../../../utils/seededRng";

/**
 * SECOND FLOOR (BELIEVABLE + ROBUST)
 *
 * Goals (per requirements.txt):
 * - Bedrooms + bathrooms upstairs with simple connectivity via a hallway.
 * - Bedrooms are all named exactly "bedroom" (no numbered bedrooms).
 * - Hallway must touch the projection of the first-floor "stairs" rectangle.
 * - All second-floor rectangles must lie fully within the plot "houseregion" polygon.
 * - No need to perfectly cover the footprint; second floor may be smaller.
 *
 * Design:
 * - Use the "wide band" of the houseregion (the full-width rectangle in front of the rear notch/extension),
 *   which plot.ts guarantees exists.
 * - Place a long hallway strip (wood) adjacent to the stairs in X (sharing an edge segment),
 *   spanning the wide band depth.
 * - Place rooms on one side of the hallway (opposite the stair-side when possible), as Z-slices that all touch
 *   the hallway by sharing a vertical boundary segment (>= 0.6m by construction).
 * - Optionally carve closets from the *outer* edge of some bedrooms (closets then touch the bedroom).
 * - Deterministic retries: if an attempt cannot satisfy hard constraints, retry with a deterministic attempt seed.
 */

const EPS = 1e-6;
const MAX_ATTEMPTS = 10;

// Leave a small perimeter margin so upstairs feels smaller than the footprint (and avoids boundary tolerance issues).
const OUTER_MARGIN_X = 0.4;
const OUTER_MARGIN_Z = 0.4;

type Rect = { x0: number; x1: number; z0: number; z1: number };

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function ceilQ(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.ceil((v - 1e-12) * f) / f;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function rectNorm(ax: number, az: number, bx: number, bz: number): Rect {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const z0 = Math.min(az, bz);
  const z1 = Math.max(az, bz);
  return { x0: q(x0), x1: q(x1), z0: q(z0), z1: q(z1) };
}
function rectW(r: Rect) {
  return r.x1 - r.x0;
}
function rectD(r: Rect) {
  return r.z1 - r.z0;
}
function rectArea(r: Rect) {
  return rectW(r) * rectD(r);
}
function rectMinDim(r: Rect) {
  return Math.min(rectW(r), rectD(r));
}

function pickWood(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["wood_light", "wood_medium", "wood_dark"] as const);
}
function pickTile(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["tile_light", "tile_medium", "tile_dark"] as const);
}

function rectToRegion(name: string, surface: Surface, r: Rect): Region {
  return {
    name,
    surface,
    type: "rectangle",
    points: [
      [r.x0, r.z0],
      [r.x1, r.z1],
    ],
  };
}

function getRegionByName(f: FloorModel, name: string): Region | undefined {
  return f.regions.find((r) => r.name === name);
}

function rectFromRegion(r: Extract<Region, { type: "rectangle" }>): Rect {
  const [[x0, z0], [x1, z1]] = r.points;
  return rectNorm(x0, z0, x1, z1);
}

function uniqSorted(vals: number[]): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) {
    if (!out.length) out.push(v);
    else if (Math.abs(v - out[out.length - 1]!) > 1e-3) out.push(v);
  }
  return out;
}

function pointOnSegAxisAligned(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  tol = 1e-6
): boolean {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);

  // Vertical
  if (dx <= tol && Math.abs(x - ax) <= tol) {
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    return z + tol >= z0 && z - tol <= z1;
  }
  // Horizontal
  if (dz <= tol && Math.abs(z - az) <= tol) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    return x + tol >= x0 && x - tol <= x1;
  }
  return false;
}

function pointInPolyOrOnBoundary(x: number, z: number, poly: PolyPoints): boolean {
  if (poly.length < 3) return false;

  // boundary check
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (pointOnSegAxisAligned(x, z, a[0], a[1], b[0], b[1], 1e-6)) return true;
  }

  // even-odd ray casting
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0];
    const zi = poly[i]![1];
    const xj = poly[j]![0];
    const zj = poly[j]![1];
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 0.0) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function rectInsidePoly(r: Rect, poly: PolyPoints): boolean {
  return (
    pointInPolyOrOnBoundary(r.x0, r.z0, poly) &&
    pointInPolyOrOnBoundary(r.x0, r.z1, poly) &&
    pointInPolyOrOnBoundary(r.x1, r.z0, poly) &&
    pointInPolyOrOnBoundary(r.x1, r.z1, poly)
  );
}

type HouseShape =
  | { kind: "rect"; x0: number; x1: number; z0: number; z1: number; zWideMin: number }
  | { kind: "rearMod"; x0: number; x1: number; z0: number; z1: number; zWideMin: number };

function inferWideBandShape(hn: number, poly: PolyPoints): HouseShape {
  let xMin = Infinity,
    xMax = -Infinity,
    zMin = Infinity,
    zMax = -Infinity;

  for (const [x, z] of poly) {
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
  }

  xMin = q(xMin, 3);
  xMax = q(xMax, 3);
  zMin = q(zMin, 3);
  zMax = q(zMax, 3);

  const zVals = uniqSorted(poly.map((p) => q(p[1], 3)));

  // plot.ts guarantees: houseregion is either a rectangle OR rectangle + one rear extension/notch -> 2 or 3 unique z's.
  if (zVals.length === 2) {
    return { kind: "rect", x0: xMin, x1: xMax, z0: zMin, z1: zMax, zWideMin: zMin };
  }
  if (zVals.length === 3) {
    // The "wide band" starts at the middle z where the footprint is full width.
    return { kind: "rearMod", x0: xMin, x1: xMax, z0: zMin, z1: zMax, zWideMin: zVals[1]! };
  }

  throw new Error(`secondFloor: House ${hn} unexpected houseregion z-profile (unique z count=${zVals.length})`);
}

type SegType = "bedroom" | "bathroom_small" | "bathroom_large" | "laundry" | "office";

type RoomMin = { area: number; minDim: number };
const MINS: Record<SegType | "hallway" | "closet", RoomMin> = {
  hallway: { area: 5.0, minDim: 1.0 },

  bedroom: { area: 10.0, minDim: 2.6 },
  bathroom_small: { area: 3.2, minDim: 1.6 },
  bathroom_large: { area: 5.0, minDim: 2.0 },

  closet: { area: 2.0, minDim: 1.0 },
  laundry: { area: 4.0, minDim: 1.6 },
  office: { area: 7.0, minDim: 2.2 },
};

function minDepthFor(type: keyof typeof MINS, width: number): number {
  const min = MINS[type];
  // Ensure both minDim and area, with a small buffer so rounding doesn't undercut constraints.
  const byArea = ceilQ((min.area + 0.2) / Math.max(0.001, width), 3);
  return q(Math.max(min.minDim + 0.05, byArea), 3);
}

function ensureMinRect(hn: number, label: string, r: Rect, min: RoomMin) {
  const a = rectArea(r);
  const md = rectMinDim(r);
  if (a + EPS < min.area || md + EPS < min.minDim) {
    throw new Error(
      `secondFloor: House ${hn} ${label} too small (area=${q(a, 3)} min=${min.area}, minDim=${q(md, 3)} min=${min.minDim})`
    );
  }
}

function overlap1D(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function generateAttempt(
  house: HouseConfig,
  ctx: HouseGenContext,
  plot: FloorModel,
  firstFloor: FloorModel,
  attempt: number
): FloorModel {
  const hn = house.houseNumber;
  const rng = makeRng(`${ctx.seed}/secondFloor/${attempt}`);

  const hr = getRegionByName(plot, "houseregion");
  if (!hr || hr.type !== "polygon") throw new Error(`secondFloor: House ${hn} plot missing houseregion polygon`);

  const shape = inferWideBandShape(hn, hr.points);

  // Second floor uses only the wide band (full-width rectangle in front of rear modification).
  const usable = rectNorm(
    shape.x0 + OUTER_MARGIN_X,
    shape.zWideMin + OUTER_MARGIN_Z,
    shape.x1 - OUTER_MARGIN_X,
    shape.z1 - OUTER_MARGIN_Z
  );

  if (rectW(usable) + EPS < 6.5 || rectD(usable) + EPS < 8.5) {
    throw new Error(`secondFloor: House ${hn} insufficient upstairs usable area (w=${q(rectW(usable), 3)}, d=${q(rectD(usable), 3)})`);
  }

  const stairs = getRegionByName(firstFloor, "stairs");
  if (!stairs || stairs.type !== "rectangle") throw new Error(`secondFloor: House ${hn} firstFloor missing stairs rectangle`);
  const stairsR = rectFromRegion(stairs);

  const hall1 = getRegionByName(firstFloor, "hallway");
  const hall1R = hall1 && hall1.type === "rectangle" ? rectFromRegion(hall1) : null;

  // Determine which side the first-floor hallway touches the stairs on (for realism).
  const stairsLeftOfHall = hall1R ? Math.abs(hall1R.x0 - stairsR.x1) <= 2e-2 : stairsR.x1 <= (usable.x0 + usable.x1) * 0.5;
  const stairsRightOfHall = hall1R ? Math.abs(hall1R.x1 - stairsR.x0) <= 2e-2 : stairsR.x0 >= (usable.x0 + usable.x1) * 0.5;

  // Create second-floor hallway rectangle adjacent to stairs in X, spanning most of usable depth.
  const hallWBase = hall1R ? clamp(rectW(hall1R), 1.0, 1.8) : clamp(rng.float(1.1, 1.6), 1.0, 1.8);

  let hall: Rect | null = null;

  const tryHall = (side: "rightOfStairs" | "leftOfStairs"): Rect | null => {
    const w = q(hallWBase, 3);
    if (side === "rightOfStairs") {
      const x0 = q(stairsR.x1, 3);
      const x1 = q(x0 + w, 3);
      const r = rectNorm(x0, usable.z0, x1, usable.z1);
      if (r.x1 <= usable.x1 + EPS && r.x0 >= usable.x0 - EPS) return r;
      return null;
    } else {
      const x1 = q(stairsR.x0, 3);
      const x0 = q(x1 - w, 3);
      const r = rectNorm(x0, usable.z0, x1, usable.z1);
      if (r.x0 >= usable.x0 - EPS && r.x1 <= usable.x1 + EPS) return r;
      return null;
    }
  };

  if (stairsLeftOfHall) hall = tryHall("rightOfStairs");
  if (!hall && stairsRightOfHall) hall = tryHall("leftOfStairs");

  // Fallback: choose whichever side fits and has room.
  if (!hall) {
    const right = tryHall("rightOfStairs");
    const left = tryHall("leftOfStairs");
    if (right && left) {
      // Prefer the one with larger remaining room-zone width.
      const roomWRight = usable.x1 - right.x1;
      const roomWLeft = left.x0 - usable.x0;
      hall = roomWRight >= roomWLeft ? right : left;
    } else {
      hall = right ?? left;
    }
  }

  if (!hall) throw new Error(`secondFloor: House ${hn} cannot place hallway adjacent to stairs within usable band`);

  // Hallway must be inside houseregion polygon.
  if (!rectInsidePoly(hall, hr.points)) {
    throw new Error(`secondFloor: House ${hn} hallway not inside houseregion`);
  }

  // Hallway must touch stairs projection (share an edge segment).
  const touchesByRightEdge = Math.abs(hall.x0 - stairsR.x1) <= 1e-3;
  const touchesByLeftEdge = Math.abs(hall.x1 - stairsR.x0) <= 1e-3;
  const touchZ = overlap1D(hall.z0, hall.z1, stairsR.z0, stairsR.z1);

  if (!(touchesByRightEdge || touchesByLeftEdge) || touchZ + EPS < 0.6) {
    throw new Error(
      `secondFloor: House ${hn} hallway must touch stairs projection (touchZ=${q(touchZ, 3)}m)`
    );
  }

  // Hallway mins
  ensureMinRect(hn, "hallway", hall, MINS.hallway);

  // Choose room-side zone(s). Prefer the side *opposite* the stairs if it is wide enough.
  const leftZone = rectNorm(usable.x0, usable.z0, hall.x0, usable.z1);
  const rightZone = rectNorm(hall.x1, usable.z0, usable.x1, usable.z1);

  const stairsOnLeft = touchesByRightEdge; // hall.x0 == stairs.x1 => stairs is left of hall
  const stairsOnRight = touchesByLeftEdge; // hall.x1 == stairs.x0 => stairs is right of hall

  const canUseLeft = rectW(leftZone) + EPS >= 2.6;
  const canUseRight = rectW(rightZone) + EPS >= 2.6;

  let roomZone: Rect | null = null;
  let roomSide: "left" | "right" = "right";

  const preferOpposite = (stairsOnLeft && canUseRight) || (stairsOnRight && canUseLeft);

  if (preferOpposite) {
    if (stairsOnLeft) {
      roomZone = rightZone;
      roomSide = "right";
    } else {
      roomZone = leftZone;
      roomSide = "left";
    }
  } else if (canUseLeft && canUseRight) {
    // Prefer wider zone.
    const wL = rectW(leftZone);
    const wR = rectW(rightZone);
    roomZone = wR >= wL ? rightZone : leftZone;
    roomSide = wR >= wL ? "right" : "left";
  } else if (canUseRight) {
    roomZone = rightZone;
    roomSide = "right";
  } else if (canUseLeft) {
    roomZone = leftZone;
    roomSide = "left";
  }

  if (!roomZone) throw new Error(`secondFloor: House ${hn} cannot fit any room zone with width >= 2.6m`);

  // Bedroom count guidance
  const occ = house.occupants.length;
  const bedMin = Math.ceil(occ / 2);
  const bedMax = Math.min(4, bedMin + 1);
  let nBedrooms = rng.int(bedMin, bedMax);

  // Optional extras (only if depth allows)
  let includeLaundry = rng.bool(occ >= 3 ? 0.45 : 0.2);
  let includeOffice = rng.bool(occ <= 2 ? 0.25 : 0.12);

  const woodA = pickWood(rng);
  const woodB = pickWood(rng);
  const tileA = pickTile(rng);
  const tileB = pickTile(rng);

  const roomW = rectW(roomZone);
  const totalDepth = rectD(roomZone);

  const buildSegPlan = (beds: number, laundry: boolean, office: boolean): SegType[] => {
    // Produce Z-slice plan from rear (low z) to front (high z).
    // Keep bathroom_large closer to the front by placing it late in the sequence.
    const segs: SegType[] = [];

    if (beds <= 1) {
      // Single-bedroom layouts: baths + bedroom near front.
      segs.push("bathroom_small");
      if (laundry) segs.push("laundry");
      if (office) segs.push("office");
      segs.push("bathroom_large");
      segs.push("bedroom");
      return segs;
    }

    // Reserve a front bedroom
    let rem = beds - 1;

    // Rear cluster: at least one bedroom.
    segs.push("bedroom");
    rem--;

    // Optional extra rear bedroom if we have many bedrooms.
    if (rem >= 2 && rng.bool(0.55)) {
      segs.push("bedroom");
      rem--;
    }

    // Landing-adjacent bath
    segs.push("bathroom_small");
    if (laundry) segs.push("laundry");
    if (office) segs.push("office");

    // Remaining bedrooms before the large bath/front suite
    while (rem > 0) {
      segs.push("bedroom");
      rem--;
    }

    segs.push("bathroom_large");
    segs.push("bedroom"); // front reserved
    return segs;
  };

  const tryPlanFit = (beds: number, laundry: boolean, office: boolean): { plan: SegType[]; depths: number[] } | null => {
    const plan = buildSegPlan(beds, laundry, office);
    const mins = plan.map((t) => minDepthFor(t, roomW));
    const sumMin = mins.reduce((a, b) => a + b, 0);

    if (sumMin + EPS > totalDepth) return null;

    // Distribute slack primarily into bedrooms for realism.
    let slack = totalDepth - sumMin;

    const depths = mins.slice();

    const bedroomIdx = plan.map((t, i) => (t === "bedroom" ? i : -1)).filter((i) => i >= 0);
    const otherIdx = plan.map((t, i) => (t !== "bedroom" ? i : -1)).filter((i) => i >= 0);

    // Give bathrooms a little slack sometimes (not always boxy).
    for (const i of otherIdx) {
      if (slack <= 1e-6) break;
      const t = plan[i]!;
      const p = t === "bathroom_small" || t === "bathroom_large" ? 0.35 : 0.2;
      if (!rng.bool(p)) continue;
      const add = Math.min(slack, rng.float(0.0, 0.6));
      depths[i]! = q(depths[i]! + add, 3);
      slack = q(slack - add, 3);
    }

    // Distribute remaining slack among bedrooms.
    for (let k = 0; k < bedroomIdx.length; k++) {
      if (slack <= 1e-6) break;
      const i = bedroomIdx[k]!;
      const remaining = bedroomIdx.length - k;
      const maxAdd = Math.min(2.0, slack); // don't over-bloat
      const add = remaining > 1 ? rng.float(0, maxAdd * 0.7) : maxAdd;
      depths[i]! = q(depths[i]! + add, 3);
      slack = q(slack - add, 3);
    }

    // Put any leftover slack into the last segment so total matches exactly.
    if (slack > 1e-6) {
      depths[depths.length - 1]! = q(depths[depths.length - 1]! + slack, 3);
    }

    // Final sanity: all depths must stay >= their minima after rounding.
    for (let i = 0; i < depths.length; i++) {
      if (depths[i]! + EPS < mins[i]!) return null;
    }

    return { plan, depths };
  };

  // Fit planner with deterministic degradation if needed.
  let fit = tryPlanFit(nBedrooms, includeLaundry, includeOffice);
  if (!fit && includeLaundry) {
    includeLaundry = false;
    fit = tryPlanFit(nBedrooms, includeLaundry, includeOffice);
  }
  if (!fit && includeOffice) {
    includeOffice = false;
    fit = tryPlanFit(nBedrooms, includeLaundry, includeOffice);
  }
  while (!fit && nBedrooms > bedMin) {
    nBedrooms--;
    fit = tryPlanFit(nBedrooms, includeLaundry, includeOffice);
  }
  if (!fit) {
    throw new Error(
      `secondFloor: House ${hn} cannot fit required rooms in available depth (depth=${q(totalDepth, 3)}m, roomW=${q(roomW, 3)}m)`
    );
  }

  const { plan, depths } = fit;

  // Build regions: hallway + room slices (+ optional closets).
  const regions: Region[] = [];
  regions.push(rectToRegion("hallway", woodA, hall));

  let zCur = roomZone.z0;

  const hallwayEdgeX = roomSide === "right" ? hall.x1 : hall.x0; // rooms start at this edge

  for (let i = 0; i < plan.length; i++) {
    const t = plan[i]!;
    const d = depths[i]!;
    const z0 = q(zCur, 3);
    const z1 = q(zCur + d, 3);
    zCur = z1;

    // Base room spans from hallway edge to outer boundary.
    let base: Rect;
    if (roomSide === "right") {
      // roomZone.x0 is hall.x1 by construction
      base = rectNorm(roomZone.x0, z0, roomZone.x1, z1);
    } else {
      // roomZone.x1 is hall.x0 by construction
      base = rectNorm(roomZone.x0, z0, roomZone.x1, z1);
    }

    // Validate inside houseregion polygon (hard).
    if (!rectInsidePoly(base, hr.points)) {
      throw new Error(`secondFloor: House ${hn} room '${t}' not inside houseregion`);
    }

    // Validate that this slice touches hallway with >= 0.6m segment (hard for bedrooms/bathrooms).
    const touchesHall =
      roomSide === "right"
        ? Math.abs(base.x0 - hallwayEdgeX) <= 1e-3
        : Math.abs(base.x1 - hallwayEdgeX) <= 1e-3;

    const touchLen = overlap1D(base.z0, base.z1, hall.z0, hall.z1);
    if ((t === "bedroom" || t === "bathroom_small" || t === "bathroom_large") && (!touchesHall || touchLen + EPS < 0.6)) {
      throw new Error(`secondFloor: House ${hn} ${t} must touch hallway (touchLen=${q(touchLen, 3)}m)`);
    }

    // Assign surface
    const surface: Surface =
      t === "bedroom" ? woodB : t === "bathroom_small" || t === "bathroom_large" ? tileA : t === "laundry" ? tileB : woodB;

    // Optionally carve a closet from the *outer* edge of some bedrooms.
    if (t === "bedroom") {
      const allowCloset = rng.bool(0.35) && rectW(base) >= 3.9 && rectD(base) >= 2.6;

      if (allowCloset) {
        const closetW = q(clamp(rng.float(1.0, 1.6), 1.0, Math.min(1.8, rectW(base) - 2.6)), 3);

        // Closet must be on the outer edge so the bedroom still touches hallway.
        let closet: Rect;
        let bed: Rect;

        if (roomSide === "right") {
          // hallway is at x0; outer edge is at x1
          closet = rectNorm(base.x1 - closetW, base.z0, base.x1, base.z1);
          bed = rectNorm(base.x0, base.z0, base.x1 - closetW, base.z1);
        } else {
          // hallway is at x1; outer edge is at x0
          closet = rectNorm(base.x0, base.z0, base.x0 + closetW, base.z1);
          bed = rectNorm(base.x0 + closetW, base.z0, base.x1, base.z1);
        }

        // Validate mins after carving.
        ensureMinRect(hn, "bedroom", bed, MINS.bedroom);
        ensureMinRect(hn, "closet", closet, MINS.closet);

        regions.push(rectToRegion("bedroom", woodB, bed));
        regions.push(rectToRegion("closet", woodA, closet));
        continue;
      }

      // No closet
      ensureMinRect(hn, "bedroom", base, MINS.bedroom);
      regions.push(rectToRegion("bedroom", woodB, base));
      continue;
    }

    // Bathrooms / laundry / office
    ensureMinRect(hn, t, base, MINS[t]);
    regions.push(rectToRegion(t, surface, base));
  }

  // Final required-set checks (hard)
  const hasHall = regions.some((r) => r.name === "hallway");
  const hasBed = regions.some((r) => r.name === "bedroom");
  const hasBL = regions.some((r) => r.name === "bathroom_large");
  const hasBS = regions.some((r) => r.name === "bathroom_small");

  if (!hasHall || !hasBed || !hasBL || !hasBS) {
    throw new Error(`secondFloor: House ${hn} missing required regions after generation`);
  }

  // Ensure all rectangles are within lot-local bounds and within houseregion.
  for (const r of regions) {
    if (r.type !== "rectangle") continue;
    const bb = rectFromRegion(r);

    if (bb.x0 < -EPS || bb.x1 > ctx.xsize + EPS || bb.z0 < -EPS || bb.z1 > 30 + EPS) {
      throw new Error(`secondFloor: House ${hn} region '${r.name}' out of lot bounds`);
    }
    if (!rectInsidePoly(bb, hr.points)) {
      throw new Error(`secondFloor: House ${hn} region '${r.name}' not inside houseregion`);
    }
    // Global mins from requirements (all layers)
    const a = rectArea(bb);
    const md = rectMinDim(bb);
    if (a + EPS < 2.0) throw new Error(`secondFloor: House ${hn} region '${r.name}' violates global min area (area=${q(a, 3)})`);
    if (md + EPS < 1.0) throw new Error(`secondFloor: House ${hn} region '${r.name}' violates global min dimension (minDim=${q(md, 3)})`);
  }

  return { regions, construction: [], objects: [] };
}

// -------------------- Public API --------------------

export function generateSecondFloorModel(
  house: HouseConfig,
  ctx: HouseGenContext,
  plot: FloorModel,
  firstFloor: FloorModel
): FloorModel {
  const hn = house.houseNumber;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return generateAttempt(house, ctx, plot, firstFloor, attempt);
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr instanceof Error) throw lastErr;

  throw new Error(`secondFloor: House ${hn} failed to generate a valid model after ${MAX_ATTEMPTS} attempts`);
}
