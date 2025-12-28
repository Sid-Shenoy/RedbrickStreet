// web/src/world/houseModel/generation/secondFloor.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, PolyPoints, Region, Surface } from "../types";
import type { HouseGenContext } from "./context";
import { makeRng } from "../../../utils/seededRng";

const EPS = 1e-6;
const MAX_ATTEMPTS = 10;

type Rect = { x0: number; x1: number; z0: number; z1: number };
type Side = "left" | "right";

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
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

function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0);
  const x1 = Math.min(a.x1, b.x1);
  const z0 = Math.max(a.z0, b.z0);
  const z1 = Math.min(a.z1, b.z1);
  if (x1 - x0 <= EPS || z1 - z0 <= EPS) return null;
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

function polyBounds(points: PolyPoints): Rect {
  let minx = Infinity,
    maxx = -Infinity,
    minz = Infinity,
    maxz = -Infinity;
  for (const [x, z] of points) {
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    minz = Math.min(minz, z);
    maxz = Math.max(maxz, z);
  }
  if (!isFinite(minx)) return rectNorm(0, 0, 0, 0);
  return rectNorm(minx, minz, maxx, maxz);
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

type RoomMin = { area: number; minDim: number };

const REQUIRED_MINS: Record<string, RoomMin> = {
  bedroom: { area: 10.0, minDim: 2.6 },
  hallway: { area: 5.0, minDim: 1.0 },
  bathroom_small: { area: 3.2, minDim: 1.6 },
  bathroom_large: { area: 5.0, minDim: 2.0 },
};

const EXTRA_MINS: Record<string, RoomMin> = {
  closet: { area: 2.0, minDim: 1.0 },
  laundry: { area: 4.0, minDim: 1.6 },
  office: { area: 7.0, minDim: 2.2 },
  storage: { area: 3.0, minDim: 1.2 },
};

function minDepthForRoom(room: keyof typeof REQUIRED_MINS | keyof typeof EXTRA_MINS, width: number): number {
  const min = (REQUIRED_MINS as Record<string, RoomMin>)[room] ?? (EXTRA_MINS as Record<string, RoomMin>)[room];
  const byArea = (min.area + 0.25) / Math.max(0.001, width);
  return Math.max(min.minDim + 0.05, byArea);
}

function checkRectMin(hn: number, name: string, r: Rect) {
  const min = (REQUIRED_MINS as Record<string, RoomMin>)[name] ?? (EXTRA_MINS as Record<string, RoomMin>)[name];
  if (!min) return;

  const a = rectArea(r);
  const md = rectMinDim(r);
  if (a + EPS < min.area || md + EPS < min.minDim) {
    throw new Error(
      `secondFloor: House ${hn} ${name} too small (area=${q(a, 3)} min=${min.area}, minDim=${q(md, 3)} min=${min.minDim})`
    );
  }
}

function pickWood(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["wood_light", "wood_medium", "wood_dark"] as const);
}
function pickTile(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["tile_light", "tile_medium", "tile_dark"] as const);
}

function surfaceForRoom(name: string, woodA: Surface, woodB: Surface, tileA: Surface, tileB: Surface): Surface {
  if (name === "hallway") return woodA;
  if (name === "bedroom") return woodB;
  if (name === "bathroom_small" || name === "bathroom_large") return tileA;
  if (name === "closet") return woodA;
  if (name === "laundry") return tileB;
  if (name === "office") return woodB;
  if (name === "storage") return "concrete_medium";
  return woodA;
}

// plot.ts guarantee: houseregion is rect OR rect with one rear modification (extension OR notch).
type HouseShape =
  | { kind: "rect"; x0: number; x1: number; z0: number; z1: number; zWideMin: number }
  | { kind: "extension"; x0: number; x1: number; z0: number; z1: number; zWideMin: number; extX0: number; extX1: number }
  | { kind: "notch"; x0: number; x1: number; z0: number; z1: number; zWideMin: number; notchX0: number; notchX1: number };

function inferHouseShape(hn: number, poly: PolyPoints): HouseShape {
  const bb = polyBounds(poly);
  const xMin = bb.x0;
  const xMax = bb.x1;
  const zMin = bb.z0;
  const zMax = bb.z1;

  const zVals = uniqSorted(poly.map((p) => q(p[1], 3)));

  if (zVals.length === 2) {
    return { kind: "rect", x0: xMin, x1: xMax, z0: zMin, z1: zMax, zWideMin: zMin };
  }
  if (zVals.length !== 3) {
    throw new Error(`secondFloor: House ${hn} unexpected houseregion z-profile (unique z count=${zVals.length})`);
  }

  const zLow = zVals[0]!;
  const zMid = zVals[1]!;
  const xsAtLow = uniqSorted(poly.filter((p) => Math.abs(p[1] - zLow) <= 1e-3).map((p) => q(p[0], 3)));

  const hasXMin = xsAtLow.some((x) => Math.abs(x - xMin) <= 1e-3);
  const hasXMax = xsAtLow.some((x) => Math.abs(x - xMax) <= 1e-3);

  if (hasXMin && hasXMax) {
    // Notch: rear edge spans full width, with an indentation (missing center) up to zMid.
    if (xsAtLow.length < 4) {
      throw new Error(`secondFloor: House ${hn} notch inference failed (xsAtLow.length=${xsAtLow.length})`);
    }
    const notchX0 = xsAtLow[1]!;
    const notchX1 = xsAtLow[xsAtLow.length - 2]!;
    return {
      kind: "notch",
      x0: xMin,
      x1: xMax,
      z0: zLow,
      z1: zMax,
      zWideMin: zMid,
      notchX0: q(notchX0, 3),
      notchX1: q(notchX1, 3),
    };
  }

  // Extension: rear edge is narrower, with a bump-out reaching zLow.
  if (xsAtLow.length < 2) {
    throw new Error(`secondFloor: House ${hn} extension inference failed (xsAtLow.length=${xsAtLow.length})`);
  }
  const extX0 = xsAtLow[0]!;
  const extX1 = xsAtLow[xsAtLow.length - 1]!;
  return {
    kind: "extension",
    x0: xMin,
    x1: xMax,
    z0: zLow,
    z1: zMax,
    zWideMin: zMid,
    extX0: q(extX0, 3),
    extX1: q(extX1, 3),
  };
}

function sharedEdgeLen(a: Rect, b: Rect): number {
  // Returns length of shared boundary segment if rectangles touch; else 0.
  // Touch along vertical edge
  if (Math.abs(a.x1 - b.x0) <= 1e-6 || Math.abs(b.x1 - a.x0) <= 1e-6) {
    const z0 = Math.max(a.z0, b.z0);
    const z1 = Math.min(a.z1, b.z1);
    return Math.max(0, z1 - z0);
  }
  // Touch along horizontal edge
  if (Math.abs(a.z1 - b.z0) <= 1e-6 || Math.abs(b.z1 - a.z0) <= 1e-6) {
    const x0 = Math.max(a.x0, b.x0);
    const x1 = Math.min(a.x1, b.x1);
    return Math.max(0, x1 - x0);
  }
  return 0;
}

function packStripOrThrow(
  hn: number,
  housePoly: PolyPoints,
  rng: ReturnType<typeof makeRng>,
  strip: Rect,
  roomNamesFrontToBack: string[],
  surfaces: { woodA: Surface; woodB: Surface; tileA: Surface; tileB: Surface }
): Region[] {
  const w = rectW(strip);
  const z0 = strip.z0;
  const z1 = strip.z1;
  const depth = z1 - z0;

  if (w + EPS < 1.0 || depth + EPS < 2.0) return [];

  const mins = roomNamesFrontToBack.map((nm) => {
    const key = nm as keyof typeof REQUIRED_MINS | keyof typeof EXTRA_MINS;
    return q(minDepthForRoom(key, w), 3);
  });

  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum + EPS > depth) {
    throw new Error(`secondFloor: House ${hn} strip packing failed (minSum=${q(minSum, 3)} > depth=${q(depth, 3)})`);
  }

  let slack = depth - minSum;

  // Distribute slack across all but last room.
  const depths: number[] = [];
  for (let i = 0; i < roomNamesFrontToBack.length; i++) {
    const minD = mins[i]!;
    if (i === roomNamesFrontToBack.length - 1) {
      depths.push(q(minD + slack, 3));
      slack = 0;
    } else {
      const give = q(rng.float(0, slack * 0.6), 3);
      depths.push(q(minD + give, 3));
      slack = q(slack - give, 3);
    }
  }

  // Build rectangles from front (high z) to back (low z).
  const out: Region[] = [];
  let zTop = z1;

  for (let i = 0; i < roomNamesFrontToBack.length; i++) {
    const nm = roomNamesFrontToBack[i]!;
    const d = depths[i]!;
    const zBot = q(zTop - d, 3);

    const r = rectNorm(strip.x0, zBot, strip.x1, zTop);

    // Inside houseregion
    if (!rectInsidePoly(r, housePoly)) throw new Error(`secondFloor: House ${hn} room '${nm}' not inside houseregion`);

    // Global mins (requirements 3.5.4)
    if (rectArea(r) + EPS < 2.0) throw new Error(`secondFloor: House ${hn} room '${nm}' violates global min area`);
    if (rectMinDim(r) + EPS < 1.0) throw new Error(`secondFloor: House ${hn} room '${nm}' violates global min dimension`);

    // Room mins
    checkRectMin(hn, nm, r);

    out.push(
      rectToRegion(nm, surfaceForRoom(nm, surfaces.woodA, surfaces.woodB, surfaces.tileA, surfaces.tileB), r)
    );

    zTop = zBot;
  }

  // Tight rounding: ensure final zTop ~= z0
  if (Math.abs(zTop - z0) > 0.02) {
    // Small drift is acceptable for a "zones" model, but keep it tight.
    throw new Error(`secondFloor: House ${hn} strip rounding drift too large (drift=${q(Math.abs(zTop - z0), 3)})`);
  }

  return out;
}

/**
 * Packs a strip while reserving a "stairs opening" rectangle as SURFACE=void (not rendered),
 * by splitting the strip into:
 *  - front segment (z in [opening.z1 .. strip.z1])
 *  - back segment  (z in [strip.z0 .. opening.z0])
 * and NOT placing any packed rooms across the opening's z-band.
 *
 * This guarantees that no non-void region overlaps the opening rectangle.
 */
function packStripWithStairsOpeningOrThrow(
  hn: number,
  housePoly: PolyPoints,
  rng: ReturnType<typeof makeRng>,
  strip: Rect,
  openingIn: Rect,
  plan: string[],
  surfaces: { woodA: Surface; woodB: Surface; tileA: Surface; tileB: Surface }
): Region[] {
  const opening = rectIntersect(strip, openingIn);
  if (!opening) {
    return packStripOrThrow(hn, housePoly, rng, strip, plan, surfaces);
  }

  // Opening must touch one vertical edge of the strip (this is the normal case: opening is adjacent to the hallway edge).
  const touchesLeft = Math.abs(opening.x0 - strip.x0) <= 1e-3;
  const touchesRight = Math.abs(opening.x1 - strip.x1) <= 1e-3;
  if (!touchesLeft && !touchesRight) {
    // If not edge-adjacent, fall back to normal packing (we avoid generating overlaps we can't guarantee away).
    return packStripOrThrow(hn, housePoly, rng, strip, plan, surfaces);
  }

  const frontDepth = strip.z1 - opening.z1;
  const backDepth = opening.z0 - strip.z0;

  const hasFront = frontDepth > 0.05;
  const hasBack = backDepth > 0.05;

  const w = rectW(strip);

  // Compute min depth requirements for each planned room.
  const mins = plan.map((nm) => {
    const key = nm as keyof typeof REQUIRED_MINS | keyof typeof EXTRA_MINS;
    return q(minDepthForRoom(key, w), 3);
  });

  const prefix: number[] = [0];
  for (let i = 0; i < mins.length; i++) prefix.push(q(prefix[i]! + mins[i]!, 3));

  const suffix: number[] = Array.from({ length: mins.length + 1 }, () => 0);
  for (let i = mins.length - 1; i >= 0; i--) suffix[i] = q(suffix[i + 1]! + mins[i]!, 3);

  // Feasible split index k where:
  //   plan[0..k) fits in front segment, plan[k..] fits in back segment.
  const feasible: number[] = [];
  for (let k = 0; k <= plan.length; k++) {
    const okFront = !hasFront ? k === 0 : prefix[k]! <= frontDepth + 1e-3;
    const okBack = !hasBack ? k === plan.length : suffix[k]! <= backDepth + 1e-3;
    if (okFront && okBack) feasible.push(k);
  }

  if (feasible.length === 0) {
    throw new Error(
      `secondFloor: House ${hn} cannot split strip plan around stairs opening (frontDepth=${q(frontDepth, 3)}, backDepth=${q(
        backDepth,
        3
      )})`
    );
  }

  // Prefer a split where both sides have at least one room when possible (avoids huge open segments).
  const feasibleBoth = feasible.filter((k) => k > 0 && k < plan.length && hasFront && hasBack);
  const k = (feasibleBoth.length ? rng.pick(feasibleBoth) : rng.pick(feasible)) as number;

  const planFront = plan.slice(0, k);
  const planBack = plan.slice(k);

  const out: Region[] = [];

  // Front segment rooms
  if (hasFront && planFront.length > 0) {
    const frontStrip = rectNorm(strip.x0, opening.z1, strip.x1, strip.z1);
    out.push(...packStripOrThrow(hn, housePoly, rng, frontStrip, planFront, surfaces));
  }

  // Back segment rooms
  if (hasBack && planBack.length > 0) {
    const backStrip = rectNorm(strip.x0, strip.z0, strip.x1, opening.z0);
    out.push(...packStripOrThrow(hn, housePoly, rng, backStrip, planBack, surfaces));
  }

  // Fill the non-opening portion of the opening z-band with a "storage" region when feasible.
  // This preserves floor area beside the opening without requiring hallway adjacency.
  const midDepth = opening.z1 - opening.z0;
  if (midDepth > 0.05) {
    let mid: Rect | null = null;

    if (touchesRight) {
      // opening is on the right edge; fill left remainder
      if (opening.x0 - strip.x0 > 0.05) {
        mid = rectNorm(strip.x0, opening.z0, opening.x0, opening.z1);
      }
    } else if (touchesLeft) {
      // opening is on the left edge; fill right remainder
      if (strip.x1 - opening.x1 > 0.05) {
        mid = rectNorm(opening.x1, opening.z0, strip.x1, opening.z1);
      }
    }

    if (mid) {
      // Keep this extra region only if it satisfies "storage" minimums (so it stays realistic).
      const a = rectArea(mid);
      const md = rectMinDim(mid);
      if (
        a + EPS >= EXTRA_MINS.storage.area &&
        md + EPS >= EXTRA_MINS.storage.minDim &&
        rectInsidePoly(mid, housePoly)
      ) {
        out.push(rectToRegion("storage", surfaceForRoom("storage", surfaces.woodA, surfaces.woodB, surfaces.tileA, surfaces.tileB), mid));
      }
    }
  }

  return out;
}

function validateSecondFloorOrThrow(hn: number, housePoly: PolyPoints, stairs: Rect, hallway: Rect, regions: Region[]) {
  // Hallway mins
  checkRectMin(hn, "hallway", hallway);

  // Hallway must touch stairs projection along an edge segment >= 1.0m
  const touchLen = sharedEdgeLen(hallway, stairs);
  if (touchLen + EPS < 1.0) {
    throw new Error(`secondFloor: House ${hn} hallway must touch stairs projection (>=1.0m), got ${q(touchLen, 3)}m`);
  }

  // Required regions
  const has = (nm: string) => regions.some((r) => r.name === nm && r.surface !== "void");
  if (!has("hallway")) throw new Error(`secondFloor: House ${hn} missing required region 'hallway'`);
  if (!has("bathroom_large")) throw new Error(`secondFloor: House ${hn} missing required region 'bathroom_large'`);
  if (!has("bathroom_small")) throw new Error(`secondFloor: House ${hn} missing required region 'bathroom_small'`);
  if (!has("bedroom")) throw new Error(`secondFloor: House ${hn} missing required region 'bedroom'`);

  // All rectangles must be inside houseregion (6.5.1)
  for (const r of regions) {
    if (r.type !== "rectangle") continue;
    const rr = rectFromRegion(r);
    if (!rectInsidePoly(rr, housePoly)) throw new Error(`secondFloor: House ${hn} region '${r.name}' not inside houseregion`);
  }

  // Connectivity constraints (6.5.3): every bedroom & bathroom touches hallway (>=1.0m edge).
  // NOTE: We intentionally check against the "main" hallway rectangle placed adjacent to stairs; this keeps validation simple and robust.
  const hallRect = hallway;

  for (const r of regions) {
    if (r.type !== "rectangle") continue;
    if (r.surface === "void") continue;
    if (r.name !== "bedroom" && r.name !== "bathroom_small" && r.name !== "bathroom_large") continue;
    const rr = rectFromRegion(r);
    const len = sharedEdgeLen(rr, hallRect);
    if (len + EPS < 1.0) {
      throw new Error(`secondFloor: House ${hn} '${r.name}' must touch hallway (>=1.0m), got ${q(len, 3)}m`);
    }
  }

  // Closets: we generate 1..2 and they touch hallway by construction (strip adjacency).
}

function generateAttempt(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel, firstFloor: FloorModel, attempt: number): FloorModel {
  const hn = house.houseNumber;
  const rng = makeRng(`${ctx.seed}/secondFloor/${attempt}`);

  const hr = getRegionByName(plot, "houseregion");
  if (!hr || hr.type !== "polygon") throw new Error(`secondFloor: House ${hn} plot missing houseregion polygon`);

  const stairsR = getRegionByName(firstFloor, "stairs");
  if (!stairsR || stairsR.type !== "rectangle") throw new Error(`secondFloor: House ${hn} firstFloor missing stairs rectangle`);

  const stairs = rectFromRegion(stairsR);

  // Shape inference for wide band (matches plot.ts guarantees)
  const shape = inferHouseShape(hn, hr.points);
  const bb = polyBounds(hr.points);

  // Inset for walls; keep modest so we still use space.
  const inset = q(clamp(rng.float(0.25, 0.45), 0.22, 0.55), 3);

  const usableWide = rectNorm(
    bb.x0 + inset,
    shape.zWideMin + inset,
    bb.x1 - inset,
    bb.z1 - inset
  );

  if (rectW(usableWide) + EPS < 7.0 || rectD(usableWide) + EPS < 8.0) {
    throw new Error(`secondFloor: House ${hn} insufficient usableWide footprint`);
  }

  // -------- Hallway placement: adjacent to stairs (share a vertical edge) --------
  const houseCx = (bb.x0 + bb.x1) * 0.5;
  const stairsCx = (stairs.x0 + stairs.x1) * 0.5;

  const prefer: Side = stairsCx < houseCx ? "right" : "left";
  const availLeft = stairs.x0 - usableWide.x0;
  const availRight = usableWide.x1 - stairs.x1;

  const baseHallW = q(clamp(rng.float(1.35, 2.05), 1.0, 2.3), 3);

  let hall: Rect | null = null;

  const tryPlaceHall = (side: Side): Rect | null => {
    if (side === "right") {
      const w = Math.min(baseHallW, availRight);
      if (w + EPS < 1.0) return null;
      const r = rectNorm(stairs.x1, usableWide.z0, stairs.x1 + w, usableWide.z1);
      return rectInsidePoly(r, hr.points) ? r : null;
    } else {
      const w = Math.min(baseHallW, availLeft);
      if (w + EPS < 1.0) return null;
      const r = rectNorm(stairs.x0 - w, usableWide.z0, stairs.x0, usableWide.z1);
      return rectInsidePoly(r, hr.points) ? r : null;
    }
  };

  hall = tryPlaceHall(prefer) ?? tryPlaceHall(prefer === "left" ? "right" : "left");
  if (!hall) throw new Error(`secondFloor: House ${hn} could not place hallway adjacent to stairs`);

  // Ensure hallway actually touches stairs with enough overlap (>=1.0m) before proceeding.
  const hallTouchLen = sharedEdgeLen(hall, stairs);
  if (hallTouchLen + EPS < 1.0) {
    throw new Error(`secondFloor: House ${hn} hallway-stairs touch too short (len=${q(hallTouchLen, 3)}m)`);
  }

  const leftStrip = rectNorm(usableWide.x0, usableWide.z0, hall.x0, usableWide.z1);
  const rightStrip = rectNorm(hall.x1, usableWide.z0, usableWide.x1, usableWide.z1);

  const wLeft = rectW(leftStrip);
  const wRight = rectW(rightStrip);

  // Materials
  const woodA = pickWood(rng);
  const woodB = pickWood(rng);
  const tileA = pickTile(rng);
  const tileB = pickTile(rng);

  // Bedroom count guidance (6.3): recommended range; we try to hit it but will remain robust.
  const occ = house.occupants.length;
  const minBeds = Math.ceil(occ / 2);
  const maxBeds = Math.min(4, minBeds + 1);
  let targetBeds = rng.int(minBeds, maxBeds);

  const canBedLeft = wLeft + EPS >= REQUIRED_MINS.bedroom.minDim;
  const canBedRight = wRight + EPS >= REQUIRED_MINS.bedroom.minDim;

  if (!canBedLeft && !canBedRight) {
    throw new Error(`secondFloor: House ${hn} cannot place any bedrooms (strip widths too small)`);
  }

  // Decide bed distribution across strips (try to use both sides to reduce unused space).
  let bedsL = 0;
  let bedsR = 0;

  const wideSide: Side = wLeft >= wRight ? "left" : "right";
  const assignToWide = () => {
    if (wideSide === "left") bedsL++;
    else bedsR++;
  };
  const assignToNarrow = () => {
    if (wideSide === "left") bedsR++;
    else bedsL++;
  };

  if (canBedLeft && canBedRight) {
    if (targetBeds === 1) {
      assignToWide();
    } else if (targetBeds === 2) {
      bedsL = 1;
      bedsR = 1;
    } else if (targetBeds === 3) {
      assignToWide();
      assignToWide();
      assignToNarrow();
    } else {
      // 4
      bedsL = 2;
      bedsR = 2;
    }
  } else if (canBedLeft) {
    bedsL = targetBeds;
  } else {
    bedsR = targetBeds;
  }

  // Attempt-dependent extras: earlier attempts pack more rooms; later attempts simplify.
  const allowOffice = attempt < 5 ? rng.bool(0.55) : false;
  const allowLaundry = attempt < 7 ? rng.bool(0.45) : false;
  const allowStorage = attempt < 9;
  const allowSecondCloset = attempt < 7 ? rng.bool(0.55) : false;

  // Bathrooms: place large on the side with more beds (or wider), small on the other if feasible.
  const bedHeavy: Side = bedsL >= bedsR ? "left" : "right";
  const bathLargeSide: Side = (bedHeavy === "left" && wLeft + EPS >= 2.0) || wRight + EPS < 2.0 ? "left" : "right";
  const bathSmallSide: Side =
    bathLargeSide === "left"
      ? (wRight + EPS >= 1.6 ? "right" : "left")
      : (wLeft + EPS >= 1.6 ? "left" : "right");

  const regions: Region[] = [];

  // Hallway region (required)
  regions.push(rectToRegion("hallway", woodA, hall));

  // Compute stairs opening region (second floor): mark as void so it is not rendered.
  // IMPORTANT: We intersect with usableWide so it stays within the second-floor footprint we are generating.
  const stairsOpening = rectIntersect(stairs, usableWide);
  if (stairsOpening) {
    regions.push(rectToRegion("stairs_opening", "void", stairsOpening));
  }

  // Build per-strip room lists (front->back) and pack each strip.
  let closetsPlanned = 0;

  const buildStripPlan = (side: Side): string[] => {
    const w = side === "left" ? wLeft : wRight;
    const beds = side === "left" ? bedsL : bedsR;

    const plan: string[] = [];

    // Always try to keep a bedroom toward the front if we have any on this side.
    if (beds > 0) plan.push("bedroom");

    // Optional office near front if there's room and this side is wide.
    if (allowOffice && w + EPS >= EXTRA_MINS.office.minDim && rng.bool(0.6)) plan.push("office");

    // Bathrooms (mid-pack)
    if (side === bathLargeSide) plan.push("bathroom_large");
    if (side === bathSmallSide) plan.push("bathroom_small");

    // Guarantee 1 closet overall; aim for 1..2 closets total.
    if (closetsPlanned === 0 && w + EPS >= EXTRA_MINS.closet.minDim) {
      plan.push("closet");
      closetsPlanned++;
    } else if (allowSecondCloset && closetsPlanned < 2 && w + EPS >= EXTRA_MINS.closet.minDim && rng.bool(0.55)) {
      plan.push("closet");
      closetsPlanned++;
    }

    // Optional laundry (often near bath)
    if (allowLaundry && w + EPS >= EXTRA_MINS.laundry.minDim && rng.bool(0.5)) plan.push("laundry");

    // Remaining bedrooms (rear)
    const remainingBeds = Math.max(0, beds - (beds > 0 ? 1 : 0));
    for (let i = 0; i < remainingBeds; i++) plan.push("bedroom");

    // Storage is a safe “filler” room if we can afford it.
    if (allowStorage && w + EPS >= EXTRA_MINS.storage.minDim && rng.bool(0.6)) plan.push("storage");

    return plan;
  };

  const planL = wLeft + EPS >= 1.0 ? buildStripPlan("left") : [];
  const planR = wRight + EPS >= 1.0 ? buildStripPlan("right") : [];

  // Ensure we planned at least 1 closet and no more than 2
  if (closetsPlanned === 0) {
    // Force a closet on whichever strip can take it (prefer narrower).
    const preferClosetSide: Side = wLeft <= wRight ? "left" : "right";
    if (preferClosetSide === "left" && wLeft + EPS >= 1.0) planL.push("closet");
    else if (wRight + EPS >= 1.0) planR.push("closet");
    else throw new Error(`secondFloor: House ${hn} could not place required closet`);
    closetsPlanned = 1;
  }
  if (closetsPlanned > 2) {
    throw new Error(`secondFloor: House ${hn} planned too many closets (${closetsPlanned})`);
  }

  const stripSurfaces = { woodA, woodB, tileA, tileB };

  // Determine which strip contains the stairs opening (if any), so we can reserve it as VOID and not generate floor there.
  let holeSide: Side | null = null;
  if (stairsOpening) {
    // If opening is entirely left of the hallway's left edge, it's in leftStrip.
    if (stairsOpening.x1 <= hall.x0 + 1e-3) holeSide = "left";
    // If opening is entirely right of the hallway's right edge, it's in rightStrip.
    else if (stairsOpening.x0 >= hall.x1 - 1e-3) holeSide = "right";
  }

  const packSide = (side: Side, strip: Rect, plan: string[]): Region[] => {
    if (stairsOpening && holeSide === side) {
      return packStripWithStairsOpeningOrThrow(hn, hr.points, rng, strip, stairsOpening, plan, stripSurfaces);
    }
    return packStripOrThrow(hn, hr.points, rng, strip, plan, stripSurfaces);
  };

  const leftRooms = wLeft + EPS >= 1.0 ? packSide("left", leftStrip, planL) : [];
  const rightRooms = wRight + EPS >= 1.0 ? packSide("right", rightStrip, planR) : [];

  regions.push(...leftRooms, ...rightRooms);

  // -------- Use rear modification band (below zWideMin) to reduce unused space --------
  // These are extra rooms (office/laundry/storage). They are not required to touch hallway, but stay inside houseregion.
  const rearTop = q(shape.zWideMin + inset, 3);
  const rearBot = q(shape.z0 + inset, 3);

  if (rearTop - rearBot + EPS >= 1.8) {
    const tryRearRoom = (rr: Rect) => {
      // Prefer office, then laundry, then storage.
      const w = rectW(rr);
      const d = rectD(rr);

      const tryKinds: Array<keyof typeof EXTRA_MINS> = ["office", "laundry", "storage"];
      for (const k of tryKinds) {
        const min = EXTRA_MINS[k];
        if (w + EPS < min.minDim || d + EPS < min.minDim) continue;
        if (rectArea(rr) + EPS < min.area) continue;
        if (!rectInsidePoly(rr, hr.points)) continue;

        regions.push(rectToRegion(k, surfaceForRoom(k, woodA, woodB, tileA, tileB), rr));
        return true;
      }
      return false;
    };

    if (shape.kind === "extension") {
      const rr = rectNorm(shape.extX0 + inset, rearBot, shape.extX1 - inset, rearTop);
      if (rectW(rr) + EPS >= 1.2 && rectD(rr) + EPS >= 1.2) {
        tryRearRoom(rr);
      }
    } else if (shape.kind === "notch") {
      const leftWing = rectNorm(shape.x0 + inset, rearBot, shape.notchX0 - inset, rearTop);
      const rightWing = rectNorm(shape.notchX1 + inset, rearBot, shape.x1 - inset, rearTop);

      const wings: Rect[] = [];
      if (rectW(leftWing) > 0.2 && rectD(leftWing) > 0.2) wings.push(leftWing);
      if (rectW(rightWing) > 0.2 && rectD(rightWing) > 0.2) wings.push(rightWing);

      // Try to add up to 2 rear rooms, but don't add closets here (we already enforce 1..2 closets above).
      let added = 0;
      for (const wng of wings) {
        if (added >= 2) break;
        if (tryRearRoom(wng)) added++;
      }
    }
  }

  // Final validation: required set + touch/connectivity
  validateSecondFloorOrThrow(hn, hr.points, stairs, hall, regions);

  // Enforce “1 to 2 closets” in the final output (user request).
  const closetCount = regions.filter((r) => r.name === "closet" && r.surface !== "void").length;
  if (closetCount < 1 || closetCount > 2) {
    throw new Error(`secondFloor: House ${hn} closet count ${closetCount} out of desired range [1,2]`);
  }

  return { regions, construction: [], objects: [] };
}

export function generateSecondFloorModel(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel, firstFloor: FloorModel): FloorModel {
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
