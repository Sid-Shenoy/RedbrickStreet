// web/src/world/houseModel/generation/firstFloor.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, PolyPoints, Region, Surface } from "../types";
import type { HouseGenContext } from "./context";
import { makeRng } from "../../../utils/seededRng";

/**
 * FIRST FLOOR (FOOLPROOF + RETRYING)
 *
 * User overrides:
 * 1) All first-floor regions together MUST cover the plot `houseregion` (a perfect partition).
 *    Regions may be rectangles or orthogonal polygons.
 * 2) Increase layout variation (deterministic).
 *
 * Core approach:
 * - Exploit plot.ts guarantee: houseregion is either:
 *   - a rectangle, OR
 *   - a rectangle with ONE rear modification: a rectangular extension OR a rectangular notch.
 * - Partition the full-width "core band" (from zWideMin..zFront) into:
 *   garage + behindGarage, spine (foyer + hallway + service rooms), living side (kitchen + living + optional dining/office),
 *   ensuring it covers the whole band without overlap.
 * - Cover the rear-modification band (below zWideMin) with extra rooms.
 * - Validate coverage + non-overlap via interior sampling, then enforce adjacency/connectivity constraints.
 * - If any validation fails, retry with a new deterministic attempt RNG and (progressively) fewer “extras”.
 */

const EPS = 1e-6;

// Sampling resolution for coverage/non-overlap validation
const SAMPLE_STEP = 0.5;
const SAMPLE_OFF = 0.25;

// Retry budget
const MAX_ATTEMPTS = 12;

type Rect = { x0: number; x1: number; z0: number; z1: number };

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Round UP to avoid “just under minimum” after quantization.
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

function polyAreaAbs(points: PolyPoints): number {
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i]!;
    const [x1, z1] = points[(i + 1) % points.length]!;
    s += x0 * z1 - x1 * z0;
  }
  return Math.abs(s) * 0.5;
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

function isAxisAlignedEdge(a: [number, number], b: [number, number]): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dz = Math.abs(a[1] - b[1]);
  return (dx <= EPS && dz > EPS) || (dz <= EPS && dx > EPS);
}

function simplifyOrthPoly(pointsIn: PolyPoints): PolyPoints {
  // Remove consecutive duplicates then redundant collinear vertices.
  const pts: PolyPoints = [];
  for (const p of pointsIn) {
    const last = pts.length ? pts[pts.length - 1]! : null;
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) {
      pts.push([q(p[0]), q(p[1])]);
    }
  }

  // Drop explicit closure if present.
  if (pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS) pts.pop();
  }

  const isCollinear = (p0: [number, number], p1: [number, number], p2: [number, number]) => {
    const sameX = Math.abs(p0[0] - p1[0]) <= EPS && Math.abs(p1[0] - p2[0]) <= EPS;
    const sameZ = Math.abs(p0[1] - p1[1]) <= EPS && Math.abs(p1[1] - p2[1]) <= EPS;
    return sameX || sameZ;
  };

  let changed = true;
  while (changed && pts.length >= 4) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const pPrev = pts[(i - 1 + pts.length) % pts.length]!;
      const p = pts[i]!;
      const pNext = pts[(i + 1) % pts.length]!;
      if (isCollinear(pPrev, p, pNext)) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }

  return pts;
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

function polyToRegion(name: string, surface: Surface, pts: PolyPoints): Region {
  const simp = simplifyOrthPoly(pts);
  return { name, surface, type: "polygon", points: simp };
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

function polyInsidePoly(inner: PolyPoints, outer: PolyPoints): boolean {
  for (const [x, z] of inner) {
    if (!pointInPolyOrOnBoundary(x, z, outer)) return false;
  }
  return true;
}

function regionContainsPoint(r: Region, x: number, z: number): boolean {
  if (r.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = r.points;
    return x + EPS >= x0 && x - EPS <= x1 && z + EPS >= z0 && z - EPS <= z1;
  }
  return pointInPolyOrOnBoundary(x, z, r.points);
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

function checkRectMin(hn: number, name: string, r: Rect, min: RoomMin) {
  const a = rectArea(r);
  const md = rectMinDim(r);
  if (a + EPS < min.area || md + EPS < min.minDim) {
    throw new Error(
      `firstFloor: House ${hn} ${name} too small (area=${q(a, 3)} min=${min.area}, minDim=${q(md, 3)} min=${min.minDim})`
    );
  }
}

function checkPolyMin(hn: number, name: string, pts: PolyPoints, min: RoomMin) {
  const a = polyAreaAbs(pts);
  const bb = polyBounds(pts);
  const md = rectMinDim(bb);
  if (a + EPS < min.area || md + EPS < min.minDim) {
    throw new Error(
      `firstFloor: House ${hn} ${name} too small (area=${q(a, 3)} min=${min.area}, minDim=${q(md, 3)} min=${min.minDim})`
    );
  }
}

function pickWood(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["wood_light", "wood_medium", "wood_dark"] as const);
}
function pickTile(rng: ReturnType<typeof makeRng>): Surface {
  return rng.pick(["tile_light", "tile_medium", "tile_dark"] as const);
}

// -------------------- Adjacency / connectivity --------------------

type Seg = { x0: number; z0: number; x1: number; z1: number };

function regionBoundarySegments(r: Region): Seg[] {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    return [
      { x0, z0, x1, z1: z0 },
      { x0: x1, z0, x1, z1 },
      { x0: x1, z0: z1, x1: x0, z1 },
      { x0, z0: z1, x1: x0, z1: z0 },
    ];
  }
  const pts = r.points;
  const segs: Seg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    segs.push({ x0: a[0], z0: a[1], x1: b[0], z1: b[1] });
  }
  return segs;
}

function segLen(s: Seg): number {
  return Math.abs(s.x1 - s.x0) + Math.abs(s.z1 - s.z0);
}

function splitIntoAtomicSegments(segs: Seg[], xCuts: number[], zCuts: number[]): Seg[] {
  const out: Seg[] = [];

  for (const s of segs) {
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;

    // Horizontal
    if (Math.abs(dz) <= 1e-6 && Math.abs(dx) > 1e-6) {
      const z = s.z0;
      const xa = Math.min(s.x0, s.x1);
      const xb = Math.max(s.x0, s.x1);

      const xs = [xa, xb];
      for (const x of xCuts) {
        if (x > xa + 1e-6 && x < xb - 1e-6) xs.push(x);
      }
      const ux = uniqSorted(xs);

      for (let i = 0; i < ux.length - 1; i++) {
        const x0 = ux[i]!;
        const x1 = ux[i + 1]!;
        if (x1 - x0 > 1e-6) out.push({ x0, z0: z, x1, z1: z });
      }
      continue;
    }

    // Vertical
    if (Math.abs(dx) <= 1e-6 && Math.abs(dz) > 1e-6) {
      const x = s.x0;
      const za = Math.min(s.z0, s.z1);
      const zb = Math.max(s.z0, s.z1);

      const zs = [za, zb];
      for (const z of zCuts) {
        if (z > za + 1e-6 && z < zb - 1e-6) zs.push(z);
      }
      const uz = uniqSorted(zs);

      for (let i = 0; i < uz.length - 1; i++) {
        const z0 = uz[i]!;
        const z1 = uz[i + 1]!;
        if (z1 - z0 > 1e-6) out.push({ x0: x, z0, x1: x, z1 });
      }
      continue;
    }
  }

  return out;
}

function round6(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

function segKeyAtomic(s: Seg): string {
  const dx = s.x1 - s.x0;
  const dz = s.z1 - s.z0;

  if (Math.abs(dz) <= 1e-6 && Math.abs(dx) > 1e-6) {
    const z = round6(s.z0);
    const a = round6(Math.min(s.x0, s.x1));
    const b = round6(Math.max(s.x0, s.x1));
    return `h|${z}|${a}|${b}`;
  }
  if (Math.abs(dx) <= 1e-6 && Math.abs(dz) > 1e-6) {
    const x = round6(s.x0);
    const a = round6(Math.min(s.z0, s.z1));
    const b = round6(Math.max(s.z0, s.z1));
    return `v|${x}|${a}|${b}`;
  }
  return `na|${round6(s.x0)}|${round6(s.z0)}|${round6(s.x1)}|${round6(s.z1)}`;
}

function adjacencyLengths(regions: Region[]): number[][] {
  // Build cut sets from all vertices.
  const xVals: number[] = [];
  const zVals: number[] = [];
  for (const r of regions) {
    if (r.type === "rectangle") {
      xVals.push(r.points[0][0], r.points[1][0]);
      zVals.push(r.points[0][1], r.points[1][1]);
    } else {
      for (const [x, z] of r.points) {
        xVals.push(x);
        zVals.push(z);
      }
    }
  }
  const xCuts = uniqSorted(xVals.map((v) => q(v, 6)));
  const zCuts = uniqSorted(zVals.map((v) => q(v, 6)));

  const segOwners = new Map<string, { len: number; owners: number[] }>();

  for (let i = 0; i < regions.length; i++) {
    const boundary = regionBoundarySegments(regions[i]!);
    const atomic = splitIntoAtomicSegments(boundary, xCuts, zCuts);

    for (const s of atomic) {
      const key = segKeyAtomic(s);
      const len = segLen(s);
      const entry = segOwners.get(key);
      if (entry) entry.owners.push(i);
      else segOwners.set(key, { len, owners: [i] });
    }
  }

  const adj: number[][] = Array.from({ length: regions.length }, () =>
    Array.from({ length: regions.length }, () => 0)
  );

  for (const v of segOwners.values()) {
    if (v.owners.length < 2) continue;
    for (let a = 0; a < v.owners.length; a++) {
      for (let b = a + 1; b < v.owners.length; b++) {
        const i = v.owners[a]!;
        const j = v.owners[b]!;
        adj[i]![j]! += v.len;
        adj[j]![i]! += v.len;
      }
    }
  }

  return adj;
}

function ensureRequiredConnected(hn: number, regions: Region[]) {
  const required = ["garage", "foyer", "hallway", "livingroom", "kitchen", "bathroom_small", "stairs"] as const;

  const idx: Record<(typeof required)[number], number> = {
    garage: -1,
    foyer: -1,
    hallway: -1,
    livingroom: -1,
    kitchen: -1,
    bathroom_small: -1,
    stairs: -1,
  };

  for (let i = 0; i < regions.length; i++) {
    const nm = regions[i]!.name;
    if ((required as readonly string[]).includes(nm) && idx[nm as (typeof required)[number]] === -1) {
      idx[nm as (typeof required)[number]] = i;
    }
  }

  for (const r of required) {
    if (idx[r] === -1) throw new Error(`firstFloor: House ${hn} missing required region '${r}'`);
  }

  const adj = adjacencyLengths(regions);
  const reqIdx = required.map((r) => idx[r]);

  const visited = new Set<number>();
  const stack = [reqIdx[0]!];
  visited.add(reqIdx[0]!);

  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of reqIdx) {
      if (visited.has(nxt)) continue;
      if (adj[cur]![nxt]! + EPS >= 1.0) {
        visited.add(nxt);
        stack.push(nxt);
      }
    }
  }

  for (const i of reqIdx) {
    if (!visited.has(i)) throw new Error(`firstFloor: House ${hn} required-room connectivity failed`);
  }
}

// -------------------- House shape inference (matches plot.ts guarantees) --------------------

type HouseShape =
  | { kind: "rect"; x0: number; x1: number; z0: number; z1: number; zWideMin: number }
  | {
      kind: "extension";
      x0: number;
      x1: number;
      z0: number;
      z1: number;
      zWideMin: number;
      extX0: number;
      extX1: number;
      extZ0: number;
    }
  | {
      kind: "notch";
      x0: number;
      x1: number;
      z0: number;
      z1: number;
      zWideMin: number;
      notchX0: number;
      notchX1: number;
      notchZ1: number;
    };

function inferHouseShape(hn: number, poly: PolyPoints): HouseShape {
  // Bounds
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

  if (zVals.length === 2) {
    return { kind: "rect", x0: xMin, x1: xMax, z0: zMin, z1: zMax, zWideMin: zMin };
  }

  if (zVals.length !== 3) {
    throw new Error(`firstFloor: House ${hn} unexpected houseregion z-profile (unique z count=${zVals.length})`);
  }

  const zLow = zVals[0]!;
  const zMid = zVals[1]!;
  const zHigh = zVals[2]!;

  const xsAtLow = uniqSorted(poly.filter((p) => Math.abs(p[1] - zLow) <= 1e-3).map((p) => q(p[0], 3)));
  const hasXMin = xsAtLow.some((x) => Math.abs(x - xMin) <= 1e-3);
  const hasXMax = xsAtLow.some((x) => Math.abs(x - xMax) <= 1e-3);

  if (hasXMin && hasXMax) {
    // Notch
    if (xsAtLow.length < 4) {
      throw new Error(`firstFloor: House ${hn} notch inference failed (xsAtLow.length=${xsAtLow.length})`);
    }
    const notchX0 = xsAtLow[1]!;
    const notchX1 = xsAtLow[xsAtLow.length - 2]!;
    return {
      kind: "notch",
      x0: xMin,
      x1: xMax,
      z0: zLow,
      z1: zHigh,
      zWideMin: zMid,
      notchX0: q(notchX0, 3),
      notchX1: q(notchX1, 3),
      notchZ1: q(zMid, 3),
    };
  }

  // Extension
  if (xsAtLow.length < 2) {
    throw new Error(`firstFloor: House ${hn} extension inference failed (xsAtLow.length=${xsAtLow.length})`);
  }
  const extX0 = xsAtLow[0]!;
  const extX1 = xsAtLow[xsAtLow.length - 1]!;
  return {
    kind: "extension",
    x0: xMin,
    x1: xMax,
    z0: zLow,
    z1: zHigh,
    zWideMin: zMid,
    extX0: q(extX0, 3),
    extX1: q(extX1, 3),
    extZ0: q(zLow, 3),
  };
}

// -------------------- Robust “rect minus corner” polygon (for pantry/office carving) --------------------

function rectMinusCornerAsPoly(outer: Rect, cut: Rect): PolyPoints | null {
  const touchesLeft = Math.abs(cut.x0 - outer.x0) <= 1e-3;
  const touchesRight = Math.abs(cut.x1 - outer.x1) <= 1e-3;
  const touchesBottom = Math.abs(cut.z0 - outer.z0) <= 1e-3;
  const touchesTop = Math.abs(cut.z1 - outer.z1) <= 1e-3;

  // Must touch exactly one vertical edge and exactly one horizontal edge (a corner).
  const vTouches = (touchesLeft ? 1 : 0) + (touchesRight ? 1 : 0);
  const hTouches = (touchesBottom ? 1 : 0) + (touchesTop ? 1 : 0);
  if (vTouches !== 1 || hTouches !== 1) return null;

  // Must be strictly inside other dimensions
  if (cut.x0 < outer.x0 - EPS || cut.x1 > outer.x1 + EPS || cut.z0 < outer.z0 - EPS || cut.z1 > outer.z1 + EPS) return null;
  if (cut.x1 - cut.x0 <= EPS || cut.z1 - cut.z0 <= EPS) return null;

  // Clockwise polygons
  if (touchesLeft && touchesBottom) {
    // cut at bottom-left
    return simplifyOrthPoly([
      [outer.x0, outer.z1],
      [outer.x1, outer.z1],
      [outer.x1, outer.z0],
      [cut.x1, outer.z0],
      [cut.x1, cut.z1],
      [outer.x0, cut.z1],
    ]);
  }

  if (touchesLeft && touchesTop) {
    // cut at top-left
    return simplifyOrthPoly([
      [cut.x1, outer.z1],
      [outer.x1, outer.z1],
      [outer.x1, outer.z0],
      [outer.x0, outer.z0],
      [outer.x0, cut.z0],
      [cut.x1, cut.z0],
    ]);
  }

  if (touchesRight && touchesBottom) {
    // cut at bottom-right
    return simplifyOrthPoly([
      [outer.x0, outer.z1],
      [outer.x1, outer.z1],
      [outer.x1, cut.z1],
      [cut.x0, cut.z1],
      [cut.x0, outer.z0],
      [outer.x0, outer.z0],
    ]);
  }

  // touchesRight && touchesTop
  return simplifyOrthPoly([
    [outer.x0, outer.z1],
    [cut.x0, outer.z1],
    [cut.x0, cut.z0],
    [outer.x1, cut.z0],
    [outer.x1, outer.z0],
    [outer.x0, outer.z0],
  ]);
}

// -------------------- Validation helpers --------------------

function validateRegionsOrThrow(hn: number, ctx: HouseGenContext, housePoly: PolyPoints, regions: Region[]) {
  // Axis-aligned requirement for polygons
  for (const r of regions) {
    // Bounds
    const bb = r.type === "rectangle" ? rectFromRegion(r) : polyBounds(r.points);
    if (bb.x0 < -EPS || bb.x1 > ctx.xsize + EPS || bb.z0 < -EPS || bb.z1 > 30 + EPS) {
      throw new Error(`firstFloor: House ${hn} region '${r.name}' out of lot bounds`);
    }

    // Inside houseregion
    if (r.type === "rectangle") {
      if (!rectInsidePoly(bb, housePoly)) throw new Error(`firstFloor: House ${hn} region '${r.name}' not inside houseregion`);
    } else {
      if (r.points.length < 4) throw new Error(`firstFloor: House ${hn} region '${r.name}' polygon has < 4 points`);
      for (let i = 0; i < r.points.length; i++) {
        const a = r.points[i]!;
        const b = r.points[(i + 1) % r.points.length]!;
        if (!isAxisAlignedEdge(a, b)) throw new Error(`firstFloor: House ${hn} region '${r.name}' polygon has non-axis-aligned edge`);
      }
      if (!polyInsidePoly(r.points, housePoly))
        throw new Error(`firstFloor: House ${hn} region '${r.name}' polygon not inside houseregion`);
    }

    // Global mins
    const area = r.type === "rectangle" ? rectArea(rectFromRegion(r)) : polyAreaAbs(r.points);
    const minD = r.type === "rectangle" ? rectMinDim(rectFromRegion(r)) : rectMinDim(polyBounds(r.points));
    if (area + EPS < 2.0) throw new Error(`firstFloor: House ${hn} region '${r.name}' violates global min area (area=${q(area, 3)})`);
    if (minD + EPS < 1.0) throw new Error(`firstFloor: House ${hn} region '${r.name}' violates global min dimension (minDim=${q(minD, 3)})`);

    // Room minimums
    const minReq = REQUIRED_MINS[r.name];
    const minExtra = EXTRA_MINS[r.name];
    if (minReq) {
      if (r.type === "rectangle") checkRectMin(hn, r.name, rectFromRegion(r), minReq);
      else checkPolyMin(hn, r.name, r.points, minReq);
    } else if (minExtra) {
      if (r.type === "rectangle") checkRectMin(hn, r.name, rectFromRegion(r), minExtra);
      else checkPolyMin(hn, r.name, r.points, minExtra);
    }
  }

  // Coverage / overlap sampling
  const bbHouse = polyBounds(housePoly);
  const sx0 = bbHouse.x0 + SAMPLE_OFF;
  const sx1 = bbHouse.x1 - SAMPLE_OFF;
  const sz0 = bbHouse.z0 + SAMPLE_OFF;
  const sz1 = bbHouse.z1 - SAMPLE_OFF;

  for (let x = sx0; x <= sx1 + 1e-9; x += SAMPLE_STEP) {
    const xx = q(x, 6);
    for (let z = sz0; z <= sz1 + 1e-9; z += SAMPLE_STEP) {
      const zz = q(z, 6);
      if (!pointInPolyOrOnBoundary(xx, zz, housePoly)) continue;

      let hit = 0;
      for (const r of regions) {
        if (regionContainsPoint(r, xx, zz)) hit++;
      }
      if (hit === 0) throw new Error(`firstFloor: House ${hn} coverage gap near (${q(xx, 3)},${q(zz, 3)})`);
      if (hit > 1) throw new Error(`firstFloor: House ${hn} overlap near (${q(xx, 3)},${q(zz, 3)}) (count=${hit})`);
    }
  }
}

function validateInterfacesAndConnectivityOrThrow(
  hn: number,
  regions: Region[],
  drivewayNear: Rect,
  walkway: Rect,
  zFront: number
) {
  const idxByName = (nm: string) => regions.findIndex((r) => r.name === nm);

  const iGarage = idxByName("garage");
  const iFoyer = idxByName("foyer");
  const iHall = idxByName("hallway");
  const iStairs = idxByName("stairs");
  const iBath = idxByName("bathroom_small");
  const iKitchen = idxByName("kitchen");
  const iLiving = idxByName("livingroom");

  if ([iGarage, iFoyer, iHall, iStairs, iBath, iKitchen, iLiving].some((i) => i < 0)) {
    throw new Error(`firstFloor: House ${hn} missing required room after generation`);
  }

  // Garage front interface with driveway >= 2.5m
  {
    const g = regions[iGarage]!;
    const gbb = g.type === "rectangle" ? rectFromRegion(g) : polyBounds(g.points);
    if (Math.abs(gbb.z1 - zFront) > 1e-2) throw new Error(`firstFloor: House ${hn} garage must touch front boundary`);

    const overlap = Math.max(0, Math.min(gbb.x1, drivewayNear.x1) - Math.max(gbb.x0, drivewayNear.x0));
    if (overlap + EPS < 2.5) throw new Error(`firstFloor: House ${hn} garage-driveway interface too short (len=${q(overlap, 3)}m)`);
  }

  // Foyer front interface with walkway >= 1.0m
  {
    const f = regions[iFoyer]!;
    const fbb = f.type === "rectangle" ? rectFromRegion(f) : polyBounds(f.points);
    if (Math.abs(fbb.z1 - zFront) > 1e-2) throw new Error(`firstFloor: House ${hn} foyer must touch front boundary`);

    const overlap = Math.max(0, Math.min(fbb.x1, walkway.x1) - Math.max(fbb.x0, walkway.x0));
    if (overlap + EPS < 1.0) throw new Error(`firstFloor: House ${hn} foyer-walkway interface too short (len=${q(overlap, 3)}m)`);
  }

  const adj = adjacencyLengths(regions);
  const adjLen = (a: number, b: number) => adj[a]![b]!;

  // foyer with hallway OR livingroom (>= 1.0)
  if (Math.max(adjLen(iFoyer, iHall), adjLen(iFoyer, iLiving)) + EPS < 1.0) {
    throw new Error(`firstFloor: House ${hn} foyer must touch hallway or livingroom (>=1.0m)`);
  }

  // hallway with stairs (>= 1.0)
  if (adjLen(iHall, iStairs) + EPS < 1.0) throw new Error(`firstFloor: House ${hn} hallway must touch stairs (>=1.0m)`);

  // bathroom_small with hallway (>= 1.0)
  if (adjLen(iBath, iHall) + EPS < 1.0) throw new Error(`firstFloor: House ${hn} bathroom_small must touch hallway (>=1.0m)`);

  // kitchen with livingroom OR diningroom OR hallway (>=1.0)
  const iDining = idxByName("diningroom");
  const kitchenOK =
    adjLen(iKitchen, iLiving) + EPS >= 1.0 ||
    adjLen(iKitchen, iHall) + EPS >= 1.0 ||
    (iDining >= 0 && adjLen(iKitchen, iDining) + EPS >= 1.0);
  if (!kitchenOK) throw new Error(`firstFloor: House ${hn} kitchen adjacency constraint failed`);

  // garage with hallway OR mudroom OR foyer (>=1.0)
  const iMud = idxByName("mudroom");
  const garageOK =
    adjLen(iGarage, iHall) + EPS >= 1.0 ||
    adjLen(iGarage, iFoyer) + EPS >= 1.0 ||
    (iMud >= 0 && adjLen(iGarage, iMud) + EPS >= 1.0);
  if (!garageOK) throw new Error(`firstFloor: House ${hn} garage adjacency constraint failed`);

  // diningroom if present: must touch kitchen OR livingroom (>=1.0)
  if (iDining >= 0) {
    if (Math.max(adjLen(iDining, iKitchen), adjLen(iDining, iLiving)) + EPS < 1.0) {
      throw new Error(`firstFloor: House ${hn} diningroom adjacency constraint failed`);
    }
  }

  ensureRequiredConnected(hn, regions);
}

// -------------------- Attempt generator --------------------

function generateAttempt(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel, attempt: number): FloorModel {
  const hn = house.houseNumber;

  const rng = makeRng(`${ctx.seed}/firstFloor/${attempt}`);

  const hr = getRegionByName(plot, "houseregion");
  if (!hr || hr.type !== "polygon") throw new Error(`firstFloor: House ${hn} plot missing houseregion polygon`);

  // plot preconditions
  for (let i = 0; i < hr.points.length; i++) {
    const a = hr.points[i]!;
    const b = hr.points[(i + 1) % hr.points.length]!;
    if (!isAxisAlignedEdge(a, b)) throw new Error(`firstFloor: House ${hn} houseregion has non-axis-aligned edge`);
  }

  const driveway = getRegionByName(plot, "driveway_near");
  const walkway = getRegionByName(plot, "walkway");
  if (!driveway || driveway.type !== "rectangle") throw new Error(`firstFloor: House ${hn} plot missing driveway_near rectangle`);
  if (!walkway || walkway.type !== "rectangle") throw new Error(`firstFloor: House ${hn} plot missing walkway rectangle`);

  const drv = rectFromRegion(driveway);
  const ww = rectFromRegion(walkway);

  const shape = inferHouseShape(hn, hr.points);

  const x0 = shape.x0;
  const x1 = shape.x1;
  const zRear = shape.z0;
  const zFront = shape.z1;
  const zWideMin = shape.zWideMin;

  // driveway side: left if driveway is at lot x=0, else right
  const drivewaySide: "left" | "right" = drv.x0 <= 1e-3 ? "left" : "right";

  const drivewayW = q(drv.x1 - drv.x0, 3);

  // Attempt-dependent feature toggles (fallback-friendly)
  const baseVariant = rng.int(0, 4); // 0..4
  const allowDining = attempt < 6 ? rng.bool(baseVariant === 0 ? 0.75 : 0.55) : false;
  const allowOffice = attempt < 4 ? rng.bool(baseVariant === 2 ? 0.65 : 0.35) : false;
  const allowKitchenPantryCut = attempt < 3 ? rng.bool(0.6) : false; // later attempts disable
  const allowExtraRearRooms = attempt < 8;

  // Materials
  const woodA = pickWood(rng);
  const woodB = pickWood(rng);
  const tileA = pickTile(rng);
  const tileB = pickTile(rng);

  // Compute width excluding garage
  const availNonGarage = drivewaySide === "left" ? q(x1 - drv.x1, 3) : q(drv.x0 - x0, 3);
  if (availNonGarage + EPS < 6.4) throw new Error(`firstFloor: House ${hn} insufficient non-garage width (avail=${availNonGarage})`);

  // Choose spine width
  const livingMinW = 4.3; // keep living credible
  const spineWMin = 3.0;
  const spineWMax = Math.max(spineWMin, q(availNonGarage - livingMinW, 3));

  let spineW = q(clamp(rng.float(3.1, 4.9), spineWMin, spineWMax), 3);
  if (spineW + EPS > spineWMax) spineW = spineWMax;

  let xSp0: number, xSp1: number;
  if (drivewaySide === "left") {
    xSp0 = q(drv.x1, 3);
    xSp1 = q(drv.x1 + spineW, 3);
  } else {
    xSp1 = q(drv.x0, 3);
    xSp0 = q(drv.x0 - spineW, 3);
  }

  const xLiv0 = drivewaySide === "left" ? xSp1 : x0;
  const xLiv1 = drivewaySide === "left" ? x1 : xSp0;
  const livingW = q(xLiv1 - xLiv0, 3);
  if (livingW + EPS < REQUIRED_MINS.livingroom.minDim) {
    throw new Error(`firstFloor: House ${hn} living segment too narrow (livingW=${livingW})`);
  }

  // Corridor width within spine (hallway corridor)
  const corridorWMin = 1.05;
  const corridorWMax = Math.max(corridorWMin, spineW - 1.55);
  const corridorW = q(clamp(rng.float(1.1, 1.55), corridorWMin, corridorWMax), 3);

  const xHall0 = drivewaySide === "left" ? q(xSp1 - corridorW, 3) : q(xSp0, 3);
  const xHall1 = drivewaySide === "left" ? q(xSp1, 3) : q(xSp0 + corridorW, 3);

  // Service strip adjacent to garage side inside spine
  const xSvc0 = drivewaySide === "left" ? q(xSp0, 3) : q(xHall1, 3);
  const xSvc1 = drivewaySide === "left" ? q(xHall0, 3) : q(xSp1, 3);
  const svcW = q(xSvc1 - xSvc0, 3);
  if (svcW + EPS < 1.55) throw new Error(`firstFloor: House ${hn} service strip too narrow (svcW=${svcW})`);

  // Wide band depth
  const wideDepth = q(zFront - zWideMin, 3);
  if (wideDepth + EPS < 9.8) throw new Error(`firstFloor: House ${hn} insufficient wideDepth=${wideDepth}`);

  // Entry depth (foyer band). Keep hallway below it.
  const foyerMinByArea = ceilQ((REQUIRED_MINS.foyer.area + 0.35) / spineW);
  const foyerMin = Math.max(REQUIRED_MINS.foyer.minDim + 0.08, foyerMinByArea, 2.4);

  // Max entry depth so remaining spine depth can host service core + hallway mins
  const minSpineBackDepth = 5.4;
  const entryDMax = Math.max(foyerMin, q(wideDepth - minSpineBackDepth, 3));
  let entryD = q(clamp(rng.float(2.55, 3.9), foyerMin, entryDMax), 3);

  const zEntry0 = q(zFront - entryD, 3);

  // Kitchen vs living split in Z
  const kitchenDepthMin = Math.max(
    REQUIRED_MINS.kitchen.minDim + 0.08,
    ceilQ((REQUIRED_MINS.kitchen.area + 0.5) / livingW),
    3.9
  );
  const livingDepthMin = Math.max(
    REQUIRED_MINS.livingroom.minDim + 0.08,
    ceilQ((REQUIRED_MINS.livingroom.area + 0.7) / livingW),
    4.1
  );

  const kitchenDMax = q(wideDepth - livingDepthMin, 3);
  if (kitchenDMax + EPS < kitchenDepthMin) {
    // If entryD too big, shrink entry and re-evaluate (still deterministic)
    const shrink = Math.min(0.7, entryD - foyerMin);
    if (shrink > 0.05) {
      entryD = q(entryD - shrink, 3);
    }
    // recompute
    const zEntry02 = q(zFront - entryD, 3);
    // we don't re-solve everything; but entry affects service strip only; wideDepth unchanged.
    if (zEntry02 <= zWideMin + 1.0) throw new Error(`firstFloor: House ${hn} cannot satisfy kitchen+living split`);
  }

  let kitchenD = q(clamp(rng.float(4.8, 6.9), kitchenDepthMin, kitchenDMax), 3);
  const zSplit = q(zWideMin + kitchenD, 3);

  // Garage depth
  const garageDepthMin = Math.max(
    REQUIRED_MINS.garage.minDim + 0.08,
    ceilQ((REQUIRED_MINS.garage.area + 0.7) / drivewayW),
    5.9
  );
  const garageDepthMax = Math.max(garageDepthMin, q(wideDepth - 2.8, 3));
  const garageD = q(clamp(rng.float(6.2, 8.7), garageDepthMin, garageDepthMax), 3);
  const zGarage0 = q(zFront - garageD, 3);

  // ---------- Build partition for core band: [x0..x1] x [zWideMin..zFront] ----------
  const regions: Region[] = [];

  // Garage: covers driveway width from max(zWideMin,zGarage0) to zFront
  const garageRect = rectNorm(drv.x0, Math.max(zWideMin, zGarage0), drv.x1, zFront);
  regions.push(rectToRegion("garage", "concrete_dark", garageRect));

  // Behind-garage filler: covers remainder under garage in the wide band
  const behindGarageRect = rectNorm(drv.x0, zWideMin, drv.x1, Math.max(zWideMin, zGarage0));
  const bgA = rectArea(behindGarageRect);
  const bgMD = rectMinDim(behindGarageRect);
  let behindGarageName: keyof typeof EXTRA_MINS = "storage";
  if (bgA + EPS >= EXTRA_MINS.mudroom.area && bgMD + EPS >= EXTRA_MINS.mudroom.minDim && rng.bool(0.55)) behindGarageName = "mudroom";
  else if (bgA + EPS >= EXTRA_MINS.laundry.area && bgMD + EPS >= EXTRA_MINS.laundry.minDim && rng.bool(0.35)) behindGarageName = "laundry";
  else if (bgA + EPS >= EXTRA_MINS.storage.area && bgMD + EPS >= EXTRA_MINS.storage.minDim) behindGarageName = "storage";
  else behindGarageName = "closet";

  regions.push(
    rectToRegion(
      behindGarageName,
      behindGarageName === "closet" ? woodA : behindGarageName === "storage" ? "concrete_medium" : tileA,
      behindGarageRect
    )
  );

  // Spine: foyer (front)
  const foyerRect = rectNorm(xSp0, zEntry0, xSp1, zFront);
  regions.push(rectToRegion("foyer", woodA, foyerRect));

  // Spine: hallway corridor (back)
  const hallwayRect = rectNorm(xHall0, zWideMin, xHall1, zEntry0);
  regions.push(rectToRegion("hallway", woodA, hallwayRect));

  // Service strip: partition along Z into stairs + bath + filler to cover [zWideMin..zEntry0]
  const svcTop = zEntry0;
  const svcBot = zWideMin;
  const svcDepth = q(svcTop - svcBot, 3);

  const bathDepthMin = Math.max(
    REQUIRED_MINS.bathroom_small.minDim + 0.08,
    ceilQ((REQUIRED_MINS.bathroom_small.area + 0.25) / svcW),
    1.7
  );
  const stairsDepthMin = Math.max(
    REQUIRED_MINS.stairs.minDim + 0.08,
    ceilQ((REQUIRED_MINS.stairs.area + 0.35) / svcW),
    2.55
  );

  // Allocate in a robust way: choose a top chunk for stairs, then bath, then filler remainder.
  // Ensure filler remainder is at least 1.0m if possible; otherwise merge into stairs.
  const fillerMin = 1.0;

  let stairsD = q(clamp(rng.float(2.8, 4.1), stairsDepthMin, Math.max(stairsDepthMin, svcDepth - bathDepthMin - 0.25)), 3);
  let bathD = q(clamp(rng.float(1.8, 2.5), bathDepthMin, Math.max(bathDepthMin, svcDepth - stairsD - 0.25)), 3);

  // If leftover too small, adjust by shrinking stairs first (bath has tight mins)
  let leftover = q(svcDepth - stairsD - bathD, 3);
  if (leftover + EPS < fillerMin) {
    const need = fillerMin - leftover;
    const shrink = Math.min(need, stairsD - stairsDepthMin);
    stairsD = q(stairsD - shrink, 3);
    leftover = q(svcDepth - stairsD - bathD, 3);
  }
  if (leftover < -EPS) {
    // last resort: force minima and accept no filler
    stairsD = stairsDepthMin;
    bathD = bathDepthMin;
    leftover = q(svcDepth - stairsD - bathD, 3);
    if (leftover < -EPS) throw new Error(`firstFloor: House ${hn} cannot fit service strip rooms`);
  }

  // Ordering variation
  const order = rng.int(0, 2); // 0: stairs top, 1: bath top, 2: filler top
  let zCursor = svcTop;

  const placeSvc = (name: string, surface: Surface, depth: number) => {
    const z1 = zCursor;
    const z0r = q(z1 - depth, 3);
    const rr = rectNorm(xSvc0, z0r, xSvc1, z1);
    regions.push(rectToRegion(name, surface, rr));
    zCursor = z0r;
    return rr;
  };

  const pickFillerName = (r: Rect): keyof typeof EXTRA_MINS => {
    const a = rectArea(r);
    const md = rectMinDim(r);
    if (a + EPS >= EXTRA_MINS.pantry.area && md + EPS >= EXTRA_MINS.pantry.minDim && rng.bool(0.35)) return "pantry";
    if (a + EPS >= EXTRA_MINS.storage.area && md + EPS >= EXTRA_MINS.storage.minDim && rng.bool(0.6)) return "storage";
    return "closet";
  };

  const fillerSurface = (nm: keyof typeof EXTRA_MINS): Surface => {
    if (nm === "storage") return "concrete_medium";
    if (nm === "pantry") return tileA;
    return woodA;
  };

  const doFiller = (depth: number) => {
    if (depth <= 0.02) return;
    const rr = rectNorm(xSvc0, q(zCursor - depth, 3), xSvc1, zCursor);
    const nm = pickFillerName(rr);
    regions.push(rectToRegion(nm, fillerSurface(nm), rr));
    zCursor = rr.z0;
  };

  if (order === 0) {
    placeSvc("stairs", "wood_medium", stairsD);
    placeSvc("bathroom_small", tileB, bathD);
    doFiller(Math.max(0, zCursor - svcBot));
  } else if (order === 1) {
    placeSvc("bathroom_small", tileB, bathD);
    placeSvc("stairs", "wood_medium", stairsD);
    doFiller(Math.max(0, zCursor - svcBot));
  } else {
    // filler first, then stairs, then bath
    doFiller(Math.min(leftover, 1.35));
    placeSvc("stairs", "wood_medium", stairsD);
    placeSvc("bathroom_small", tileB, bathD);
    doFiller(Math.max(0, zCursor - svcBot));
  }

  // Living side: kitchen band + living band
  const kitchenBand = rectNorm(xLiv0, zWideMin, xLiv1, zSplit);

  // Optional dining split in X (kitchen + dining) OR pantry corner cut inside kitchen (kitchen polygon + pantry rect)
  let kitchenRegion: Region | null = null;
  let diningRegion: Region | null = null;
  let pantryRegion: Region | null = null;

  // Dining split only if wide enough and allowed
  const canSplitDining = allowDining && rectW(kitchenBand) + EPS >= 5.6;

  if (canSplitDining) {
    const minW = EXTRA_MINS.diningroom.minDim + 0.08;
    const maxKitchenW = rectW(kitchenBand) - minW;
    if (maxKitchenW + EPS >= REQUIRED_MINS.kitchen.minDim + 0.08) {
      const kW = q(clamp(rng.float(3.2, 5.0), REQUIRED_MINS.kitchen.minDim + 0.08, maxKitchenW), 3);

      // Place kitchen nearer spine sometimes for variation
      const kitchenNearSpine = rng.bool(0.6);

      let kx0: number, kx1: number;
      let dx0: number, dx1: number;

      if (drivewaySide === "left") {
        // spine boundary is xLiv0
        if (kitchenNearSpine) {
          kx0 = xLiv0;
          kx1 = q(xLiv0 + kW, 3);
          dx0 = kx1;
          dx1 = xLiv1;
        } else {
          kx1 = xLiv1;
          kx0 = q(xLiv1 - kW, 3);
          dx0 = xLiv0;
          dx1 = kx0;
        }
      } else {
        // spine boundary is xLiv1
        if (kitchenNearSpine) {
          kx1 = xLiv1;
          kx0 = q(xLiv1 - kW, 3);
          dx0 = xLiv0;
          dx1 = kx0;
        } else {
          kx0 = xLiv0;
          kx1 = q(xLiv0 + kW, 3);
          dx0 = kx1;
          dx1 = xLiv1;
        }
      }

      const kRect = rectNorm(kx0, zWideMin, kx1, zSplit);
      const dRect = rectNorm(dx0, zWideMin, dx1, zSplit);

      // Only accept if both meet mins
      checkRectMin(hn, "kitchen", kRect, REQUIRED_MINS.kitchen);
      checkRectMin(hn, "diningroom", dRect, EXTRA_MINS.diningroom);

      kitchenRegion = rectToRegion("kitchen", tileA, kRect);
      diningRegion = rectToRegion("diningroom", woodB, dRect);
    }
  }

  // Pantry corner cut inside kitchen band if we did NOT split dining and allowed
  if (!kitchenRegion) {
    // Start with full kitchen band
    let kRect = kitchenBand;

    if (allowKitchenPantryCut && rectW(kRect) + EPS >= 4.3 && rectD(kRect) + EPS >= 3.6) {
      // Pantry size bounds with safety margins
      const pantryW = q(clamp(rng.float(1.2, 1.7), EXTRA_MINS.pantry.minDim + 0.05, Math.min(1.8, rectW(kRect) - 2.7)), 3);
      const pantryD = q(
        clamp(
          rng.float(1.5, 2.4),
          EXTRA_MINS.pantry.minDim + 0.05,
          Math.min(2.6, rectD(kRect) - 2.7)
        ),
        3
      );

      // Place pantry at rear (zWideMin) corner, left or right (x edge), for realism.
      const atLeftEdge = rng.bool(0.5);

      const px0 = atLeftEdge ? kRect.x0 : q(kRect.x1 - pantryW, 3);
      const px1 = atLeftEdge ? q(kRect.x0 + pantryW, 3) : kRect.x1;
      const pz0 = kRect.z0; // rear
      const pz1 = q(kRect.z0 + pantryD, 3);

      const pRect = rectNorm(px0, pz0, px1, pz1);
      // Build kitchen polygon = outer minus pantry corner
      const kPoly = rectMinusCornerAsPoly(kRect, pRect);

      if (kPoly) {
        // Validate pantry and kitchen quickly; if bad, skip pantry carve
        try {
          checkRectMin(hn, "pantry", pRect, EXTRA_MINS.pantry);
          checkPolyMin(hn, "kitchen", kPoly, REQUIRED_MINS.kitchen);

          pantryRegion = rectToRegion("pantry", tileA, pRect);
          kitchenRegion = polyToRegion("kitchen", tileA, kPoly);
        } catch {
          // skip pantry cut
          pantryRegion = null;
          kitchenRegion = rectToRegion("kitchen", tileA, kRect);
        }
      } else {
        kitchenRegion = rectToRegion("kitchen", tileA, kRect);
      }
    } else {
      kitchenRegion = rectToRegion("kitchen", tileA, kRect);
    }
  }

  regions.push(kitchenRegion);
  if (diningRegion) regions.push(diningRegion);
  if (pantryRegion) regions.push(pantryRegion);

  // Living band (front)
  const livingBand = rectNorm(xLiv0, zSplit, xLiv1, zFront);

  // Optional office carve from living band (front corner), leaving livingroom as polygon
  if (allowOffice && rectW(livingBand) + EPS >= 6.0 && rectD(livingBand) + EPS >= 3.3) {
    const officeW = q(clamp(rng.float(2.4, 3.8), EXTRA_MINS.office.minDim + 0.08, Math.min(4.0, rectW(livingBand) - 3.3)), 3);
    const officeDMinByArea = ceilQ((EXTRA_MINS.office.area + 0.5) / officeW);
    const officeD = q(
      clamp(rng.float(2.8, 4.3), Math.max(EXTRA_MINS.office.minDim + 0.08, officeDMinByArea), Math.min(4.5, rectD(livingBand))),
      3
    );

    const atLeftEdge = rng.bool(0.5);
    const ox0 = atLeftEdge ? livingBand.x0 : q(livingBand.x1 - officeW, 3);
    const ox1 = atLeftEdge ? q(livingBand.x0 + officeW, 3) : livingBand.x1;

    // Office at the front edge (zFront)
    const oz1 = livingBand.z1;
    const oz0 = q(oz1 - officeD, 3);

    const oRect = rectNorm(ox0, oz0, ox1, oz1);
    const lPoly = rectMinusCornerAsPoly(livingBand, oRect);

    if (lPoly) {
      // Validate; if it fails, fall back to rectangle living
      try {
        checkRectMin(hn, "office", oRect, EXTRA_MINS.office);
        checkPolyMin(hn, "livingroom", lPoly, REQUIRED_MINS.livingroom);

        regions.push(rectToRegion("office", woodB, oRect));
        regions.push(polyToRegion("livingroom", woodB, lPoly));
      } catch {
        regions.push(rectToRegion("livingroom", woodB, livingBand));
      }
    } else {
      regions.push(rectToRegion("livingroom", woodB, livingBand));
    }
  } else {
    regions.push(rectToRegion("livingroom", woodB, livingBand));
  }

  // ---------- Cover rear-modification band (below zWideMin) ----------
  if (shape.kind === "extension") {
    const extRect = rectNorm(shape.extX0, shape.extZ0, shape.extX1, zWideMin);
    // Keep it simple & robust: dedicate to storage/laundry/closet based on size
    const a = rectArea(extRect);
    const md = rectMinDim(extRect);

    if (allowExtraRearRooms) {
      let nm: keyof typeof EXTRA_MINS = "storage";
      if (a + EPS >= EXTRA_MINS.laundry.area && md + EPS >= EXTRA_MINS.laundry.minDim && rng.bool(0.35)) nm = "laundry";
      else if (a + EPS >= EXTRA_MINS.storage.area && md + EPS >= EXTRA_MINS.storage.minDim) nm = "storage";
      else nm = "closet";

      regions.push(rectToRegion(nm, nm === "closet" ? woodA : nm === "storage" ? "concrete_medium" : tileA, extRect));
    } else {
      regions.push(rectToRegion("storage", "concrete_medium", extRect));
    }
  } else if (shape.kind === "notch") {
    // Two wings: left and right below zWideMin
    const leftWing = rectNorm(x0, zRear, shape.notchX0, zWideMin);
    const rightWing = rectNorm(shape.notchX1, zRear, x1, zWideMin);

    const assignWing = (r: Rect): { name: keyof typeof EXTRA_MINS; surface: Surface } => {
      const a = rectArea(r);
      const md = rectMinDim(r);
      if (allowExtraRearRooms && a + EPS >= EXTRA_MINS.storage.area && md + EPS >= EXTRA_MINS.storage.minDim && rng.bool(0.6)) {
        return { name: "storage", surface: "concrete_medium" };
      }
      if (allowExtraRearRooms && a + EPS >= EXTRA_MINS.pantry.area && md + EPS >= EXTRA_MINS.pantry.minDim && rng.bool(0.35)) {
        return { name: "pantry", surface: tileA };
      }
      return { name: "closet", surface: woodA };
    };

    const aL = assignWing(leftWing);
    const aR = assignWing(rightWing);

    regions.push(rectToRegion(aL.name, aL.surface, leftWing));
    regions.push(rectToRegion(aR.name, aR.surface, rightWing));
  }

  // ---------- Full validation ----------
  validateRegionsOrThrow(hn, ctx, hr.points, regions);
  validateInterfacesAndConnectivityOrThrow(hn, regions, drv, ww, zFront);

  return { regions, construction: [], objects: [] };
}

// -------------------- Public API with retries --------------------

export function generateFirstFloorModel(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel): FloorModel {
  const hn = house.houseNumber;

  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return generateAttempt(house, ctx, plot, attempt);
    } catch (e) {
      lastErr = e;
      // Keep retrying; attempt RNG differs deterministically by attempt index.
    }
  }

  if (lastErr instanceof Error) {
    // Preserve the last error message (already prefixed properly in most cases).
    throw lastErr;
  }

  throw new Error(`firstFloor: House ${hn} failed to generate a valid model after ${MAX_ATTEMPTS} attempts`);
}
