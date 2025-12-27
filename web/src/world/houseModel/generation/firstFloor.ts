import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region } from "../types";
import type { HouseGenContext } from "./context";

const EPS = 1e-6;

type Rect = { x0: number; z0: number; x1: number; z1: number };

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
  assert(rs.length > 0, `firstFloor: region '${name}' has no area`);

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

  assert(edges.size >= 4, `firstFloor: region '${name}' boundary is degenerate`);

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
    assert(nbs.length === 2, `firstFloor: region '${name}' boundary not simple at ${pt} (deg=${nbs.length})`);
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
    if (loop.length > 5000) throw new Error(`firstFloor: region '${name}' boundary loop runaway`);
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

  assert(pts.length >= 4, `firstFloor: region '${name}' simplified boundary too small`);

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

export function generateFirstFloorModel(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel): FloorModel {
  const { rng, xsize } = ctx;

  const houseRegion = plot.regions.find((r) => r.name === "houseregion");
  const drivewayNear = plot.regions.find((r) => r.name === "driveway_near");
  const walkway = plot.regions.find((r) => r.name === "walkway");

  assert(houseRegion, `firstFloor: missing plot region 'houseregion' for house ${house.houseNumber}`);
  assert(drivewayNear && drivewayNear.type === "rectangle", `firstFloor: missing/invalid plot region 'driveway_near'`);
  assert(walkway && walkway.type === "rectangle", `firstFloor: missing/invalid plot region 'walkway'`);
  assert(houseRegion.type === "polygon", `firstFloor: expected houseregion polygon (plot.ts generates polygon)`);

  // Detect driveway side (lot-local): left driveway has x0 == 0
  const [[drvX0]] = drivewayNear.points;
  const drivewayIsRight = drvX0 > 0.5;

  // Normalize X so driveway is always on the LEFT in "N-space"
  const nx = (x: number) => (drivewayIsRight ? xsize - x : x);
  const unx = (x: number) => (drivewayIsRight ? xsize - x : x);

  const drvN: Rect = (() => {
    const [[x0, z0], [x1, z1]] = drivewayNear.points;
    return normRect({ x0: nx(x0), z0, x1: nx(x1), z1 });
  })();

  const walkN: Rect = (() => {
    const [[x0, z0], [x1, z1]] = walkway.points;
    return normRect({ x0: nx(x0), z0, x1: nx(x1), z1 });
  })();

  const polyN = houseRegion.points.map(([x, z]) => [nx(x), z] as [number, number]);

  // --- Extract key footprint Z values
  const zVals = uniqSorted(polyN.map((p) => p[1]));
  assert(zVals.length >= 2, `firstFloor: houseregion polygon z-values too small`);
  const zFrontBump = zVals[zVals.length - 1]!;
  const zFrontMain = zVals[zVals.length - 2]!;

  // Back "main" line is the minimum Z among vertices on lot boundaries x=0 or x=xsize
  const edgeBackCandidates = polyN
    .filter(([x]) => Math.abs(x - 0) < 1e-6 || Math.abs(x - xsize) < 1e-6)
    .map(([, z]) => z);
  assert(edgeBackCandidates.length > 0, `firstFloor: cannot determine back edge from houseregion polygon`);
  const zBackMain = Math.min(...edgeBackCandidates);

  const mainDepth = zFrontMain - zBackMain;
  assert(mainDepth >= 7.5, `firstFloor: unexpected shallow house main depth ${mainDepth.toFixed(2)}m`);

  // Bump span: at zFrontBump, take min/max X of points
  const bumpXs = polyN.filter(([, z]) => Math.abs(z - zFrontBump) < 1e-6).map(([x]) => x);
  assert(bumpXs.length >= 2, `firstFloor: cannot find bump edge at zFrontBump`);
  const bumpX0 = Math.min(...bumpXs);
  const bumpX1 = Math.max(...bumpXs);
  const bumpW = bumpX1 - bumpX0;

  // Driveway width in normalized space
  const xDriveW = drvN.x1;
  assert(xDriveW > 2.6 && xDriveW < xsize - 1.8, `firstFloor: driveway width out of expected range`);

  // --- Choose key bands in Z (ERROR-PROOF margins)
  // We enforce: backBandDepth >= 1.2 and midBandDepth >= 2.2
  // by constraining garage depth accordingly.
  const BACK_MIN = 1.2;
  const MID_MIN = 2.2;

  // pick garage depth but ensure enough remains behind it
  const garageDepthRaw = rng.float(5.6, 7.2);
  const garageDepthMax = Math.max(4.2, mainDepth - (BACK_MIN + MID_MIN)); // leave >= BACK_MIN + MID_MIN
  const garageDepth = clamp(garageDepthRaw, 4.2, garageDepthMax);
  const zGarageBack = zFrontMain - garageDepth;

  const behindDepth = zGarageBack - zBackMain;
  assert(
    behindDepth >= BACK_MIN + MID_MIN - 1e-4,
    `firstFloor: insufficient depth behind garage (behindDepth=${behindDepth.toFixed(3)})`
  );

  // back band depth (kitchen/dining)
  const backBandRaw = rng.float(3.4, 4.8);
  const backBandMax = Math.max(BACK_MIN, behindDepth - MID_MIN);
  const backBandDepth = clamp(backBandRaw, BACK_MIN, backBandMax);
  const zDiningFront = zBackMain + backBandDepth;

  const midDepth = zGarageBack - zDiningFront;
  assert(midDepth >= MID_MIN - 1e-4, `firstFloor: mid band too small (midDepth=${midDepth.toFixed(3)})`);

  // --- Horizontal planning (normalized X)
  // Hallway strip (xDriveW..xHall1). Ensure foyer->living shared >= 1m.
  let hallW = clamp(rng.float(0.75, 1.2), 0.65, 1.4);

  // Ensure living has >=1m along the foyer back edge:
  // foyer spans bumpX0..bumpX1 at zFrontMain..zFrontBump, living begins at xHall1..bumpX1
  // => bumpX1 - xHall1 >= 1  -> hallW <= bumpW - 1
  const hallWMaxByFoyer = Math.max(0.65, bumpW - 1.0);
  hallW = clamp(hallW, 0.65, hallWMaxByFoyer);

  const xHall0 = xDriveW;
  const xHall1 = clamp(xHall0 + hallW, xHall0 + 0.65, Math.min(xsize - 2.0, bumpX1 - 1.0));

  // Kitchen/dining split (leave some dining width)
  const availableRight = xsize - xHall1;

  let minKitchenW = 1.6;
  let minDiningW = 2.2;

  if (availableRight < minKitchenW + minDiningW) {
    const shortage = minKitchenW + minDiningW - availableRight;
    minDiningW = Math.max(1.2, minDiningW - shortage * 0.7);
    minKitchenW = Math.max(1.2, minKitchenW - shortage * 0.3);
  }

  const xKitchenRightMin = xHall1 + minKitchenW;
  const xKitchenRightMax = xsize - minDiningW;
  const xKitchenRight =
    xKitchenRightMin <= xKitchenRightMax
      ? clamp(rng.float(xKitchenRightMin, xKitchenRightMax), xKitchenRightMin, xKitchenRightMax)
      : (xKitchenRightMin + xKitchenRightMax) * 0.5;

  // --- Stairs: must be a rectangle region; place it against a boundary to avoid holes in other regions.
  // Prefer placing in the kitchen slice adjacent to hallway (touches x=xHall1), otherwise place against the right exterior wall.
  const kitchenSliceW = xKitchenRight - xHall1;
  const stairsWRaw = rng.float(1.6, 2.2);

  let stairsRect: Rect;

  const zStairs0Min = zDiningFront + 0.25;
  const zStairs1Max = zGarageBack - 0.25;

  let stairsD = clamp(rng.float(2.8, 3.6), 1.6, Math.max(1.6, zStairs1Max - zStairs0Min - 0.05));
  if (stairsD > zStairs1Max - zStairs0Min) stairsD = Math.max(1.2, zStairs1Max - zStairs0Min);

  const stairsZSlack = Math.max(0, (zStairs1Max - zStairs0Min) - stairsD);
  const zStairs0 = zStairs0Min + rng.float(0, stairsZSlack);
  const zStairs1 = zStairs0 + stairsD;

  if (kitchenSliceW >= 2.2) {
    const stairsW = clamp(stairsWRaw, 1.2, Math.max(1.2, kitchenSliceW - 0.6));
    stairsRect = { x0: xHall1, z0: zStairs0, x1: xHall1 + stairsW, z1: zStairs1 };
    // Ensure we didn't cross into dining (keep >=0.3m kitchen after stairs on this edge)
    if (stairsRect.x1 > xKitchenRight - 0.3) {
      stairsRect = { ...stairsRect, x1: xKitchenRight - 0.3 };
    }
  } else {
    const livingW = xsize - xKitchenRight;
    const stairsW = clamp(stairsWRaw, 1.2, Math.max(1.2, livingW - 0.6));
    stairsRect = { x0: xsize - stairsW, z0: zStairs0, x1: xsize, z1: zStairs1 };
    // Ensure stairs stays fully on the right side and doesn't invade the split too much
    if (stairsRect.x0 < xKitchenRight + 0.3) {
      stairsRect = { ...stairsRect, x0: xKitchenRight + 0.3 };
    }
  }

  stairsRect = normRect(stairsRect);
  assert(stairsRect.x1 - stairsRect.x0 >= 0.8, `firstFloor: stairs width too small`);
  assert(stairsRect.z1 - stairsRect.z0 >= 1.0, `firstFloor: stairs depth too small`);

  // --- Bathroom: place along the left exterior wall (x=0) in the mid band to avoid holes
  const bathW = clamp(rng.float(1.4, 1.9), 1.2, Math.min(2.2, xDriveW - 0.2));
  const bathD = clamp(rng.float(1.6, 2.2), 1.2, Math.max(1.2, midDepth - 0.6));

  // Place it closer to the garage (common powder room placement)
  const zBath1 = zGarageBack - 0.3;
  const zBath0 = clamp(zBath1 - bathD, zDiningFront + 0.25, zBath1 - 1.0);
  const bathRect: Rect = normRect({ x0: 0, z0: zBath0, x1: bathW, z1: zBath1 });

  // --- Optional regions: exactly 2 (robust). Always laundry; second is pantry if it fits, else utility.
  const laundryW = clamp(rng.float(1.8, 2.6), 1.2, Math.min(2.8, xDriveW - 0.2));
  const laundryD = clamp(rng.float(1.6, 2.4), 1.0, Math.max(1.0, backBandDepth - 0.2));

  const laundryRect: Rect = normRect({
    x0: 0,
    z0: clamp(zDiningFront - laundryD, zBackMain + 0.05, zDiningFront - 1.0),
    x1: laundryW,
    z1: zDiningFront,
  });

  const pantryFits = kitchenSliceW >= 1.8;

  const pantryW = clamp(rng.float(1.1, 1.6), 0.9, Math.max(0.9, kitchenSliceW - 0.6));
  const pantryD = clamp(rng.float(1.2, 1.8), 1.0, Math.max(1.0, backBandDepth - 0.3));

  const pantryRect: Rect = pantryFits
    ? normRect({
        x0: xHall1,
        z0: zBackMain,
        x1: Math.min(xHall1 + pantryW, xKitchenRight - 0.4), // IMPORTANT: do NOT touch xKitchenRight
        z1: Math.min(zBackMain + pantryD, zDiningFront - 0.2),
      })
    : normRect({ x0: 0, z0: 0, x1: 0, z1: 0 }); // unused

  const utilityRect: Rect = !pantryFits
    ? normRect({
        x0: 0,
        z0: zDiningFront,
        x1: clamp(rng.float(1.0, 1.6), 0.9, Math.min(1.8, xDriveW - 0.2)),
        z1: clamp(zDiningFront + rng.float(1.0, 1.8), zDiningFront + 0.9, zGarageBack - 0.4),
      })
    : normRect({ x0: 0, z0: 0, x1: 0, z1: 0 }); // unused

  // --- Required rectangles
  const garageRect: Rect = normRect({ x0: 0, z0: zGarageBack, x1: xDriveW, z1: zFrontMain });

  // Hallway strip covers from back band front to front main
  const hallwayRect: Rect = normRect({ x0: xHall0, z0: zDiningFront, x1: xHall1, z1: zFrontMain });

  // Foyer occupies the entire bump zone (ensures walkway connection)
  const foyerRect: Rect = normRect({ x0: bumpX0, z0: zFrontMain, x1: bumpX1, z1: zFrontBump });

  // --- Build grid cuts (polygon vertices + all planned rectangle boundaries + key split lines)
  const xCuts = uniqSorted([
    ...polyN.map((p) => p[0]),
    0,
    xsize,
    xDriveW,
    xHall1,
    xKitchenRight,
    // rectangles
    garageRect.x0,
    garageRect.x1,
    hallwayRect.x0,
    hallwayRect.x1,
    foyerRect.x0,
    foyerRect.x1,
    stairsRect.x0,
    stairsRect.x1,
    bathRect.x0,
    bathRect.x1,
    laundryRect.x0,
    laundryRect.x1,
    pantryRect.x0,
    pantryRect.x1,
    utilityRect.x0,
    utilityRect.x1,
  ]).filter((v) => v >= -EPS && v <= xsize + EPS);

  const zCuts = uniqSorted([
    ...polyN.map((p) => p[1]),
    0,
    30,
    zBackMain,
    zDiningFront,
    zGarageBack,
    zFrontMain,
    zFrontBump,
    stairsRect.z0,
    stairsRect.z1,
    bathRect.z0,
    bathRect.z1,
    laundryRect.z0,
    laundryRect.z1,
    pantryRect.z0,
    pantryRect.z1,
    utilityRect.z0,
    utilityRect.z1,
  ]).filter((v) => v >= -EPS && v <= 30 + EPS);

  const nxCells = xCuts.length - 1;
  const nzCells = zCuts.length - 1;
  assert(nxCells >= 1 && nzCells >= 1, `firstFloor: invalid grid`);

  function cellRect(ix: number, iz: number): Rect {
    return { x0: xCuts[ix]!, x1: xCuts[ix + 1]!, z0: zCuts[iz]!, z1: zCuts[iz + 1]! };
  }
  function cellMid(r: Rect): { x: number; z: number } {
    return { x: (r.x0 + r.x1) * 0.5, z: (r.z0 + r.z1) * 0.5 };
  }

  // Assign each cell to a region name (or "__out")
  const cellRegion: string[][] = Array.from({ length: nxCells }, () => Array.from({ length: nzCells }, () => "__out"));

  function classifyCell(xc: number, zc: number): string {
    if (!pointInPoly(xc, zc, polyN)) return "__out";

    // rear extension (z < zBackMain) belongs to kitchen/dining based on the same split (keeps connectivity)
    if (zc < zBackMain - EPS) {
      return xc < xKitchenRight - EPS ? "kitchen" : "dining";
    }

    // bump zone
    if (zc >= zFrontMain - EPS) return "foyer";

    // front band (garage line to front main)
    if (zc >= zGarageBack - EPS) {
      if (xc < xDriveW - EPS) return "garage";
      if (xc < xHall1 - EPS) return "hallway";
      return "livingroom";
    }

    // mid band
    if (zc >= zDiningFront - EPS) {
      if (rectContains(stairsRect, xc, zc)) return "stairs";
      if (rectContains(bathRect, xc, zc)) return "bathroom_small";
      if (!pantryFits && rectContains(utilityRect, xc, zc)) return "utility";
      if (xc < xHall1 - EPS) return "hallway";
      // kitchen runs up to split in mid band; living to the right
      if (xc < xKitchenRight - EPS) return "kitchen";
      return "livingroom";
    }

    // back band
    if (rectContains(laundryRect, xc, zc)) return "laundry";
    if (pantryFits && rectContains(pantryRect, xc, zc)) return "pantry";
    if (xc < xKitchenRight - EPS) return "kitchen";
    return "dining";
  }

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
      assert(nm !== "__out", `firstFloor: internal classification produced '__out' inside footprint`);
      cellRegion[ix]![iz] = nm;
      assignedArea += rectArea(r);
    }
  }

  // Area coverage sanity
  const areaDiff = Math.abs(assignedArea - footprintArea);
  assert(areaDiff < Math.max(0.75, footprintArea * 0.0015), `firstFloor: footprint not fully covered (Δ=${areaDiff.toFixed(3)}m²)`);

  // --- Enforce kitchen/dining interface in the back band (ERROR-PROOF >= 1m shared boundary)
  // Find split index where xCuts[ix] == xKitchenRight
  const splitIx = (() => {
    for (let i = 0; i < xCuts.length; i++) {
      if (Math.abs(xCuts[i]! - xKitchenRight) < 1e-6) return i;
    }
    return -1;
  })();
  assert(splitIx > 0 && splitIx < xCuts.length - 1, `firstFloor: could not locate xKitchenRight in xCuts`);

  for (let iz = 0; iz < nzCells; iz++) {
    const r = cellRect(Math.max(0, splitIx - 1), iz);
    const zc = (r.z0 + r.z1) * 0.5;
    if (zc < zBackMain - EPS || zc > zDiningFront + EPS) continue; // only back band

    const leftIx = splitIx - 1;
    const rightIx = splitIx;

    if (leftIx < 0 || rightIx >= nxCells) continue;

    const rl = cellRect(leftIx, iz);
    const rr = cellRect(rightIx, iz);

    const ml = cellMid(rl);
    const mr = cellMid(rr);

    if (pointInPoly(ml.x, ml.z, polyN) && pointInPoly(mr.x, mr.z, polyN)) {
      // Force the immediate interface cells to be kitchen and dining.
      // This guarantees shared boundary length ~= backBandDepth (>= 1.2m).
      cellRegion[leftIx]![iz] = "kitchen";
      cellRegion[rightIx]![iz] = "dining";
    }
  }

  // --- Force-assign required/optional rectangles into their own labels (ensures non-empty)
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

  forceAssignIntoRect("stairs", stairsRect);
  forceAssignIntoRect("bathroom_small", bathRect);
  forceAssignIntoRect("garage", garageRect);
  forceAssignIntoRect("foyer", foyerRect);
  forceAssignIntoRect("laundry", laundryRect);
  if (pantryFits) forceAssignIntoRect("pantry", pantryRect);
  else forceAssignIntoRect("utility", utilityRect);

  // --- Collect rectangles by region label (from grid cells)
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

  // --- Validate required regions exist
  const required = ["foyer", "garage", "livingroom", "kitchen", "dining", "bathroom_small", "stairs", "hallway"] as const;
  for (const nm of required) {
    const rects = rectsByRegion.get(nm);
    assert(rects && rects.length > 0, `firstFloor: required region '${nm}' ended up empty`);
  }

  // --- Validate optional count (exactly 2) and existence
  const optional = pantryFits ? (["laundry", "pantry"] as const) : (["laundry", "utility"] as const);
  for (const nm of optional) {
    const rects = rectsByRegion.get(nm);
    assert(rects && rects.length > 0, `firstFloor: optional region '${nm}' ended up empty`);
  }

  // --- Connectivity constraints from requirements
  // foyer <-> walkway (external): shared X length where walkway meets bump front edge
  const sharedFoyerWalk = Math.max(0, Math.min(foyerRect.x1, walkN.x1) - Math.max(foyerRect.x0, walkN.x0));
  assert(sharedFoyerWalk >= 1.0 - 1e-3, `firstFloor: foyer not connected to walkway (shared=${sharedFoyerWalk.toFixed(3)}m)`);

  // garage <-> driveway_near (external): shared X length at zFrontMain (same as driveway width)
  const sharedGarageDrive = Math.max(0, Math.min(garageRect.x1, drvN.x1) - Math.max(garageRect.x0, drvN.x0));
  assert(sharedGarageDrive >= 1.0 - 1e-3, `firstFloor: garage not connected to driveway (shared=${sharedGarageDrive.toFixed(3)}m)`);

  // foyer <-> livingroom (internal)
  const foyerLiving = sharedBoundaryLengthFromCells(xCuts, zCuts, cellRegion, "foyer", "livingroom");
  assert(foyerLiving >= 1.0 - 1e-3, `firstFloor: foyer not connected to livingroom (shared=${foyerLiving.toFixed(3)}m)`);

  // kitchen <-> dining (internal)
  const kitchenDining = sharedBoundaryLengthFromCells(xCuts, zCuts, cellRegion, "kitchen", "dining");
  assert(kitchenDining >= 1.0 - 1e-3, `firstFloor: kitchen not connected to dining (shared=${kitchenDining.toFixed(3)}m)`);

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
    assert(rectsN.length > 0, `firstFloor: region '${name}' empty at build time`);

    if (name === "stairs") {
      // Must be a rectangle by requirements: output the intended rectangle.
      const r = unRect(stairsRect);
      return rectRegion("stairs", surface, r.x0, r.z0, r.x1, r.z1);
    }

    const regionN = unionRectsToRegion(name, surface, rectsN);

    if (regionN.type === "rectangle") {
      const [[x0, z0], [x1, z1]] = regionN.points;
      const r = unRect({ x0, z0, x1, z1 });
      return rectRegion(name, surface, r.x0, r.z0, r.x1, r.z1);
    }

    return polyRegion(name, surface, regionN.points.map(unPoint));
  }

  // Realistic default surfaces
  const surface: Record<string, Region["surface"]> = {
    foyer: "wood",
    hallway: "wood",
    livingroom: "wood",
    dining: "wood",
    kitchen: "tile",
    bathroom_small: "tile",
    stairs: "wood",
    garage: "concrete_medium",
    laundry: "tile",
    pantry: "tile",
    utility: "concrete_light",
  };

  const regions: Region[] = [];

  // Required regions
  for (const nm of required) {
    regions.push(regionFromCells(nm, surface[nm]));
  }

  // Optional regions (exactly 2)
  for (const nm of optional) {
    regions.push(regionFromCells(nm, surface[nm]));
  }

  // Final coordinate sanity (lot-local bounds)
  for (const r of regions) {
    const pts = r.type === "rectangle" ? [r.points[0], r.points[1]] : r.points;
    for (const [x, z] of pts) {
      assert(x >= -EPS && x <= xsize + EPS, `firstFloor: region '${r.name}' has x out of bounds: ${x}`);
      assert(z >= -EPS && z <= 30 + EPS, `firstFloor: region '${r.name}' has z out of bounds: ${z}`);
    }
  }

  return { regions, construction: [], objects: [] };
}
