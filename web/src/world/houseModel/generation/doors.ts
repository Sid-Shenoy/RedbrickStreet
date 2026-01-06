// web/src/world/houseModel/generation/doors.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, PolyPoints, Region } from "../types";
import type { HouseGenContext } from "./context";

/**
 * DOORS STAGE
 *
 * Adds Door construction elements based on already-generated regions.
 * - Deterministic
 * - Does not modify regions
 * - Required doors: fail-fast with `doors:`-prefixed Errors
 * - Optional doors: best-effort only (never fail the stage)
 *
 * Additional guarantees (this task):
 * - Every house has an exterior door leading to the backyard (rear exterior boundary).
 * - Every room in each indoor layer is accessible via doors from the primary entry region:
 *   - first floor: from `foyer`
 *   - second floor: from `hallway`
 */

export interface Door {
  kind: "door";
  aRegion: number;
  bRegion: number | null;
  hinge: [number, number]; // [x,z]
  end: [number, number]; // [x,z]
}

const EPS = 1e-6;
const COORD_TOL = 1e-4; // regions are quantized to ~1e-3; be slightly tolerant
const MERGE_TOL = 1e-4;

const DOOR_W = 0.8;
const MIN_SEG_HARD = DOOR_W - 1e-6; // hard minimum: door must fit
const MIN_SEG_PREFER = 1.0 - 1e-6; // prefer >=1.0m shared boundary when possible (avoid corner-touching)

type Rect = { x0: number; x1: number; z0: number; z1: number };

// Segment in normalized "1D interval on a fixed axis-aligned line" form.
// - orient="h": horizontal line at z=c, interval [a..b] is x
// - orient="v": vertical line at x=c, interval [a..b] is z
type Seg = { orient: "h" | "v"; c: number; a: number; b: number };

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function q6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function nearlyEq(a: number, b: number, tol = COORD_TOL): boolean {
  return Math.abs(a - b) <= tol;
}
function segLen(s: Seg): number {
  return s.b - s.a;
}
function rectFromRegion(r: Region): Rect {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    return { x0, x1, z0, z1 };
  }
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const [x, z] of r.points) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  return { x0: q(x0, 6), x1: q(x1, 6), z0: q(z0, 6), z1: q(z1, 6) };
}

function ensureAxisAlignedEdge(hn: number, a: [number, number], b: [number, number]) {
  const dx = Math.abs(a[0] - b[0]);
  const dz = Math.abs(a[1] - b[1]);
  if (!((dx <= COORD_TOL && dz > COORD_TOL) || (dz <= COORD_TOL && dx > COORD_TOL))) {
    throw new Error(`doors: House ${hn} polygon edge is not axis-aligned (${a[0]},${a[1]}) -> (${b[0]},${b[1]})`);
  }
}

function regionBoundarySegments(hn: number, r: Region): Seg[] {
  if (r.type === "rectangle") {
    const bb = rectFromRegion(r);
    const x0 = bb.x0,
      x1 = bb.x1,
      z0 = bb.z0,
      z1 = bb.z1;
    return [
      { orient: "h", c: z0, a: Math.min(x0, x1), b: Math.max(x0, x1) },
      { orient: "h", c: z1, a: Math.min(x0, x1), b: Math.max(x0, x1) },
      { orient: "v", c: x0, a: Math.min(z0, z1), b: Math.max(z0, z1) },
      { orient: "v", c: x1, a: Math.min(z0, z1), b: Math.max(z0, z1) },
    ].filter((s) => s.b - s.a > EPS);
  }

  const pts = r.points;
  if (pts.length < 3) return [];

  const segs: Seg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    ensureAxisAlignedEdge(hn, a, b);

    if (nearlyEq(a[0], b[0])) {
      const x = q(a[0], 6);
      const z0 = Math.min(a[1], b[1]);
      const z1 = Math.max(a[1], b[1]);
      if (z1 - z0 > EPS) segs.push({ orient: "v", c: x, a: q(z0, 6), b: q(z1, 6) });
    } else {
      const z = q(a[1], 6);
      const x0 = Math.min(a[0], b[0]);
      const x1 = Math.max(a[0], b[0]);
      if (x1 - x0 > EPS) segs.push({ orient: "h", c: z, a: q(x0, 6), b: q(x1, 6) });
    }
  }
  return segs;
}

function mergeCollinear(segs: Seg[]): Seg[] {
  const groups = new Map<string, Seg[]>();

  for (const s of segs) {
    const cKey = q6(s.c);
    const key = `${s.orient}|${cKey}`;
    const arr = groups.get(key);
    if (arr) arr.push({ ...s, c: cKey });
    else groups.set(key, [{ ...s, c: cKey }]);
  }

  const out: Seg[] = [];
  for (const arr of groups.values()) {
    arr.sort((p, q2) => (p.a !== q2.a ? p.a - q2.a : p.b - q2.b));
    let cur = arr[0]!;
    for (let i = 1; i < arr.length; i++) {
      const nxt = arr[i]!;
      if (nxt.a <= cur.b + MERGE_TOL) {
        cur = { ...cur, b: Math.max(cur.b, nxt.b) };
      } else {
        out.push(cur);
        cur = nxt;
      }
    }
    out.push(cur);
  }

  return out.filter((s) => s.b - s.a > EPS);
}

function overlapSegs(a: Seg, b: Seg): Seg | null {
  if (a.orient !== b.orient) return null;
  if (!nearlyEq(a.c, b.c)) return null;

  const lo = Math.max(a.a, b.a);
  const hi = Math.min(a.b, b.b);
  if (hi - lo <= EPS) return null;

  return { orient: a.orient, c: q6((a.c + b.c) * 0.5), a: q6(lo), b: q6(hi) };
}

function sharedSegmentsBetweenRegions(hn: number, regions: Region[], aIdx: number, bIdx: number): Seg[] {
  const a = regions[aIdx]!;
  const b = regions[bIdx]!;
  const sa = regionBoundarySegments(hn, a);
  const sb = regionBoundarySegments(hn, b);

  const overlaps: Seg[] = [];
  for (const s1 of sa) {
    for (const s2 of sb) {
      const ov = overlapSegs(s1, s2);
      if (ov) overlaps.push(ov);
    }
  }
  return mergeCollinear(overlaps);
}

function sharedSegmentsWithFootprint(hn: number, region: Region, footprintPoly: PolyPoints): Seg[] {
  const regionSegs = regionBoundarySegments(hn, region);

  // Treat footprint polygon boundary as segments.
  const footprintRegion: Region = { name: "houseregion", surface: "black", type: "polygon", points: footprintPoly };
  const footprintSegs = regionBoundarySegments(hn, footprintRegion);

  const overlaps: Seg[] = [];
  for (const s1 of regionSegs) {
    for (const s2 of footprintSegs) {
      const ov = overlapSegs(s1, s2);
      if (ov) overlaps.push(ov);
    }
  }
  return mergeCollinear(overlaps);
}

function bestSegmentOrNull(segs: Seg[], minLen: number): Seg | null {
  const good = segs.filter((s) => segLen(s) + EPS >= minLen);
  if (good.length === 0) return null;

  // Prefer longest; tie-break by stable geometric ordering.
  good.sort((s1, s2) => {
    const dl = segLen(s2) - segLen(s1);
    if (Math.abs(dl) > 1e-9) return dl;

    if (s1.orient !== s2.orient) return s1.orient < s2.orient ? -1 : 1;
    if (Math.abs(s1.c - s2.c) > 1e-9) return s1.c - s2.c;
    if (Math.abs(s1.a - s2.a) > 1e-9) return s1.a - s2.a;
    return s1.b - s2.b;
  });

  return good[0]!;
}

// Prefer a longer shared boundary (>=1.0) when available, but allow >=0.8 to satisfy accessibility.
function bestSegmentPreferOrNull(segs: Seg[], minHard: number, minPrefer: number): Seg | null {
  const preferred = bestSegmentOrNull(segs, minPrefer);
  if (preferred) return preferred;
  return bestSegmentOrNull(segs, minHard);
}

function placeDoorOnSegment(s: Seg): { hinge: [number, number]; end: [number, number] } {
  const L = segLen(s);
  const startMin = s.a;
  const startMax = s.b - DOOR_W;
  const margin = Math.max(0, (L - DOOR_W) * 0.5);

  // Center by default (realistic), clamped safely.
  let start = startMin + margin;
  start = clamp(start, startMin, startMax);

  // Keep on the segment line and quantize lightly (regions are 1e-3-ish).
  start = q(start, 3);

  if (s.orient === "h") {
    const z = q(s.c, 3);
    const x0 = start;
    const x1 = q(x0 + DOOR_W, 3);
    return { hinge: [x0, z], end: [x1, z] };
  } else {
    const x = q(s.c, 3);
    const z0 = start;
    const z1 = q(z0 + DOOR_W, 3);
    return { hinge: [x, z0], end: [x, z1] };
  }
}

function doorWidthOk(d: Door): boolean {
  const dx = Math.abs(d.hinge[0] - d.end[0]);
  const dz = Math.abs(d.hinge[1] - d.end[1]);
  const L = dx + dz;
  return Math.abs(L - DOOR_W) <= 1e-6 && (dx <= 1e-6 || dz <= 1e-6);
}

function withinLotBounds(house: HouseConfig, p: [number, number]): boolean {
  const x = p[0];
  const z = p[1];
  return x + 1e-6 >= 0 && x - 1e-6 <= house.bounds.xsize && z + 1e-6 >= 0 && z - 1e-6 <= 30;
}

function doorOnAnySegment(d: Door, segs: Seg[]): boolean {
  // Check that both endpoints lie on the same merged candidate segment.
  // Since segments are axis-aligned, we can just check constant coord and interval containment.
  for (const s of segs) {
    if (s.orient === "h") {
      const z = s.c;
      if (!nearlyEq(d.hinge[1], z, 2e-3) || !nearlyEq(d.end[1], z, 2e-3)) continue;
      const x0 = Math.min(d.hinge[0], d.end[0]);
      const x1 = Math.max(d.hinge[0], d.end[0]);
      if (x0 + 1e-6 >= s.a && x1 - 1e-6 <= s.b) return true;
    } else {
      const x = s.c;
      if (!nearlyEq(d.hinge[0], x, 2e-3) || !nearlyEq(d.end[0], x, 2e-3)) continue;
      const z0 = Math.min(d.hinge[1], d.end[1]);
      const z1 = Math.max(d.hinge[1], d.end[1]);
      if (z0 + 1e-6 >= s.a && z1 - 1e-6 <= s.b) return true;
    }
  }
  return false;
}

function idxFirst(regions: Region[], name: string): number {
  return regions.findIndex((r) => r.name === name);
}
function idxAll(regions: Region[], name: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    if (regions[i]!.name === name) out.push(i);
  }
  return out;
}
function idxAllByPredicate(regions: Region[], pred: (r: Region) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    if (pred(regions[i]!)) out.push(i);
  }
  return out;
}

function getPlotRegion(plot: FloorModel, hn: number, name: string): Region {
  const r = plot.regions.find((x) => x.name === name);
  if (!r) throw new Error(`doors: House ${hn} plot missing region '${name}'`);
  return r;
}

function getHouseRegionPoly(plot: FloorModel, hn: number): PolyPoints {
  const hr = plot.regions.find((r) => r.name === "houseregion");
  if (!hr || hr.type !== "polygon") throw new Error(`doors: House ${hn} plot missing houseregion polygon`);
  return hr.points;
}

function houseFrontZ(housePoly: PolyPoints): number {
  let zMax = -Infinity;
  for (const [, z] of housePoly) zMax = Math.max(zMax, z);
  return q(zMax, 3);
}

function houseBackZ(housePoly: PolyPoints): number {
  let zMin = Infinity;
  for (const [, z] of housePoly) zMin = Math.min(zMin, z);
  return q(zMin, 3);
}

function doorKey(a: number, b: number | null): string {
  if (b === null) return `e|${a}`;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `i|${lo}|${hi}`;
}

function addInteriorDoorRequired(
  hn: number,
  house: HouseConfig,
  regions: Region[],
  doors: Door[],
  seen: Set<string>,
  aIdx: number,
  bIdx: number,
  label: string
) {
  const key = doorKey(aIdx, bIdx);
  if (seen.has(key)) return;

  const shared = sharedSegmentsBetweenRegions(hn, regions, aIdx, bIdx);
  const best = bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER);
  if (!best) {
    throw new Error(`doors: House ${hn} cannot place '${label}' (no shared boundary segment >= ${DOOR_W} m)`);
  }

  const { hinge, end } = placeDoorOnSegment(best);
  const d: Door = { kind: "door", aRegion: aIdx, bRegion: bIdx, hinge, end };

  // Invariant checks (hard)
  if (!doorWidthOk(d)) {
    throw new Error(`doors: House ${hn} internal error: placed door for '${label}' has invalid width/axis`);
  }
  if (!withinLotBounds(house, hinge) || !withinLotBounds(house, end)) {
    throw new Error(`doors: House ${hn} internal error: placed door for '${label}' out of lot bounds`);
  }
  if (!doorOnAnySegment(d, shared)) {
    throw new Error(`doors: House ${hn} internal error: placed door for '${label}' not on computed shared boundary`);
  }

  doors.push(d);
  seen.add(key);
}

function addInteriorDoorOptional(
  hn: number,
  house: HouseConfig,
  regions: Region[],
  doors: Door[],
  seen: Set<string>,
  aIdx: number,
  bIdx: number,
  _label: string
) {
  const key = doorKey(aIdx, bIdx);
  if (seen.has(key)) return;

  const shared = sharedSegmentsBetweenRegions(hn, regions, aIdx, bIdx);
  const best = bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER);
  if (!best) return;

  const { hinge, end } = placeDoorOnSegment(best);
  const d: Door = { kind: "door", aRegion: aIdx, bRegion: bIdx, hinge, end };

  if (!doorWidthOk(d)) return;
  if (!withinLotBounds(house, hinge) || !withinLotBounds(house, end)) return;
  if (!doorOnAnySegment(d, shared)) return;

  doors.push(d);
  seen.add(key);
}

function addExteriorFrontDoorRequired(
  hn: number,
  house: HouseConfig,
  plot: FloorModel,
  firstFloor: FloorModel,
  doors: Door[],
  seen: Set<string>
) {
  const regions = firstFloor.regions;

  const foyerIdx = idxFirst(regions, "foyer");
  if (foyerIdx < 0) throw new Error(`doors: House ${hn} missing required region 'foyer'`);

  const foyer = regions[foyerIdx]!;
  const foyerBB = rectFromRegion(foyer);

  const walkway = getPlotRegion(plot, hn, "walkway");
  if (walkway.type !== "rectangle") throw new Error(`doors: House ${hn} plot walkway must be rectangle`);
  const ww = rectFromRegion(walkway);

  const housePoly = getHouseRegionPoly(plot, hn);
  const zFront = houseFrontZ(housePoly);

  // Candidate x overlap: foyer front edge and walkway alignment.
  const x0 = Math.max(foyerBB.x0, ww.x0);
  const x1 = Math.min(foyerBB.x1, ww.x1);

  if (x1 - x0 + EPS < DOOR_W) {
    throw new Error(
      `doors: House ${hn} cannot place 'foyer->outside' (walkway overlap too small: ${q(x1 - x0, 3)} m)`
    );
  }

  // Ensure the segment is actually on the footprint boundary (exterior).
  const footprintSegs = sharedSegmentsWithFootprint(hn, foyer, housePoly);
  const frontFootSegs = footprintSegs.filter((s) => s.orient === "h" && nearlyEq(s.c, zFront, 2e-3));
  const bestFront = bestSegmentPreferOrNull(frontFootSegs, DOOR_W, MIN_SEG_PREFER);
  if (!bestFront) {
    throw new Error(`doors: House ${hn} cannot place 'foyer->outside' (foyer has no exterior front edge on footprint)`);
  }

  // Restrict to the walkway-overlap window on the front line.
  const windowSeg: Seg = { orient: "h", c: bestFront.c, a: q6(x0), b: q6(x1) };
  const best = bestSegmentPreferOrNull(mergeCollinear([windowSeg]), DOOR_W, MIN_SEG_PREFER);
  if (!best) {
    throw new Error(`doors: House ${hn} cannot place 'foyer->outside' (no ${DOOR_W} m span within walkway window)`);
  }

  const { hinge, end } = placeDoorOnSegment(best);
  const d: Door = { kind: "door", aRegion: foyerIdx, bRegion: null, hinge, end };

  const key = doorKey(foyerIdx, null);
  if (seen.has(key)) return;

  if (!doorWidthOk(d)) throw new Error(`doors: House ${hn} internal error: exterior door has invalid width/axis`);
  if (!withinLotBounds(house, hinge) || !withinLotBounds(house, end)) {
    throw new Error(`doors: House ${hn} internal error: exterior door out of lot bounds`);
  }
  // Ensure door is on an exterior boundary segment.
  if (!doorOnAnySegment(d, frontFootSegs)) {
    throw new Error(`doors: House ${hn} internal error: exterior door not on footprint boundary`);
  }

  doors.push(d);
  seen.add(key);
}

function addExteriorBackDoorRequired(
  hn: number,
  house: HouseConfig,
  plot: FloorModel,
  firstFloor: FloorModel,
  doors: Door[],
  seen: Set<string>
) {
  const regions = firstFloor.regions;

  // Plot precondition (also documents intent)
  const backyard = getPlotRegion(plot, hn, "backyard");
  void backyard;

  const housePoly = getHouseRegionPoly(plot, hn);
  const zBack = houseBackZ(housePoly);

  // Find the best rear-boundary segment on the footprint, owned by some first-floor region.
  let bestChoice: { idx: number; seg: Seg; segs: Seg[] } | null = null;

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    if (r.surface === "void") continue;

    const footprintSegs = sharedSegmentsWithFootprint(hn, r, housePoly);
    const backFootSegs = footprintSegs.filter((s) => s.orient === "h" && nearlyEq(s.c, zBack, 2e-3));

    const bestBack = bestSegmentPreferOrNull(backFootSegs, DOOR_W, MIN_SEG_PREFER);
    if (!bestBack) continue;

    if (
      !bestChoice ||
      segLen(bestBack) > segLen(bestChoice.seg) + 1e-9 ||
      (Math.abs(segLen(bestBack) - segLen(bestChoice.seg)) <= 1e-9 && i < bestChoice.idx)
    ) {
      bestChoice = { idx: i, seg: bestBack, segs: backFootSegs };
    }
  }

  if (!bestChoice) {
    throw new Error(`doors: House ${hn} cannot place 'inside->backyard' (no rear exterior segment >= ${DOOR_W} m)`);
  }

  const key = doorKey(bestChoice.idx, null);
  if (seen.has(key)) return;

  const { hinge, end } = placeDoorOnSegment(bestChoice.seg);
  const d: Door = { kind: "door", aRegion: bestChoice.idx, bRegion: null, hinge, end };

  if (!doorWidthOk(d)) throw new Error(`doors: House ${hn} internal error: backyard door has invalid width/axis`);
  if (!withinLotBounds(house, hinge) || !withinLotBounds(house, end)) {
    throw new Error(`doors: House ${hn} internal error: backyard door out of lot bounds`);
  }
  if (!doorOnAnySegment(d, bestChoice.segs)) {
    throw new Error(`doors: House ${hn} internal error: backyard door not on footprint rear boundary`);
  }

  doors.push(d);
  seen.add(key);
}

// -------------------- Accessibility enforcement --------------------

function buildDoorAdjacency(doors: Door[], regionCount: number): number[][] {
  const adj: number[][] = Array.from({ length: regionCount }, () => []);
  for (const d of doors) {
    if (d.bRegion === null) continue;
    const a = d.aRegion;
    const b = d.bRegion;
    if (a < 0 || a >= regionCount || b < 0 || b >= regionCount) continue;
    adj[a]!.push(b);
    adj[b]!.push(a);
  }
  return adj;
}

function bfsReachable(adj: number[][], root: number, active: boolean[]): boolean[] {
  const reachable = Array.from({ length: adj.length }, () => false);
  if (root < 0 || root >= adj.length) return reachable;
  if (!active[root]) return reachable;

  const stack: number[] = [root];
  reachable[root] = true;

  while (stack.length) {
    const cur = stack.pop()!;
    for (const nxt of adj[cur]!) {
      if (!active[nxt] || reachable[nxt]) continue;
      reachable[nxt] = true;
      stack.push(nxt);
    }
  }

  return reachable;
}

function ensureAllRoomsAccessible(
  hn: number,
  house: HouseConfig,
  regions: Region[],
  doors: Door[],
  seen: Set<string>,
  rootIdx: number,
  layerLabel: "firstFloor" | "secondFloor"
) {
  const active = regions.map((r) => r.surface !== "void");
  if (rootIdx < 0 || !active[rootIdx]) {
    throw new Error(`doors: House ${hn} ${layerLabel} cannot enforce accessibility (invalid root region index)`);
  }

  // Add doors until all active rooms are reachable from root, or fail-fast if impossible.
  // Bounded by number of regions: each iteration must add at least one new reachable region.
  for (let guard = 0; guard < regions.length + 2; guard++) {
    const adj = buildDoorAdjacency(doors, regions.length);
    const reachable = bfsReachable(adj, rootIdx, active);

    let allOk = true;
    for (let i = 0; i < regions.length; i++) {
      if (active[i] && !reachable[i]) {
        allOk = false;
        break;
      }
    }
    if (allOk) return;

    // Find best connection from reachable -> unreachable.
    let bestEdge: { a: number; b: number; seg: Seg } | null = null;

    for (let a = 0; a < regions.length; a++) {
      if (!reachable[a]) continue;

      for (let b = 0; b < regions.length; b++) {
        if (!active[b] || reachable[b] || a === b) continue;

        const shared = sharedSegmentsBetweenRegions(hn, regions, a, b);
        const seg = bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER);
        if (!seg) continue;

        if (
          !bestEdge ||
          segLen(seg) > segLen(bestEdge.seg) + 1e-9 ||
          (Math.abs(segLen(seg) - segLen(bestEdge.seg)) <= 1e-9 &&
            (a < bestEdge.a || (a === bestEdge.a && b < bestEdge.b)))
        ) {
          bestEdge = { a, b, seg };
        }
      }
    }

    if (!bestEdge) {
      // Provide a stable "first unreachable" diagnostic.
      let firstUnreach = -1;
      for (let i = 0; i < regions.length; i++) {
        if (active[i] && !reachable[i]) {
          firstUnreach = i;
          break;
        }
      }
      const nm = firstUnreach >= 0 ? regions[firstUnreach]!.name : "unknown";
      throw new Error(
        `doors: House ${hn} ${layerLabel} accessibility failed (cannot connect unreachable region '${nm}' index=${firstUnreach}; no shared boundary segment >= ${DOOR_W} m to reachable rooms)`
      );
    }

    const aNm = regions[bestEdge.a]!.name;
    const bNm = regions[bestEdge.b]!.name;
    addInteriorDoorRequired(
      hn,
      house,
      regions,
      doors,
      seen,
      bestEdge.a,
      bestEdge.b,
      `access:${layerLabel}:${aNm}(${bestEdge.a})->${bNm}(${bestEdge.b})`
    );
    // loop continues; reachable set should expand next iteration.
  }

  throw new Error(`doors: House ${hn} ${layerLabel} accessibility failed (iteration guard tripped)`);
}

// -------------------- First floor doors --------------------

function makeFirstFloorDoors(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel, firstFloor: FloorModel): Door[] {
  const hn = house.houseNumber;
  const regions = firstFloor.regions;

  const doors: Door[] = [];
  const seen = new Set<string>();

  // --- Required: exterior doors ---
  addExteriorFrontDoorRequired(hn, house, plot, firstFloor, doors, seen);
  addExteriorBackDoorRequired(hn, house, plot, firstFloor, doors, seen); // <-- backyard door guarantee

  // --- Required interior doors ---
  const iGarage = idxFirst(regions, "garage");
  const iFoyer = idxFirst(regions, "foyer");
  const iHall = idxFirst(regions, "hallway");
  const iLiving = idxFirst(regions, "livingroom");
  const iKitchen = idxFirst(regions, "kitchen");
  const iBath = idxFirst(regions, "bathroom_small");
  const iStairs = idxFirst(regions, "stairs");

  if (iGarage < 0) throw new Error(`doors: House ${hn} missing required region 'garage'`);
  if (iFoyer < 0) throw new Error(`doors: House ${hn} missing required region 'foyer'`);
  if (iHall < 0) throw new Error(`doors: House ${hn} missing required region 'hallway'`);
  if (iLiving < 0) throw new Error(`doors: House ${hn} missing required region 'livingroom'`);
  if (iKitchen < 0) throw new Error(`doors: House ${hn} missing required region 'kitchen'`);
  if (iBath < 0) throw new Error(`doors: House ${hn} missing required region 'bathroom_small'`);
  if (iStairs < 0) throw new Error(`doors: House ${hn} missing required region 'stairs'`);

  // foyer -> (hallway OR livingroom) depending on adjacency
  {
    const segFH = sharedSegmentsBetweenRegions(hn, regions, iFoyer, iHall);
    const segFL = sharedSegmentsBetweenRegions(hn, regions, iFoyer, iLiving);

    const canFH = bestSegmentPreferOrNull(segFH, MIN_SEG_HARD, MIN_SEG_PREFER);
    const canFL = bestSegmentPreferOrNull(segFL, MIN_SEG_HARD, MIN_SEG_PREFER);

    if (canFH) addInteriorDoorRequired(hn, house, regions, doors, seen, iFoyer, iHall, "foyer->hallway");
    else if (canFL) addInteriorDoorRequired(hn, house, regions, doors, seen, iFoyer, iLiving, "foyer->livingroom");
    else {
      throw new Error(`doors: House ${hn} cannot place 'foyer->(hallway|livingroom)' (no shared boundary >= ${DOOR_W} m)`);
    }
  }

  // hallway -> stairs
  addInteriorDoorRequired(hn, house, regions, doors, seen, iHall, iStairs, "hallway->stairs");

  // hallway -> bathroom_small
  addInteriorDoorRequired(hn, house, regions, doors, seen, iHall, iBath, "hallway->bathroom_small");

  // kitchen -> (livingroom OR diningroom OR hallway) depending on adjacency
  {
    const iDining = idxFirst(regions, "diningroom");

    const candidates: Array<{ idx: number; label: string }> = [];
    candidates.push({ idx: iLiving, label: "kitchen->livingroom" });
    if (iDining >= 0) candidates.push({ idx: iDining, label: "kitchen->diningroom" });
    candidates.push({ idx: iHall, label: "kitchen->hallway" });

    let placed = false;
    for (const c of candidates) {
      const shared = sharedSegmentsBetweenRegions(hn, regions, iKitchen, c.idx);
      if (bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER)) {
        addInteriorDoorRequired(hn, house, regions, doors, seen, iKitchen, c.idx, c.label);
        placed = true;
        break;
      }
    }
    if (!placed) {
      throw new Error(
        `doors: House ${hn} cannot place 'kitchen->(livingroom|diningroom|hallway)' (no shared boundary >= ${DOOR_W} m)`
      );
    }
  }

  // garage -> (hallway OR mudroom OR foyer) depending on adjacency
  {
    const iMud = idxFirst(regions, "mudroom");
    const candidates: Array<{ idx: number; label: string }> = [];
    if (iMud >= 0) candidates.push({ idx: iMud, label: "garage->mudroom" });
    candidates.push({ idx: iHall, label: "garage->hallway" });
    candidates.push({ idx: iFoyer, label: "garage->foyer" });

    let placed = false;
    for (const c of candidates) {
      const shared = sharedSegmentsBetweenRegions(hn, regions, iGarage, c.idx);
      if (bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER)) {
        addInteriorDoorRequired(hn, house, regions, doors, seen, iGarage, c.idx, c.label);
        placed = true;
        break;
      }
    }
    if (!placed) {
      throw new Error(
        `doors: House ${hn} cannot place 'garage->(hallway|mudroom|foyer)' (no shared boundary >= ${DOOR_W} m)`
      );
    }
  }

  // --- Optional doors (best-effort only) ---
  // Note: Optional connectivity is encouraged, not required; never fail this stage for optional rooms.
  // We also avoid over-connecting by using a simple, realistic default set.

  // diningroom: connect to kitchen (prefer) or livingroom
  {
    const iDining = idxFirst(regions, "diningroom");
    if (iDining >= 0) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iDining, iKitchen, "diningroom->kitchen");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iDining, iLiving, "diningroom->livingroom");
    }
  }

  // mudroom: connect to garage (prefer) or hallway
  {
    const iMud = idxFirst(regions, "mudroom");
    if (iMud >= 0) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iMud, iGarage, "mudroom->garage");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iMud, iHall, "mudroom->hallway");
    }
  }

  // pantry: connect to kitchen
  {
    const iPantry = idxFirst(regions, "pantry");
    if (iPantry >= 0) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iPantry, iKitchen, "pantry->kitchen");
    }
  }

  // laundry: prefer hallway, then mudroom, then garage
  {
    const iLaundry = idxFirst(regions, "laundry");
    const iMud = idxFirst(regions, "mudroom");
    if (iLaundry >= 0) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iLaundry, iHall, "laundry->hallway");
      if (iMud >= 0) addInteriorDoorOptional(hn, house, regions, doors, seen, iLaundry, iMud, "laundry->mudroom");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iLaundry, iGarage, "laundry->garage");
    }
  }

  // office: prefer hallway, else livingroom
  {
    const iOffice = idxFirst(regions, "office");
    if (iOffice >= 0) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iOffice, iHall, "office->hallway");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iOffice, iLiving, "office->livingroom");
    }
  }

  // closets (0..N): try to connect each to hallway; if not possible, try foyer/livingroom/kitchen.
  {
    const closets = idxAll(regions, "closet");
    for (const iC of closets) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iHall, "closet->hallway");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iFoyer, "closet->foyer");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iLiving, "closet->livingroom");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iKitchen, "closet->kitchen");
    }
  }

  // storage (0..N): try hallway, then garage
  {
    const storages = idxAll(regions, "storage");
    for (const iS of storages) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iS, iHall, "storage->hallway");
      addInteriorDoorOptional(hn, house, regions, doors, seen, iS, iGarage, "storage->garage");
    }
  }

  // Ensure every first-floor room is accessible from foyer (adds additional doors if necessary).
  ensureAllRoomsAccessible(hn, house, regions, doors, seen, iFoyer, "firstFloor");

  // (ctx currently unused; door placement is purely geometric and deterministic)
  void ctx;

  return doors;
}

// -------------------- Second floor doors --------------------

function makeSecondFloorDoors(house: HouseConfig, secondFloor: FloorModel): Door[] {
  const hn = house.houseNumber;
  const regions = secondFloor.regions;

  const doors: Door[] = [];
  const seen = new Set<string>();

  const iHall = idxFirst(regions, "hallway");
  if (iHall < 0) throw new Error(`doors: House ${hn} secondFloor missing required region 'hallway'`);

  // Required: every bedroom has exactly one door to hallway.
  const bedroomIdx = idxAllByPredicate(regions, (r) => r.name === "bedroom" && r.surface !== "void");
  for (const iB of bedroomIdx) {
    addInteriorDoorRequired(hn, house, regions, doors, seen, iB, iHall, `bedroom(${iB})->hallway`);
  }

  // Required: every bathroom (small/large) has exactly one door to hallway.
  const bathIdx = idxAllByPredicate(
    regions,
    (r) => (r.name === "bathroom_small" || r.name === "bathroom_large") && r.surface !== "void"
  );
  for (const iB of bathIdx) {
    addInteriorDoorRequired(hn, house, regions, doors, seen, iB, iHall, `${regions[iB]!.name}(${iB})->hallway`);
  }

  // Optional: closets (0..N): connect to a touching bedroom if possible, else to hallway.
  const closets = idxAllByPredicate(regions, (r) => r.name === "closet" && r.surface !== "void");
  for (const iC of closets) {
    // Prefer a bedroom neighbor (more realistic), but only if feasible.
    let placed = false;
    for (const iB of bedroomIdx) {
      const shared = sharedSegmentsBetweenRegions(hn, regions, iC, iB);
      if (bestSegmentPreferOrNull(shared, MIN_SEG_HARD, MIN_SEG_PREFER)) {
        addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iB, `closet(${iC})->bedroom(${iB})`);
        placed = true;
        break;
      }
    }
    if (!placed) {
      addInteriorDoorOptional(hn, house, regions, doors, seen, iC, iHall, `closet(${iC})->hallway`);
    }
  }

  // Ensure every second-floor room is accessible from hallway (adds additional doors if necessary).
  ensureAllRoomsAccessible(hn, house, regions, doors, seen, iHall, "secondFloor");

  return doors;
}

export function generateDoors(
  house: HouseConfig,
  ctx: HouseGenContext,
  plot: FloorModel,
  firstFloor: FloorModel,
  secondFloor: FloorModel
): { firstFloorDoors: Door[]; secondFloorDoors: Door[] } {
  const hn = house.houseNumber;

  // Basic preconditions (stage-local)
  if (house.bounds.zsize !== 30) {
    throw new Error(`doors: House ${hn} has zsize=${house.bounds.zsize}, expected 30`);
  }

  const firstFloorDoors = makeFirstFloorDoors(house, ctx, plot, firstFloor);
  const secondFloorDoors = makeSecondFloorDoors(house, secondFloor);

  // Final invariant checks (hard)
  for (const d of [...firstFloorDoors, ...secondFloorDoors]) {
    if (!doorWidthOk(d)) throw new Error(`doors: House ${hn} produced a door with invalid geometry`);
    if (!withinLotBounds(house, d.hinge) || !withinLotBounds(house, d.end)) {
      throw new Error(`doors: House ${hn} produced a door out of lot-local bounds`);
    }
  }

  // Guarantee: at least one exterior backyard door exists (first floor).
  {
    const regions = firstFloor.regions;
    const housePoly = getHouseRegionPoly(plot, hn);
    const zBack = houseBackZ(housePoly);

    const hasBackDoor = firstFloorDoors.some((d) => {
      if (d.bRegion !== null) return false;
      // door lies on rear boundary line
      const z0 = d.hinge[1];
      const z1 = d.end[1];
      return nearlyEq(z0, zBack, 2e-3) && nearlyEq(z1, zBack, 2e-3) && d.aRegion >= 0 && d.aRegion < regions.length;
    });

    if (!hasBackDoor) {
      throw new Error(`doors: House ${hn} internal error: missing required backyard exterior door after generation`);
    }
  }

  return { firstFloorDoors, secondFloorDoors };
}
