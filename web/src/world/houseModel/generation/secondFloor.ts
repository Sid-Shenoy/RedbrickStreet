import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region } from "../types";
import type { HouseGenContext } from "./context";

const EPS = 1e-6;

type Rect = { x0: number; z0: number; x1: number; z1: number };
type Wall = "left" | "right";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function normRect(r: Rect): Rect {
  const x0 = Math.min(r.x0, r.x1);
  const x1 = Math.max(r.x0, r.x1);
  const z0 = Math.min(r.z0, r.z1);
  const z1 = Math.max(r.z0, r.z1);
  return { x0, x1, z0, z1 };
}

function rectRegion(
  name: string,
  surface: Region["surface"],
  x0: number,
  z0: number,
  x1: number,
  z1: number
): Region {
  const r = normRect({ x0, z0, x1, z1 });
  return { name, surface, type: "rectangle", points: [[r.x0, r.z0], [r.x1, r.z1]] };
}

function polyRegion(name: string, surface: Region["surface"], pts: Array<[number, number]>): Region {
  // Spec: polygons are NOT explicitly closed; closure is implied by consumer.
  return { name, surface, type: "polygon", points: pts };
}

function uniqSorted(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) {
    if (out.length === 0) out.push(v);
    else if (Math.abs(v - out[out.length - 1]!) > 1e-6) out.push(v);
  }
  return out;
}

function rectContains(r: Rect, x: number, z: number): boolean {
  const rr = normRect(r);
  return x >= rr.x0 - EPS && x <= rr.x1 + EPS && z >= rr.z0 - EPS && z <= rr.z1 + EPS;
}

function rectArea(r: Rect): number {
  const rr = normRect(r);
  return Math.max(0, rr.x1 - rr.x0) * Math.max(0, rr.z1 - rr.z0);
}

function rectIntersects(a: Rect, b: Rect): boolean {
  const A = normRect(a);
  const B = normRect(b);
  return !(A.x1 <= B.x0 + EPS || A.x0 >= B.x1 - EPS || A.z1 <= B.z0 + EPS || A.z0 >= B.z1 - EPS);
}

// Standard ray-cast point-in-polygon (simple polygon; pts not explicitly closed)
function pointInPoly(x: number, z: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  const n = pts.length;
  if (n < 3) return false;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = pts[i]!;
    const [xj, zj] = pts[j]!;
    const intersects = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Build a single simple orthogonal boundary polygon from a union of axis-aligned rectangles.
 * Assumes the rectangles form one connected component and do not create holes.
 *
 * Returns Region as rectangle when boundary reduces to 4 corners.
 */
function unionRectsToRegion(name: string, surface: Region["surface"], rects: Rect[]): Region {
  const rs = rects.map(normRect).filter((r) => r.x1 - r.x0 > EPS && r.z1 - r.z0 > EPS);
  assert(rs.length > 0, `secondFloor: region '${name}' has no area`);

  const k = (v: number) => v.toFixed(6);
  const pkey = (x: number, z: number) => `${k(x)},${k(z)}`;
  const ekey = (ax: number, az: number, bx: number, bz: number) => {
    const a = pkey(ax, az);
    const b = pkey(bx, bz);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };

  // Cancel shared edges
  const edges = new Map<string, { a: string; b: string }>();
  function addEdge(ax: number, az: number, bx: number, bz: number) {
    const key = ekey(ax, az, bx, bz);
    if (edges.has(key)) edges.delete(key);
    else edges.set(key, { a: pkey(ax, az), b: pkey(bx, bz) });
  }

  for (const r of rs) {
    addEdge(r.x0, r.z0, r.x1, r.z0);
    addEdge(r.x1, r.z0, r.x1, r.z1);
    addEdge(r.x1, r.z1, r.x0, r.z1);
    addEdge(r.x0, r.z1, r.x0, r.z0);
  }

  assert(edges.size >= 4, `secondFloor: region '${name}' boundary is degenerate`);

  // Adjacency graph
  const adj = new Map<string, string[]>();
  function link(a: string, b: string) {
    const la = adj.get(a);
    if (la) la.push(b);
    else adj.set(a, [b]);
  }
  for (const e of edges.values()) {
    link(e.a, e.b);
    link(e.b, e.a);
  }

  // Simple boundary requires degree 2
  for (const [pt, nbs] of adj.entries()) {
    assert(nbs.length === 2, `secondFloor: region '${name}' boundary not simple at ${pt} (deg=${nbs.length})`);
  }

  // Start at lowest z, then lowest x
  const keys = [...adj.keys()];
  keys.sort((a, b) => {
    const [ax, az] = a.split(",").map(Number);
    const [bx, bz] = b.split(",").map(Number);
    if (az !== bz) return az - bz;
    return ax - bx;
  });
  const start = keys[0]!;
  const nbs = adj.get(start)!;
  const next = nbs[0]! < nbs[1]! ? nbs[0]! : nbs[1]!;

  const loop: string[] = [];
  let prev = start;
  let cur = next;
  loop.push(start);

  while (true) {
    loop.push(cur);
    if (cur === start) break;
    const nn = adj.get(cur)!;
    const nxt = nn[0] === prev ? nn[1]! : nn[0]!;
    prev = cur;
    cur = nxt;
    if (loop.length > 5000) throw new Error(`secondFloor: region '${name}' boundary loop runaway`);
  }
  loop.pop(); // remove repeated start

  let pts: Array<[number, number]> = loop.map((pk) => {
    const [x, z] = pk.split(",").map(Number);
    return [x, z];
  });

  // Remove collinear points
  const simp: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % pts.length]!;
    const dx1 = p1[0] - p0[0];
    const dz1 = p1[1] - p0[1];
    const dx2 = p2[0] - p1[0];
    const dz2 = p2[1] - p1[1];
    const collinear = (Math.abs(dx1) < EPS && Math.abs(dx2) < EPS) || (Math.abs(dz1) < EPS && Math.abs(dz2) < EPS);
    if (!collinear) simp.push(p1);
  }
  pts = simp;

  assert(pts.length >= 4, `secondFloor: region '${name}' simplified boundary too small`);

  const xs = uniqSorted(pts.map((p) => p[0]));
  const zs = uniqSorted(pts.map((p) => p[1]));
  if (pts.length === 4 && xs.length === 2 && zs.length === 2) {
    return rectRegion(name, surface, xs[0]!, zs[0]!, xs[1]!, zs[1]!);
  }

  return polyRegion(name, surface, pts);
}

function sharedBoundaryLengthFromCells(
  xCuts: number[],
  zCuts: number[],
  cellRegion: string[][],
  a: string,
  b: string
): number {
  let len = 0;
  const nx = xCuts.length - 1;
  const nz = zCuts.length - 1;

  // vertical adjacencies
  for (let ix = 0; ix < nx - 1; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      const r0 = cellRegion[ix]![iz]!;
      const r1 = cellRegion[ix + 1]![iz]!;
      if ((r0 === a && r1 === b) || (r0 === b && r1 === a)) {
        const dz = zCuts[iz + 1]! - zCuts[iz]!;
        if (dz > EPS) len += dz;
      }
    }
  }

  // horizontal adjacencies
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz - 1; iz++) {
      const r0 = cellRegion[ix]![iz]!;
      const r1 = cellRegion[ix]![iz + 1]!;
      if ((r0 === a && r1 === b) || (r0 === b && r1 === a)) {
        const dx = xCuts[ix + 1]! - xCuts[ix]!;
        if (dx > EPS) len += dx;
      }
    }
  }

  return len;
}

function pickSplitByStairsEdge(
  interiorX0: number,
  interiorX1: number,
  stairsN: Rect,
  minSideW = 2.2
): number {
  const cands = [stairsN.x0, stairsN.x1];
  const valid = cands
    .map((c) => clamp(c, interiorX0 + minSideW, interiorX1 - minSideW))
    .filter((c) => c > interiorX0 + minSideW + EPS && c < interiorX1 - minSideW - EPS);

  if (valid.length === 0) {
    // Fallback: center-ish, still within bounds if possible
    return clamp((stairsN.x0 + stairsN.x1) * 0.5, interiorX0 + minSideW, interiorX1 - minSideW);
  }

  let best = valid[0]!;
  let bestScore = -1;
  for (const s of valid) {
    const wL = s - interiorX0;
    const wR = interiorX1 - s;
    const score = Math.min(wL, wR);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

export function generateSecondFloorModel(
  house: HouseConfig,
  ctx: HouseGenContext,
  plot: FloorModel,
  firstFloor: FloorModel
): FloorModel {
  const { rng, xsize } = ctx;

  const houseRegion = plot.regions.find((r) => r.name === "houseregion");
  const drivewayNear = plot.regions.find((r) => r.name === "driveway_near");
  assert(houseRegion && houseRegion.type === "polygon", `secondFloor: missing/invalid plot region 'houseregion'`);
  assert(drivewayNear && drivewayNear.type === "rectangle", `secondFloor: missing/invalid plot region 'driveway_near'`);

  const stairs = firstFloor.regions.find((r) => r.name === "stairs");
  assert(stairs && stairs.type === "rectangle", `secondFloor: missing/invalid firstFloor region 'stairs'`);

  // Detect driveway side (lot-local): left driveway has x0 == 0
  const [[drvX0]] = drivewayNear.points;
  const drivewayIsRight = drvX0 > 0.5;

  // Normalize X so driveway is always on the LEFT in "N-space"
  const nx = (x: number) => (drivewayIsRight ? xsize - x : x);
  const unx = (x: number) => (drivewayIsRight ? xsize - x : x);

  const polyN = houseRegion.points.map(([x, z]) => [nx(x), z] as [number, number]);

  // --- Footprint Z landmarks
  const zVals = uniqSorted(polyN.map((p) => p[1]));
  assert(zVals.length >= 2, `secondFloor: houseregion polygon z-values too small`);
  const zFrontBump = zVals[zVals.length - 1]!;
  const zFrontMain = zVals[zVals.length - 2]!;

  // Back "main" line is the minimum Z among vertices on lot boundaries x=0 or x=xsize
  const edgeBackCandidates = polyN
    .filter(([x]) => Math.abs(x - 0) < 1e-6 || Math.abs(x - xsize) < 1e-6)
    .map(([, z]) => z);
  assert(edgeBackCandidates.length > 0, `secondFloor: cannot determine back edge from houseregion polygon`);
  const zBackMain = Math.min(...edgeBackCandidates);

  const mainDepth = zFrontMain - zBackMain;
  assert(mainDepth >= 6.8, `secondFloor: unexpected shallow house main depth ${mainDepth.toFixed(2)}m`);

  // Bump span in N-space (after normalization bump is on the "right")
  const bumpXs = polyN.filter(([, z]) => Math.abs(z - zFrontBump) < 1e-6).map(([x]) => x);
  // If there is no bump line (degenerate), we still proceed; bump is only for room assignment in that zone.
  const bumpX0 = bumpXs.length >= 2 ? Math.min(...bumpXs) : xsize * 0.6;
  const bumpX1 = bumpXs.length >= 2 ? Math.max(...bumpXs) : xsize;

  // --- Stairwell must be congruent with first floor stairs
  const stairsN: Rect = (() => {
    const [[x0, z0], [x1, z1]] = stairs.points;
    return normRect({ x0: nx(x0), z0, x1: nx(x1), z1 });
  })();

  // Bedroom count constraints
  const occ = house.occupants.length;
  const minBedrooms = Math.ceil(occ / 2);
  const maxBedrooms = Math.min(3, minBedrooms + 1);
  assert(minBedrooms >= 1 && minBedrooms <= 3, `secondFloor: minBedrooms out of range: ${minBedrooms}`);
  assert(maxBedrooms >= minBedrooms && maxBedrooms <= 3, `secondFloor: maxBedrooms out of range: ${maxBedrooms}`);

  const bedroomCount =
    xsize <= 11.5 || minBedrooms === maxBedrooms ? minBedrooms : rng.bool(0.35) ? maxBedrooms : minBedrooms;

  // Closet count requirement: 1..3 (we may choose fewer than a "target" if space is awkward, but never <1)
  const closetTarget = clamp(bedroomCount - (rng.bool(0.35) ? 1 : 0), 1, 3);

  // --- Choose a mid split in Z
  const backMin = 4.4;
  const midDepthRaw = rng.float(3.8, 5.0);
  const midDepth = clamp(midDepthRaw, 3.0, Math.max(3.0, mainDepth - backMin));
  const zMid0 = zFrontMain - midDepth;
  assert(zMid0 - zBackMain >= backMin - 1e-3, `secondFloor: back zone too small`);

  // --- Hallway: ALWAYS along an exterior wall (prevents splitting rooms into disconnected components).
  const distLeft = stairsN.x0; // distance from stairs to left wall
  const distRight = xsize - stairsN.x1; // distance from stairs to right wall
  const hallWall: Wall = distLeft <= distRight ? "left" : "right";

  let hallW = clamp(rng.float(0.95, 1.35), 0.85, 1.6);
  // Keep reasonable interior width.
  hallW = clamp(hallW, 0.85, Math.max(0.85, xsize - 4.8));

  const hallStrip: Rect =
    hallWall === "left"
      ? normRect({ x0: 0, x1: hallW, z0: zBackMain, z1: zFrontMain })
      : normRect({ x0: xsize - hallW, x1: xsize, z0: zBackMain, z1: zFrontMain });

  const interiorX0 = hallWall === "left" ? hallW : 0;
  const interiorX1 = hallWall === "left" ? xsize : xsize - hallW;

  // Optional connector from hallway strip inner edge to stairwell (keeps circulation plausible).
  const connectorZ0 = clamp(stairsN.z0, zBackMain, zFrontMain);
  const connectorZ1 = clamp(stairsN.z1, zBackMain, zFrontMain);
  const hallConnector: Rect | null = (() => {
    if (connectorZ1 - connectorZ0 < 1.0 - 1e-6) return null;

    if (hallWall === "left") {
      // connect from inner edge (hallW) to stairs left edge (stairsN.x0)
      const x0 = hallW;
      const x1 = stairsN.x0;
      if (x1 - x0 > 0.25) return normRect({ x0, x1, z0: connectorZ0, z1: connectorZ1 });
      return null;
    } else {
      // connect from stairs right edge (stairsN.x1) to inner edge (xsize-hallW)
      const x0 = stairsN.x1;
      const x1 = xsize - hallW;
      if (x1 - x0 > 0.25) return normRect({ x0, x1, z0: connectorZ0, z1: connectorZ1 });
      return null;
    }
  })();

  // --- Room X split: prefer to align on a stairwell EDGE so the stairwell is never an internal "hole" in a room.
  const xSplit = pickSplitByStairsEdge(interiorX0, interiorX1, stairsN, 2.2);

  // --- Bathrooms on the wall OPPOSITE the hallway strip to keep hallway connected.
  const bathWall: Wall = hallWall === "left" ? "right" : "left";

  function rectOnWall(wall: Wall, w: number, z0: number, z1: number): Rect {
    if (wall === "left") return normRect({ x0: 0, x1: w, z0, z1 });
    return normRect({ x0: xsize - w, x1: xsize, z0, z1 });
  }

  // Large bath in back zone
  const bathLargeD = clamp(rng.float(2.4, 3.4), 2.0, Math.max(2.0, (zMid0 - zBackMain) - 1.4));
  const zBathLarge1 = zMid0 - 0.2;
  // Force a buffer behind the large bath for bedroom space (prevents accidental total carve-out).
  const zBathLarge0 = clamp(zBathLarge1 - bathLargeD, zBackMain + 1.0, zBathLarge1 - 1.4);

  // Make sure bath width fits inside at least one side of the split.
  const maxLeftSpan = Math.max(1.8, xSplit - interiorX0 - 0.4);
  const maxRightSpan = Math.max(1.8, interiorX1 - xSplit - 0.4);

  const bathLargeW = clamp(rng.float(2.2, 3.0), 1.8, bathWall === "left" ? maxLeftSpan : maxRightSpan);
  let bathLargeRect = rectOnWall(bathWall, bathLargeW, zBathLarge0, zBathLarge1);

  // Small bath in front zone
  const bathSmallD = clamp(rng.float(1.6, 2.2), 1.2, Math.max(1.2, midDepth - 0.8));
  const zSmallMin = zMid0 + 0.2;
  const zSmallMax = zFrontMain - 0.25 - bathSmallD;
  const zBathSmall0 = zSmallMin <= zSmallMax ? clamp(rng.float(zSmallMin, zSmallMax), zSmallMin, zSmallMax) : zSmallMin;
  const zBathSmall1 = zBathSmall0 + bathSmallD;

  const bathSmallW = clamp(rng.float(1.4, 1.9), 1.2, bathWall === "left" ? maxLeftSpan : maxRightSpan);
  let bathSmallRect = rectOnWall(bathWall, bathSmallW, zBathSmall0, zBathSmall1);

  // Ensure baths do not overlap stairwell; if they do, shift in Z within their band.
  function shiftBathAwayFromStairs(bath: Rect, bandZ0: number, bandZ1: number, depth: number): Rect {
    if (!rectIntersects(bath, stairsN)) return bath;

    // Try placing it at the other end of the band
    const altZ0 = clamp(bandZ1 - depth - 0.2, bandZ0 + 0.2, bandZ1 - depth - 0.2);
    const alt = normRect({ ...bath, z0: altZ0, z1: altZ0 + depth });
    if (!rectIntersects(alt, stairsN)) return alt;

    // Final fallback: keep it but shrink width to avoid overlap (since stairwell overlap is usually in X)
    const shrunkW = Math.max(1.2, (bath.x1 - bath.x0) * 0.7);
    return rectOnWall(bathWall, shrunkW, bath.z0, bath.z1);
  }

  bathLargeRect = shiftBathAwayFromStairs(bathLargeRect, zBackMain, zMid0, bathLargeD);
  bathSmallRect = shiftBathAwayFromStairs(bathSmallRect, zMid0, zFrontMain, bathSmallD);

  // --- Closets: place adjacent to the INNER edge of the hallway strip (so they carve from room edges, not create holes).
  const placedClosets: Array<{ name: string; rect: Rect }> = [];

  function closetRectAtZ(z0: number, z1: number, w: number): Rect {
    if (hallWall === "left") {
      return normRect({ x0: hallW, x1: hallW + w, z0, z1 });
    }
    // hallway on right: inner edge is xsize - hallW
    const x1 = xsize - hallW;
    return normRect({ x0: x1 - w, x1, z0, z1 });
  }

  const avoidForClosetsBase: Rect[] = [stairsN, bathLargeRect, bathSmallRect, hallStrip, ...(hallConnector ? [hallConnector] : [])];

  function tryPlaceCloset(name: string, zBand0: number, zBand1: number, avoidExtra: Rect[]): Rect | null {
    const maxTries = 12;
    const avoid = [...avoidForClosetsBase, ...avoidExtra];

    for (let t = 0; t < maxTries; t++) {
      const cw = clamp(rng.float(1.0, 1.7), 0.9, 2.0);
      const cd = clamp(rng.float(1.0, 1.6), 0.9, Math.max(0.9, (zBand1 - zBand0) - 0.2));
      const z0min = zBand0 + 0.15;
      const z0max = zBand1 - 0.15 - cd;

      if (z0max <= z0min + EPS) continue;

      const z0 = clamp(rng.float(z0min, z0max), z0min, z0max);
      const z1 = z0 + cd;

      const r = closetRectAtZ(z0, z1, cw);

      if (r.x1 - r.x0 < 0.8 || r.z1 - r.z0 < 0.8) continue;

      // Must sit inside the footprint (sample a couple points)
      const mx = (r.x0 + r.x1) * 0.5;
      const mz = (r.z0 + r.z1) * 0.5;
      if (!pointInPoly(mx, mz, polyN)) continue;
      if (!pointInPoly(r.x0 + 0.05, r.z0 + 0.05, polyN)) continue;
      if (!pointInPoly(r.x1 - 0.05, r.z1 - 0.05, polyN)) continue;

      // Must not overlap forbidden rectangles
      let ok = true;
      for (const a of avoid) {
        if (rectIntersects(r, a)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      return r;
    }

    return null;
  }

  // Place closets in separated Z bands so they never overlap each other and stay realistic.
  // Back band: close to rear bedrooms
  const backClosetBand0 = zBackMain;
  const backClosetBand1 = Math.max(zBackMain + 1.8, Math.min(zMid0, stairsN.z0 - 0.2));

  // Front band: near front rooms
  const frontClosetBand0 = Math.min(zFrontMain - 2.2, Math.max(zMid0 + 0.2, stairsN.z1 + 0.2));
  const frontClosetBand1 = zFrontMain;

  // Middle band (optional third)
  const midClosetBand0 = Math.max(zBackMain + 1.8, Math.min(zMid0, stairsN.z0 - 0.2));
  const midClosetBand1 = Math.min(zFrontMain - 2.2, Math.max(zMid0 + 0.2, stairsN.z1 + 0.2));

  function placeClosetGuaranteed(name: string, z0: number, z1: number, avoidExtra: Rect[]): Rect {
    const r = tryPlaceCloset(name, z0, z1, avoidExtra);
    if (r) return r;

    // Fallback: deterministic "safe" slot at the start of the band (still respecting constraints as much as possible).
    const w = 1.1;
    const d = 1.1;
    const zz0 = clamp(z0 + 0.2, z0 + 0.2, Math.max(z0 + 0.2, z1 - 0.2 - d));
    const rr = closetRectAtZ(zz0, zz0 + d, w);

    // If fallback overlaps something, shrink depth until it fits (never below 0.8m), otherwise accept.
    let best = rr;
    for (let k = 0; k < 6; k++) {
      let bad = false;
      for (const a of [...avoidForClosetsBase, ...avoidExtra]) {
        if (rectIntersects(best, a)) {
          bad = true;
          break;
        }
      }
      if (!bad && pointInPoly((best.x0 + best.x1) * 0.5, (best.z0 + best.z1) * 0.5, polyN)) return best;

      const depth = Math.max(0.8, (best.z1 - best.z0) * 0.85);
      best = closetRectAtZ(best.z0, best.z0 + depth, Math.max(0.9, (best.x1 - best.x0) * 0.9));
    }
    return best;
  }

  // Always place at least one closet (requirements: min 1)
  placedClosets.push({ name: "closet1", rect: placeClosetGuaranteed("closet1", backClosetBand0, backClosetBand1, []) });

  if (closetTarget >= 2) {
    placedClosets.push({
      name: "closet2",
      rect: placeClosetGuaranteed("closet2", frontClosetBand0, frontClosetBand1, placedClosets.map((c) => c.rect)),
    });
  }

  if (closetTarget >= 3) {
    // Prefer a mid-band closet if it has room; otherwise put another in the back band at a different slot.
    const useMid = midClosetBand1 - midClosetBand0 >= 1.6;
    const z0 = useMid ? midClosetBand0 : backClosetBand0;
    const z1 = useMid ? midClosetBand1 : backClosetBand1;
    placedClosets.push({
      name: "closet3",
      rect: placeClosetGuaranteed("closet3", z0, z1, placedClosets.map((c) => c.rect)),
    });
  }

  // --- Build grid cuts
  const xCuts = uniqSorted([
    ...polyN.map((p) => p[0]),
    0,
    xsize,
    interiorX0,
    interiorX1,
    xSplit,
    bumpX0,
    bumpX1,
    stairsN.x0,
    stairsN.x1,
    hallStrip.x0,
    hallStrip.x1,
    hallConnector ? hallConnector.x0 : 0,
    hallConnector ? hallConnector.x1 : 0,
    bathLargeRect.x0,
    bathLargeRect.x1,
    bathSmallRect.x0,
    bathSmallRect.x1,
    ...placedClosets.flatMap((c) => [c.rect.x0, c.rect.x1]),
  ]).filter((v) => v >= -EPS && v <= xsize + EPS);

  const zCuts = uniqSorted([
    ...polyN.map((p) => p[1]),
    0,
    30,
    zBackMain,
    zMid0,
    zFrontMain,
    zFrontBump,
    stairsN.z0,
    stairsN.z1,
    bathLargeRect.z0,
    bathLargeRect.z1,
    bathSmallRect.z0,
    bathSmallRect.z1,
    ...(hallConnector ? [hallConnector.z0, hallConnector.z1] : []),
    ...placedClosets.flatMap((c) => [c.rect.z0, c.rect.z1]),
  ]).filter((v) => v >= -EPS && v <= 30 + EPS);

  const nxCells = xCuts.length - 1;
  const nzCells = zCuts.length - 1;
  assert(nxCells >= 1 && nzCells >= 1, `secondFloor: invalid grid`);

  function cellRect(ix: number, iz: number): Rect {
    return { x0: xCuts[ix]!, x1: xCuts[ix + 1]!, z0: zCuts[iz]!, z1: zCuts[iz + 1]! };
  }
  function cellMid(r: Rect): { x: number; z: number } {
    return { x: (r.x0 + r.x1) * 0.5, z: (r.z0 + r.z1) * 0.5 };
  }

  const bedroomNames = Array.from({ length: bedroomCount }, (_, i) => `bedroom${i + 1}`);
  const closetNames = placedClosets.map((c) => c.name);

  function isLeftSide(xc: number): boolean {
    return xc < xSplit - EPS;
  }

  function classifyCell(xc: number, zc: number): string {
    if (!pointInPoly(xc, zc, polyN)) return "__out";

    // Priority: most specific first
    if (rectContains(stairsN, xc, zc)) return "stairwell";
    if (rectContains(bathLargeRect, xc, zc)) return "bathroom_large";
    if (rectContains(bathSmallRect, xc, zc)) return "bathroom_small";

    for (const c of placedClosets) {
      if (rectContains(c.rect, xc, zc)) return c.name;
    }

    if (rectContains(hallStrip, xc, zc) || (hallConnector ? rectContains(hallConnector, xc, zc) : false)) {
      return "hallway";
    }

    // Bump zone (front protrusion)
    if (zc >= zFrontMain - EPS) {
      // Only right side exists in the footprint in this zone; keep it consistent.
      if (bedroomCount === 3) return "bedroom3";
      return "office";
    }

    // Main front zone
    if (zc >= zMid0 - EPS) {
      if (bedroomCount === 3) {
        return isLeftSide(xc) ? "office" : "bedroom3";
      }
      // bedroomCount 1 or 2
      return isLeftSide(xc) ? "bedroom1" : "office";
    }

    // Back zone (includes rear extension where z < zBackMain)
    if (bedroomCount === 1) return "bedroom1";
    return isLeftSide(xc) ? "bedroom1" : "bedroom2";
  }

  // Assign each cell to a region name (or "__out")
  const cellRegion: string[][] = Array.from({ length: nxCells }, () => Array.from({ length: nzCells }, () => "__out"));

  let footprintArea = 0;
  let assignedArea = 0;

  for (let ix = 0; ix < nxCells; ix++) {
    for (let iz = 0; iz < nzCells; iz++) {
      const r = cellRect(ix, iz);
      if (r.x1 - r.x0 <= EPS || r.z1 - r.z0 <= EPS) continue;
      const { x: xc, z: zc } = cellMid(r);

      if (!pointInPoly(xc, zc, polyN)) {
        cellRegion[ix]![iz] = "__out";
        continue;
      }

      footprintArea += rectArea(r);

      const nm = classifyCell(xc, zc);
      cellRegion[ix]![iz] = nm;
      assignedArea += rectArea(r);
    }
  }

  // Sanity: coverage
  const areaDiff = Math.abs(assignedArea - footprintArea);
  assert(
    areaDiff < Math.max(0.75, footprintArea * 0.0015),
    `secondFloor: footprint not fully covered (diff=${areaDiff.toFixed(3)}m^2)`
  );

  // Force-assign guaranteed rectangles (prevents rare "empty due to split/cut" cases)
  function forceAssignIntoRect(name: string, rr: Rect) {
    const r = normRect(rr);
    if (r.x1 - r.x0 <= EPS || r.z1 - r.z0 <= EPS) return;

    for (let ix = 0; ix < nxCells; ix++) {
      for (let iz = 0; iz < nzCells; iz++) {
        const cr = cellRect(ix, iz);
        const m = cellMid(cr);
        if (!pointInPoly(m.x, m.z, polyN)) continue;
        if (rectContains(r, m.x, m.z)) {
          cellRegion[ix]![iz] = name;
        }
      }
    }
  }

  forceAssignIntoRect("stairwell", stairsN);
  forceAssignIntoRect("bathroom_large", bathLargeRect);
  forceAssignIntoRect("bathroom_small", bathSmallRect);
  forceAssignIntoRect("hallway", hallStrip);
  if (hallConnector) forceAssignIntoRect("hallway", hallConnector);
  for (const c of placedClosets) forceAssignIntoRect(c.name, c.rect);

  // Collect rectangles by region label (from grid cells)
  function buildRectsByRegion(): Map<string, Rect[]> {
    const m = new Map<string, Rect[]>();
    for (let ix = 0; ix < nxCells; ix++) {
      for (let iz = 0; iz < nzCells; iz++) {
        const nm = cellRegion[ix]![iz]!;
        if (nm === "__out") continue;

        const r = cellRect(ix, iz);
        const mid = cellMid(r);
        if (!pointInPoly(mid.x, mid.z, polyN)) continue;

        const arr = m.get(nm);
        if (arr) arr.push(r);
        else m.set(nm, [r]);
      }
    }
    return m;
  }

  const rectsByRegion = buildRectsByRegion();

  // Validate required regions exist
  const required = ["office", "bathroom_large", "bathroom_small", "stairwell", "hallway"] as const;
  for (const nm of required) {
    const rects = rectsByRegion.get(nm);
    assert(rects && rects.length > 0, `secondFloor: required region '${nm}' ended up empty`);
  }

  // Validate bedrooms exist
  for (const nm of bedroomNames) {
    const rects = rectsByRegion.get(nm);
    assert(rects && rects.length > 0, `secondFloor: bedroom region '${nm}' ended up empty`);
  }

  // Validate closets exist and count is within spec (1..3)
  assert(closetNames.length >= 1 && closetNames.length <= 3, `secondFloor: closet count invalid`);
  for (const nm of closetNames) {
    const rects = rectsByRegion.get(nm);
    assert(rects && rects.length > 0, `secondFloor: closet region '${nm}' ended up empty`);
  }

  // Ensure hallway connects to stairwell (shared boundary >= 1m)
  const hallStair = sharedBoundaryLengthFromCells(xCuts, zCuts, cellRegion, "hallway", "stairwell");
  assert(hallStair >= 1.0 - 1e-3, `secondFloor: hallway not connected to stairwell (shared=${hallStair.toFixed(3)}m)`);

  // --- Convert regions back to lot-local space
  function unRect(r: Rect): Rect {
    const rr = normRect(r);
    const a = unx(rr.x0);
    const b = unx(rr.x1);
    return normRect({ x0: a, z0: rr.z0, x1: b, z1: rr.z1 });
  }

  function unPoint([x, z]: [number, number]): [number, number] {
    return [unx(x), z];
  }

  function regionFromCells(name: string, surface: Region["surface"]): Region {
    const rectsN = rectsByRegion.get(name) ?? [];
    assert(rectsN.length > 0, `secondFloor: region '${name}' empty at build time`);

    if (name === "stairwell") {
      // Must be congruent with first-floor stairs: output that exact rectangle in lot-local space.
      const [[x0, z0], [x1, z1]] = stairs.points;
      return rectRegion("stairwell", surface, x0, z0, x1, z1);
    }

    const regionN = unionRectsToRegion(name, surface, rectsN);

    if (regionN.type === "rectangle") {
      const [[x0, z0], [x1, z1]] = regionN.points;
      const r = unRect({ x0, z0, x1, z1 });
      return rectRegion(name, surface, r.x0, r.z0, r.x1, r.z1);
    }

    return polyRegion(name, surface, regionN.points.map(unPoint));
  }

  const surface: Record<string, Region["surface"]> = {
    hallway: "wood_medium",
    stairwell: "wood_medium",
    office: "wood_medium",
    bathroom_large: "tile_medium",
    bathroom_small: "tile_medium",
    bedroom1: "wood_medium",
    bedroom2: "wood_medium",
    bedroom3: "wood_medium",
    closet1: "wood_medium",
    closet2: "wood_medium",
    closet3: "wood_medium",
  };

  const regions: Region[] = [];

  // Required (exactly one each)
  for (const nm of required) {
    regions.push(regionFromCells(nm, surface[nm]));
  }

  // Bedrooms
  for (const nm of bedroomNames) {
    regions.push(regionFromCells(nm, surface[nm]));
  }

  // Closets
  for (const nm of closetNames) {
    regions.push(regionFromCells(nm, surface[nm]));
  }

  // Final sanity: stairwell congruence check (lot-local)
  {
    const stairwell = regions.find((r) => r.name === "stairwell");
    assert(stairwell && stairwell.type === "rectangle", `secondFloor: stairwell missing/invalid after build`);
    const [[sx0, sz0], [sx1, sz1]] = stairwell.points;
    const [[fx0, fz0], [fx1, fz1]] = stairs.points;
    assert(
      Math.abs(sx0 - fx0) < 1e-6 &&
        Math.abs(sz0 - fz0) < 1e-6 &&
        Math.abs(sx1 - fx1) < 1e-6 &&
        Math.abs(sz1 - fz1) < 1e-6,
      `secondFloor: stairwell is not congruent with firstFloor stairs`
    );
  }

  // Final coordinate sanity (lot-local bounds)
  for (const r of regions) {
    const pts = r.type === "rectangle" ? [r.points[0], r.points[1]] : r.points;
    for (const [x, z] of pts) {
      assert(x >= -EPS && x <= xsize + EPS, `secondFloor: region '${r.name}' has x out of bounds: ${x}`);
      assert(z >= -EPS && z <= 30 + EPS, `secondFloor: region '${r.name}' has z out of bounds: ${z}`);
    }
  }

  return { regions, construction: [], objects: [] };
}
