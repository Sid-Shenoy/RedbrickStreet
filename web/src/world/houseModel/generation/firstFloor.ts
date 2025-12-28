// web/src/world/houseModel/generation/firstFloor.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, PolyPoints, Region, Surface } from "../types";
import type { HouseGenContext } from "./context";

/**
 * FOOLPROOF first-floor generator:
 * - Uses a conservative “full-width band” inside the plot `houseregion` so rectangles are guaranteed inside
 *   even when the footprint has a rear notch/extension.
 * - Avoids borderline sizes by rounding UP critical dimensions and adding small safety margins.
 * - Partitions the house into 3 X-bands: garage (driveway side), spine (foyer/hall/stairs/bath), living (rest).
 * - Stairs + bath are inside the spine band (NOT behind garage), eliminating tight-depth failures.
 */

const EPS = 1e-6;

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Always round UP to the quantization grid so we don't accidentally undershoot minima.
function ceilQ(v: number, digits = 3): number {
  const f = 10 ** digits;
  // subtract a tiny epsilon so values already on-grid stay stable
  return Math.ceil((v - 1e-12) * f) / f;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

type Rect = { x0: number; x1: number; z0: number; z1: number };

function rectNorm(x0: number, z0: number, x1: number, z1: number): Rect {
  const ax0 = Math.min(x0, x1);
  const ax1 = Math.max(x0, x1);
  const az0 = Math.min(z0, z1);
  const az1 = Math.max(z0, z1);
  return { x0: q(ax0), x1: q(ax1), z0: q(az0), z1: q(az1) };
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

function rectOverlapAreaPositive(a: Rect, b: Rect): boolean {
  const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const iz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return ix > EPS && iz > EPS;
}

/**
 * Shared boundary segment length between rectangles (axis-aligned).
 * Returns the maximum single shared segment length.
 */
function sharedBoundaryLen(a: Rect, b: Rect): number {
  let best = 0;

  // a right edge against b left edge
  if (Math.abs(a.x1 - b.x0) <= 1e-3) {
    const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (oz > best) best = oz;
  }
  // a left edge against b right edge
  if (Math.abs(a.x0 - b.x1) <= 1e-3) {
    const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (oz > best) best = oz;
  }
  // a top edge against b bottom edge
  if (Math.abs(a.z1 - b.z0) <= 1e-3) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (ox > best) best = ox;
  }
  // a bottom edge against b top edge
  if (Math.abs(a.z0 - b.z1) <= 1e-3) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (ox > best) best = ox;
  }

  return best;
}

function uniqSorted(vals: number[]): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) {
    if (out.length === 0) out.push(v);
    else if (Math.abs(v - out[out.length - 1]!) > 1e-3) out.push(v);
  }
  return out;
}

function getRegionByName(plot: FloorModel, name: string): Region | undefined {
  return plot.regions.find((r) => r.name === name);
}

function rectFromRegion(r: Extract<Region, { type: "rectangle" }>): Rect {
  const [[x0, z0], [x1, z1]] = r.points;
  return rectNorm(x0, z0, x1, z1);
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

  // Vertical segment
  if (dx <= tol && Math.abs(x - ax) <= tol) {
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    return z + tol >= z0 && z - tol <= z1;
  }

  // Horizontal segment
  if (dz <= tol && Math.abs(z - az) <= tol) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    return x + tol >= x0 && x - tol <= x1;
  }

  return false;
}

function pointInPolyOrOnBoundary(x: number, z: number, poly: PolyPoints): boolean {
  if (poly.length < 3) return false;

  // Boundary check first (axis-aligned edges expected)
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (pointOnSegAxisAligned(x, z, a[0], a[1], b[0], b[1], 1e-6)) return true;
  }

  // Even-odd ray casting to +X
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

type RoomMin = { area: number; minDim: number };

const REQUIRED_MINS: Record<string, RoomMin> = {
  garage: { area: 18.0, minDim: 3.0 },
  livingroom: { area: 16.0, minDim: 3.2 },
  kitchen: { area: 10.0, minDim: 2.6 },
  foyer: { area: 5.0, minDim: 1.8 },
  hallway: { area: 6.0, minDim: 1.0 },
  bathroom_small: { area: 2.6, minDim: 1.4 },
  stairs: { area: 3.6, minDim: 1.0 },
};

const EXTRA_MINS: Record<string, RoomMin> = {
  diningroom: { area: 10.0, minDim: 2.6 },
  mudroom: { area: 4.0, minDim: 1.6 },
  pantry: { area: 2.5, minDim: 1.2 },
  laundry: { area: 4.0, minDim: 1.6 },
  office: { area: 8.0, minDim: 2.4 },
  closet: { area: 2.0, minDim: 1.0 },
  storage: { area: 3.0, minDim: 1.2 },
};

function checkMin(hn: number, name: string, r: Rect, min: RoomMin) {
  const a = rectArea(r);
  const md = rectMinDim(r);
  if (a + EPS < min.area || md + EPS < min.minDim) {
    throw new Error(
      `firstFloor: House ${hn} ${name} too small (area=${q(a, 3)} min=${min.area}, minDim=${q(md, 3)} min=${min.minDim})`
    );
  }
}

function pickWood(ctx: HouseGenContext): Surface {
  return ctx.rng.pick(["wood_light", "wood_medium", "wood_dark"] as const);
}
function pickTile(ctx: HouseGenContext): Surface {
  return ctx.rng.pick(["tile_light", "tile_medium", "tile_dark"] as const);
}

type BuiltRoom = {
  name: string;
  surface: Surface;
  rect: Rect;
  kind: "required" | "extra";
};

function addRoom(out: BuiltRoom[], name: string, surface: Surface, rect: Rect, kind: BuiltRoom["kind"]) {
  out.push({ name, surface, rect, kind });
}

function buildAdjacencyGraph(rooms: BuiltRoom[], minSeg = 0.6): Map<number, number[]> {
  const g = new Map<number, number[]>();
  for (let i = 0; i < rooms.length; i++) g.set(i, []);

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const seg = sharedBoundaryLen(rooms[i]!.rect, rooms[j]!.rect);
      if (seg + EPS >= minSeg) {
        g.get(i)!.push(j);
        g.get(j)!.push(i);
      }
    }
  }
  return g;
}

function ensureRequiredConnected(hn: number, rooms: BuiltRoom[]) {
  const reqIdx = rooms
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.kind === "required")
    .map((x) => x.i);

  if (reqIdx.length === 0) throw new Error(`firstFloor: House ${hn} internal error: no required rooms`);

  const g = buildAdjacencyGraph(rooms, 0.6);

  const visited = new Set<number>();
  const stack = [reqIdx[0]!];
  visited.add(reqIdx[0]!);

  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of g.get(cur) ?? []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        stack.push(nxt);
      }
    }
  }

  for (const i of reqIdx) {
    if (!visited.has(i)) {
      throw new Error(
        `firstFloor: House ${hn} required-room connectivity failed (disconnected room: ${rooms[i]!.name})`
      );
    }
  }
}

export function generateFirstFloorModel(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel): FloorModel {
  const hn = house.houseNumber;
  const fail = (msg: string) => {
    throw new Error(`firstFloor: House ${hn} ${msg}`);
  };

  const hr = getRegionByName(plot, "houseregion");
  if (!hr || hr.type !== "polygon") fail("plot missing region 'houseregion' (polygon)");

  const driveway = getRegionByName(plot, "driveway_near");
  if (!driveway || driveway.type !== "rectangle") fail("plot missing region 'driveway_near' (rectangle)");

  const walkway = getRegionByName(plot, "walkway");
  if (!walkway || walkway.type !== "rectangle") fail("plot missing region 'walkway' (rectangle)");

  const housePoly = hr.points;

  // zFront = maxZ of polygon.
  let zFront = -Infinity;
  for (const [, z] of housePoly) zFront = Math.max(zFront, z);
  zFront = q(zFront, 3);

  // House front X-range at zFront.
  const frontPts = housePoly.filter((p) => Math.abs(p[1] - zFront) <= 1e-3);
  if (frontPts.length < 2) fail(`houseregion does not touch front boundary z=${zFront} with >=2 vertices`);

  let xHouse0 = Infinity;
  let xHouse1 = -Infinity;
  for (const [x] of frontPts) {
    xHouse0 = Math.min(xHouse0, x);
    xHouse1 = Math.max(xHouse1, x);
  }
  xHouse0 = q(xHouse0, 3);
  xHouse1 = q(xHouse1, 3);

  // Conservative full-width band start:
  // - Rectangle footprint => 2 unique z values => safe start is min z
  // - Notch/extension => 3 unique z values => safe start is middle z
  const zVals = uniqSorted(housePoly.map((p) => q(p[1], 3)));
  if (zVals.length < 2 || zVals.length > 3) {
    fail(`unexpected houseregion z-profile (unique z count=${zVals.length}, expected 2 or 3)`);
  }
  const zWideMin = q(zVals.length === 2 ? zVals[0]! : zVals[1]!, 3);
  if (zWideMin + EPS >= zFront) fail(`invalid houseregion band (zWideMin=${zWideMin} >= zFront=${zFront})`);

  const depthAvail = q(zFront - zWideMin, 3);
  if (depthAvail + EPS < 9.5) {
    // Should be rare with plot constraints, but handle defensively.
    fail(`insufficient depth in full-width band (depthAvail=${depthAvail}m, expected >= 9.5m)`);
  }

  // Driveway / walkway x-intervals (lot-local)
  const drv = rectFromRegion(driveway);
  const ww = rectFromRegion(walkway);

  const dx0 = q(drv.x0, 3);
  const dx1 = q(drv.x1, 3);
  const wx0 = q(ww.x0, 3);
  const wx1 = q(ww.x1, 3);

  const garageW = q(dx1 - dx0, 3);
  if (garageW + EPS < 3.0 || garageW - EPS > 3.8) {
    fail(`driveway/garage width out of expected range [3.0,3.8] (got ${garageW})`);
  }

  const drivewaySide: "left" | "right" = dx0 <= 1e-3 ? "left" : "right";

  // X partition: garage | spine | living
  const minLivingW = 3.2;

  const availW =
    drivewaySide === "left" ? q(xHouse1 - dx1, 3) : q(dx0 - xHouse0, 3); // width excluding garage
  if (availW + EPS < minLivingW + 2.8) {
    fail(
      `insufficient width for spine+living (availW=${availW}, need >= ${q(minLivingW + 2.8, 3)})`
    );
  }

  // Spine width: give enough room for a hallway corridor strip + stairs/bath strip.
  // Keep living at least minLivingW.
  const spineWMax = q(availW - minLivingW, 3);
  let spineW = q(clamp(ctx.rng.float(2.85, 3.35), 2.8, spineWMax), 3);

  let livingW = q(availW - spineW, 3);
  if (livingW + EPS < minLivingW) {
    spineW = q(spineWMax, 3);
    livingW = q(availW - spineW, 3);
  }
  if (livingW + EPS < minLivingW) fail(`livingW too small after partition (livingW=${livingW})`);

  // Spine corridor width (hallway strip) must be >= 1.0 and allow remaining strip for bath >= ~1.5
  const remMin = 1.55;
  const corridorMin = 1.0;

  if (spineW + EPS < corridorMin + remMin) {
    // Try to expand spine by reducing living (still >=3.2).
    const targetSpine = corridorMin + remMin;
    const maxSpinePossible = spineWMax;
    spineW = q(Math.min(maxSpinePossible, targetSpine), 3);
    livingW = q(availW - spineW, 3);
  }

  if (spineW + EPS < corridorMin + 1.4) {
    fail(`spine too narrow for hallway+bath (spineW=${spineW})`);
  }

  // Choose a stable corridor width; ensure remainder is wide enough for bath.
  let corridorW = q(clamp(ctx.rng.float(1.05, 1.25), 1.0, spineW - 1.45), 3);
  let remW = q(spineW - corridorW, 3);

  // If remainder is still tight for bathroom realism, shrink corridor to increase remW.
  if (remW + EPS < remMin) {
    corridorW = q(Math.max(1.0, spineW - remMin), 3);
    remW = q(spineW - corridorW, 3);
  }

  if (corridorW + EPS < 1.0) fail(`hallway corridor width < 1.0 (corridorW=${corridorW})`);
  if (remW + EPS < 1.4) fail(`bath/stairs strip too narrow (remW=${remW})`);

  // Segment X coordinates
  let xGarage0: number, xGarage1: number;
  let xSpine0: number, xSpine1: number;
  let xLiving0: number, xLiving1: number;

  if (drivewaySide === "left") {
    xGarage0 = dx0;
    xGarage1 = dx1;

    xSpine0 = dx1;
    xSpine1 = q(dx1 + spineW, 3);

    xLiving0 = xSpine1;
    xLiving1 = xHouse1;
  } else {
    xGarage0 = dx0;
    xGarage1 = dx1;

    xSpine1 = dx0;
    xSpine0 = q(dx0 - spineW, 3);

    xLiving0 = xHouse0;
    xLiving1 = xSpine0;
  }

  // Hallway corridor is on the living-adjacent side of the spine:
  const xHall0 = drivewaySide === "left" ? q(xSpine1 - corridorW, 3) : xSpine0;
  const xHall1 = drivewaySide === "left" ? xSpine1 : q(xSpine0 + corridorW, 3);

  // Bath/stairs strip is the remaining part of the spine (garage-adjacent side)
  const xSvc0 = drivewaySide === "left" ? xSpine0 : q(xSpine0 + corridorW, 3);
  const xSvc1 = drivewaySide === "left" ? q(xSpine1 - corridorW, 3) : xSpine1;

  // Sanity: widths should match
  if (q(xHall1 - xHall0, 3) + EPS < 1.0) fail(`hallway corridor width invalid`);
  if (q(xSvc1 - xSvc0, 3) + EPS < 1.4) fail(`service strip width invalid`);

  // Choose surfaces
  const woodA = pickWood(ctx);
  const woodB = pickWood(ctx);
  const tileA = pickTile(ctx);
  const tileB = pickTile(ctx);

  // Z partitioning
  // Foyer depth must meet min area/dim and leave behind depth for hallway/stairs/bath.
  const foyerMinByArea = (REQUIRED_MINS.foyer.area + 0.12) / spineW; // safety margin
  const foyerMinByDim = REQUIRED_MINS.foyer.minDim + 0.05;
  const foyerMin = Math.max(2.0, ceilQ(foyerMinByArea), foyerMinByDim);

  // Stairs & bath depths based on service strip width
  const svcW = q(xSvc1 - xSvc0, 3);

  const bathMinDim = REQUIRED_MINS.bathroom_small.minDim + 0.05;
  const bathMinByArea = (REQUIRED_MINS.bathroom_small.area + 0.12) / svcW;
  const bathD = q(Math.max(ceilQ(bathMinByArea), bathMinDim, 1.65), 3);

  const stairsMinByArea = (REQUIRED_MINS.stairs.area + 0.12) / svcW;
  // Stairs minDim is 1.0; depth can be lower than 3.0 if width is generous, but keep somewhat realistic.
  const stairsD = q(Math.max(ceilQ(stairsMinByArea), 2.55), 3);

  let gap = q(clamp(ctx.rng.float(0.0, 0.35), 0.0, 0.35), 3);

  // Ensure behind-foyer depth can fit bath + gap + stairs + a small buffer.
  const needBehind = bathD + gap + stairsD + 0.12;
  const maxFoyer = q(depthAvail - needBehind, 3);

  // If needed, shrink foyer (but keep >= foyerMin).
  let foyerD = q(clamp(ctx.rng.float(2.25, 2.9), foyerMin, Math.max(foyerMin, maxFoyer)), 3);
  if (depthAvail - foyerD + EPS < needBehind) {
    const forced = q(depthAvail - needBehind, 3);
    foyerD = q(clamp(forced, foyerMin, forced), 3);
  }
  if (foyerD + EPS < foyerMin) {
    // As a last resort, remove gap and recompute.
    gap = 0.0;
    const needBehind2 = bathD + gap + stairsD + 0.12;
    const maxFoyer2 = q(depthAvail - needBehind2, 3);
    foyerD = q(clamp(2.25, foyerMin, Math.max(foyerMin, maxFoyer2)), 3);
    if (depthAvail - foyerD + EPS < needBehind2) {
      fail(
        `cannot fit foyer+hall+bath+stairs in depthAvail=${depthAvail} (foyerMin=${q(foyerMin, 3)}, bathD=${bathD}, stairsD=${stairsD})`
      );
    }
  }

  const zFoyer0 = q(zFront - foyerD, 3); // start of foyer (back edge)
  const zBack1 = zFoyer0; // end of hallway band
  const zBack0 = zWideMin;

  // Bathroom sits directly behind foyer in service strip
  const zBath1 = zBack1;
  const zBath0 = q(zBath1 - bathD, 3);

  // Stairs behind bathroom (with gap)
  const zStairs1 = q(zBath0 - gap, 3);
  const zStairs0 = q(zStairs1 - stairsD, 3);

  // If stairs dip below zWideMin, push them forward by reducing gap then (if needed) shrinking stairsD to minimum
  if (zStairs0 + EPS < zWideMin) {
    gap = 0.0;
    const zS1 = q(zBath0, 3);
    let zS0 = q(zS1 - stairsD, 3);
    if (zS0 + EPS < zWideMin) {
      const stairsMinDim = REQUIRED_MINS.stairs.minDim + 0.05;
      const stairsMinAreaDepth = ceilQ((REQUIRED_MINS.stairs.area + 0.12) / svcW);
      const stairsDMin = q(Math.max(stairsMinDim, stairsMinAreaDepth), 3);

      const stairsD2 = q(Math.max(stairsDMin, q(zS1 - zWideMin, 3)), 3);
      if (stairsD2 + EPS < stairsDMin) {
        fail(`cannot fit stairs without violating minima (available=${q(zS1 - zWideMin, 3)}, need=${stairsDMin})`);
      }

      zS0 = q(zS1 - stairsD2, 3);
      if (zS0 + EPS < zWideMin) fail(`stairs still out of band after adjustment`);
    }
  }

  // Garage depth: ensure inside full-width band (zGarage0 >= zWideMin) and meet minima.
  const garageMinByArea = (REQUIRED_MINS.garage.area + 0.2) / garageW;
  const garageMinByDim = REQUIRED_MINS.garage.minDim + 0.05;
  const garageMin = Math.max(5.8, ceilQ(garageMinByArea), garageMinByDim);

  const garageMax = q(depthAvail - 0.2, 3);
  if (garageMax + EPS < garageMin) {
    fail(`cannot fit garage depth within band (garageMin=${garageMin}, garageMax=${garageMax}, depthAvail=${depthAvail})`);
  }
  const garageD = q(clamp(ctx.rng.float(6.25, 7.35), garageMin, garageMax), 3);
  const zGarage0 = q(zFront - garageD, 3);
  if (zGarage0 + EPS < zWideMin) fail(`garage extends outside band (zGarage0=${zGarage0}, zWideMin=${zWideMin})`);

  // Living side: kitchen band at back, livingroom at front.
  // Optional dining room: split kitchen band width into kitchen + dining if feasible.
  const livingBandW = q(xLiving1 - xLiving0, 3);
  if (livingBandW + EPS < REQUIRED_MINS.livingroom.minDim) {
    fail(`living side width too small (livingBandW=${livingBandW} < ${REQUIRED_MINS.livingroom.minDim})`);
  }

  // Choose whether to add dining room (only if width supports two >=2.6 bands).
  let wantDining = ctx.rng.bool(0.65) && livingBandW + EPS >= 5.4;

  // Decide kitchen width (adjacent to hallway corridor) if dining exists; else kitchen spans full living width.
  let kitchenWBand = livingBandW;
  let diningWBand = 0;

  if (wantDining) {
    const minSplit = 2.6;
    const maxKitchenW = livingBandW - minSplit;
    const targetKitchenW = clamp(ctx.rng.float(3.2, 4.6), minSplit, maxKitchenW);
    kitchenWBand = q(targetKitchenW, 3);
    diningWBand = q(livingBandW - kitchenWBand, 3);
    if (diningWBand + EPS < minSplit) {
      // Rebalance deterministically
      kitchenWBand = q(livingBandW - minSplit, 3);
      diningWBand = q(minSplit, 3);
    }
    if (kitchenWBand + EPS < minSplit || diningWBand + EPS < minSplit) {
      wantDining = false;
      kitchenWBand = livingBandW;
      diningWBand = 0;
    }
  }

  // Depths for kitchen band and living band
  const livingMinByArea = (REQUIRED_MINS.livingroom.area + 0.25) / livingBandW;
  const livingMin = Math.max(REQUIRED_MINS.livingroom.minDim + 0.05, ceilQ(livingMinByArea));

  const kitchenMinByArea = (REQUIRED_MINS.kitchen.area + 0.2) / kitchenWBand;
  const kitchenMin = Math.max(REQUIRED_MINS.kitchen.minDim + 0.05, ceilQ(kitchenMinByArea));

  let diningMin = 0;
  if (wantDining) {
    const diningMinByArea = (EXTRA_MINS.diningroom.area + 0.2) / diningWBand;
    diningMin = Math.max(EXTRA_MINS.diningroom.minDim + 0.05, ceilQ(diningMinByArea));
  }

  const kitchenDMin = q(Math.max(kitchenMin, wantDining ? diningMin : 0), 3);
  const livingDMin = q(livingMin, 3);

  const maxKitchenD = q(depthAvail - livingDMin, 3);
  if (maxKitchenD + EPS < kitchenDMin) {
    // If dining made it impossible, drop dining and recompute once.
    if (wantDining) {
      wantDining = false;
      kitchenWBand = livingBandW;
      diningWBand = 0;

      const kMinByArea2 = (REQUIRED_MINS.kitchen.area + 0.2) / kitchenWBand;
      const kMin2 = Math.max(REQUIRED_MINS.kitchen.minDim + 0.05, ceilQ(kMinByArea2));
      const kitchenDMin2 = q(kMin2, 3);
      const maxKitchenD2 = q(depthAvail - livingDMin, 3);
      if (maxKitchenD2 + EPS < kitchenDMin2) {
        fail(
          `cannot fit kitchen+living depths (depthAvail=${depthAvail}, kitchenDMin=${kitchenDMin2}, livingDMin=${livingDMin})`
        );
      }
    } else {
      fail(
        `cannot fit kitchen+living depths (depthAvail=${depthAvail}, kitchenDMin=${kitchenDMin}, livingDMin=${livingDMin})`
      );
    }
  }

  const kitchenD = q(clamp(ctx.rng.float(4.2, 5.8), kitchenDMin, q(depthAvail - livingDMin, 3)), 3);
  const zSplit = q(zWideMin + kitchenD, 3);

  // Regions
  const rooms: BuiltRoom[] = [];

  // Garage (required)
  addRoom(
    rooms,
    "garage",
    "concrete_dark",
    rectNorm(xGarage0, zGarage0, xGarage1, zFront),
    "required"
  );

  // Foyer (required) - full spine width at front
  addRoom(
    rooms,
    "foyer",
    woodA,
    rectNorm(xSpine0, zFoyer0, xSpine1, zFront),
    "required"
  );

  // Hallway (required) - corridor strip behind foyer
  addRoom(
    rooms,
    "hallway",
    woodA,
    rectNorm(xHall0, zBack0, xHall1, zBack1),
    "required"
  );

  // Bathroom small (required) - service strip, directly behind foyer
  addRoom(
    rooms,
    "bathroom_small",
    tileB,
    rectNorm(xSvc0, zBath0, xSvc1, zBath1),
    "required"
  );

  // Stairs (required) - service strip, behind bathroom
  addRoom(
    rooms,
    "stairs",
    "wood_medium",
    rectNorm(xSvc0, zStairs0, xSvc1, zStairs1),
    "required"
  );

  // Living side: kitchen + (optional) dining in the back band
  if (wantDining) {
    // Place kitchen adjacent to hallway corridor (touching spine boundary).
    if (drivewaySide === "left") {
      const kx0 = xLiving0;
      const kx1 = q(xLiving0 + kitchenWBand, 3);
      const dxA0 = kx1;
      const dxA1 = xLiving1;

      addRoom(rooms, "kitchen", tileA, rectNorm(kx0, zWideMin, kx1, zSplit), "required");
      addRoom(rooms, "diningroom", woodB, rectNorm(dxA0, zWideMin, dxA1, zSplit), "extra");
    } else {
      const kx1 = xLiving1;
      const kx0 = q(xLiving1 - kitchenWBand, 3);
      const dxA0 = xLiving0;
      const dxA1 = kx0;

      addRoom(rooms, "kitchen", tileA, rectNorm(kx0, zWideMin, kx1, zSplit), "required");
      addRoom(rooms, "diningroom", woodB, rectNorm(dxA0, zWideMin, dxA1, zSplit), "extra");
    }
  } else {
    addRoom(rooms, "kitchen", tileA, rectNorm(xLiving0, zWideMin, xLiving1, zSplit), "required");
  }

  // Livingroom (required) - front band on living side
  addRoom(rooms, "livingroom", woodB, rectNorm(xLiving0, zSplit, xLiving1, zFront), "required");

  // --- Validation: bounds / containment / overlaps / minima ---
  for (const r of rooms) {
    const rr = r.rect;

    // Lot bounds
    if (rr.x0 < -EPS || rr.x1 > ctx.xsize + EPS || rr.z0 < -EPS || rr.z1 > 30 + EPS) {
      fail(
        `region '${r.name}' out of lot bounds: x=[${rr.x0},${rr.x1}] z=[${rr.z0},${rr.z1}] (xsize=${ctx.xsize})`
      );
    }

    // Must be inside houseregion polygon
    if (!rectInsidePoly(rr, housePoly)) {
      fail(
        `region '${r.name}' not fully inside houseregion polygon (rect x=[${rr.x0},${rr.x1}] z=[${rr.z0},${rr.z1}])`
      );
    }

    // Global invariants
    if (rectArea(rr) + EPS < 2.0) fail(`region '${r.name}' violates global min area (area=${q(rectArea(rr), 3)})`);
    if (rectMinDim(rr) + EPS < 1.0)
      fail(`region '${r.name}' violates global min dimension (minDim=${q(rectMinDim(rr), 3)})`);
  }

  // Non-overlap (area)
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (rectOverlapAreaPositive(rooms[i]!.rect, rooms[j]!.rect)) {
        fail(`regions overlap: '${rooms[i]!.name}' overlaps '${rooms[j]!.name}'`);
      }
    }
  }

  // Room-specific minimums
  for (const r of rooms) {
    const mins = r.kind === "required" ? REQUIRED_MINS[r.name] : EXTRA_MINS[r.name];
    if (mins) checkMin(hn, r.name, r.rect, mins);
  }

  // --- Required exterior interfaces ---
  // Garage touches front and aligns with driveway; interface >= 2.5m (we align full width).
  {
    const g = rooms.find((r) => r.name === "garage")!.rect;
    if (Math.abs(g.z1 - zFront) > 1e-3) fail(`garage must touch houseregion front boundary`);
    const drivewayOverlap = Math.max(0, Math.min(g.x1, dx1) - Math.max(g.x0, dx0));
    if (drivewayOverlap + EPS < 2.5) fail(`garage-driveway interface too short (len=${q(drivewayOverlap, 3)}m)`);
  }

  // Foyer touches front and overlaps walkway on the front edge >= 0.8m.
  {
    const f = rooms.find((r) => r.name === "foyer")!.rect;
    if (Math.abs(f.z1 - zFront) > 1e-3) fail(`foyer must touch houseregion front boundary`);
    const walkwayOverlap = Math.max(0, Math.min(f.x1, wx1) - Math.max(f.x0, wx0));
    if (walkwayOverlap + EPS < 0.8) fail(`foyer-walkway interface too short (len=${q(walkwayOverlap, 3)}m)`);
  }

  // --- Interior connectivity (hard) ---
  const foyerR = rooms.find((r) => r.name === "foyer")!.rect;
  const hallR = rooms.find((r) => r.name === "hallway")!.rect;
  const stairsR = rooms.find((r) => r.name === "stairs")!.rect;
  const bathR = rooms.find((r) => r.name === "bathroom_small")!.rect;
  const garageR = rooms.find((r) => r.name === "garage")!.rect;

  const kitchenRects = rooms.filter((r) => r.name === "kitchen").map((r) => r.rect);
  const livingR = rooms.find((r) => r.name === "livingroom")!.rect;
  const diningR = rooms.find((r) => r.name === "diningroom")?.rect ?? null;

  // foyer shares boundary >=0.8 with hallway OR livingroom
  if (Math.max(sharedBoundaryLen(foyerR, hallR), sharedBoundaryLen(foyerR, livingR)) + EPS < 0.8) {
    fail(`foyer must share boundary >=0.8m with hallway or livingroom`);
  }

  // hallway shares boundary >=0.8 with stairs
  if (sharedBoundaryLen(hallR, stairsR) + EPS < 0.8) fail(`hallway must share boundary >=0.8m with stairs`);

  // bathroom_small shares boundary >=0.6 with hallway
  if (sharedBoundaryLen(hallR, bathR) + EPS < 0.6) fail(`bathroom_small must share boundary >=0.6m with hallway`);

  // garage shares boundary >=0.8 with hallway OR foyer OR mudroom (we satisfy via foyer)
  if (Math.max(sharedBoundaryLen(garageR, hallR), sharedBoundaryLen(garageR, foyerR)) + EPS < 0.8) {
    fail(`garage must share boundary >=0.8m with hallway or foyer (or mudroom if present)`);
  }

  // kitchen shares boundary >=0.8 with livingroom OR diningroom OR hallway
  {
    const k = kitchenRects[0];
    const ok =
      sharedBoundaryLen(k, livingR) + EPS >= 0.8 ||
      sharedBoundaryLen(k, hallR) + EPS >= 0.8 ||
      (diningR ? sharedBoundaryLen(k, diningR) + EPS >= 0.8 : false);
    if (!ok) fail(`kitchen must share boundary >=0.8m with livingroom or diningroom or hallway`);
  }

  // diningroom (if present) shares boundary >=0.8 with kitchen OR livingroom
  if (diningR) {
    const k = kitchenRects[0];
    if (Math.max(sharedBoundaryLen(diningR, k), sharedBoundaryLen(diningR, livingR)) + EPS < 0.8) {
      fail(`diningroom must share boundary >=0.8m with kitchen or livingroom`);
    }
  }

  // Global required-room connectivity under adjacency>=0.6
  ensureRequiredConnected(hn, rooms);

  return {
    regions: rooms.map((r) => rectToRegion(r.name, r.surface, r.rect)),
    construction: [],
    objects: [],
  };
}
