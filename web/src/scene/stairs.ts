import { MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

import type { HouseWithModel, Region, StairsLeadDir, Surface } from "../world/houseModel/types";
import type { Door } from "../world/houseModel/generation/doors";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { BOUNDARY_WALL_T, FIRST_FLOOR_Y, SECOND_FLOOR_Y, SURFACE_TEX_METERS } from "./constants";
import { applyWorldBoxUVs } from "./uvs";

type Rect = { x0: number; x1: number; z0: number; z1: number };
type Side = "top" | "right" | "bottom" | "left";

type Corner = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";

function cornerCenter(r: Rect, corner: Corner, size: number): { x: number; z: number } {
  const h = size * 0.5;

  if (corner === "topLeft") return { x: r.x0 + h, z: r.z0 + h };
  if (corner === "topRight") return { x: r.x1 - h, z: r.z0 + h };
  if (corner === "bottomRight") return { x: r.x1 - h, z: r.z1 - h };
  return { x: r.x0 + h, z: r.z1 - h };
}

function cornerForTurn(prev: Side, next: Side): Corner | null {
  // Clockwise turns only (pointAtU walks clockwise).
  if (prev === "top" && next === "right") return "topRight";
  if (prev === "right" && next === "bottom") return "bottomRight";
  if (prev === "bottom" && next === "left") return "bottomLeft";
  if (prev === "left" && next === "top") return "topLeft";
  return null;
}

function nearestCornerOnSide(r: Rect, side: Side, x: number, z: number): Corner {
  const mx = (r.x0 + r.x1) * 0.5;
  const mz = (r.z0 + r.z1) * 0.5;

  if (side === "top") return x <= mx ? "topLeft" : "topRight";
  if (side === "right") return z <= mz ? "topRight" : "bottomRight";
  if (side === "bottom") return x >= mx ? "bottomRight" : "bottomLeft";
  return z >= mz ? "bottomLeft" : "topLeft";
}

const STEP_THICK = 0.10; // 10 cm
const STEP_RUN_DESIRED = 0.48; // horizontal spacing target (meters)
const TOP_STEPS_FORCE_OPENING = 6; // ensure the last few steps are definitely inside the stairs_opening shaft

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function rectFromPoints(points: [[number, number], [number, number]]): Rect {
  const [[ax, az], [bx, bz]] = points;
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const z0 = Math.min(az, bz);
  const z1 = Math.max(az, bz);
  return { x0, x1, z0, z1 };
}

function rectW(r: Rect) {
  return r.x1 - r.x0;
}

function rectH(r: Rect) {
  return r.z1 - r.z0;
}

function rectMinDim(r: Rect) {
  return Math.min(rectW(r), rectH(r));
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0);
  const x1 = Math.min(a.x1, b.x1);
  const z0 = Math.max(a.z0, b.z0);
  const z1 = Math.min(a.z1, b.z1);
  if (x1 <= x0 + 1e-6) return null;
  if (z1 <= z0 + 1e-6) return null;
  return { x0, x1, z0, z1 };
}

function insetRectSafe(r: Rect, desiredInset: number): Rect {
  const w = rectW(r);
  const h = rectH(r);

  // Never inset more than 25% of min dimension (guarantees non-degenerate).
  const maxInset = 0.25 * Math.min(w, h);
  const inset = Math.min(desiredInset, maxInset);

  return {
    x0: r.x0 + inset,
    x1: r.x1 - inset,
    z0: r.z0 + inset,
    z1: r.z1 - inset,
  };
}

function sideIndex(s: Side): number {
  if (s === "top") return 0;
  if (s === "right") return 1;
  if (s === "bottom") return 2;
  return 3;
}

function sideFromIndex(i: number): Side {
  const m = ((i % 4) + 4) % 4;
  if (m === 0) return "top";
  if (m === 1) return "right";
  if (m === 2) return "bottom";
  return "left";
}

function prevClockwiseSide(openSide: Side): Side {
  // Clockwise order: top -> right -> bottom -> left -> top
  // Previous (clockwise-before): right<-top, bottom<-right, left<-bottom, top<-left
  if (openSide === "right") return "top";
  if (openSide === "bottom") return "right";
  if (openSide === "left") return "bottom";
  return "left";
}

function stairsLeadDirToOpenSide(dir: StairsLeadDir): Side {
  if (dir === "+x") return "right";
  if (dir === "-x") return "left";
  if (dir === "+z") return "bottom";
  return "top"; // "-z"
}

function perimeterLen(r: Rect): number {
  return 2 * (rectW(r) + rectH(r));
}

function pointAtU(r: Rect, u: number): { x: number; z: number; side: Side } {
  const w = rectW(r);
  const h = rectH(r);
  const P = 2 * (w + h);

  // Normalize u to [0,1)
  const uu = ((u % 1) + 1) % 1;
  let s = uu * P;

  // Clockwise from top-left corner:
  // top edge:    (x0,z0) -> (x1,z0)  length w
  // right edge:  (x1,z0) -> (x1,z1)  length h
  // bottom edge: (x1,z1) -> (x0,z1)  length w
  // left edge:   (x0,z1) -> (x0,z0)  length h
  if (s < w) {
    return { x: r.x0 + s, z: r.z0, side: "top" };
  }
  s -= w;

  if (s < h) {
    return { x: r.x1, z: r.z0 + s, side: "right" };
  }
  s -= h;

  if (s < w) {
    return { x: r.x1 - s, z: r.z1, side: "bottom" };
  }
  s -= w;

  return { x: r.x0, z: r.z1 - s, side: "left" };
}

function uFromPointOnSide(r: Rect, side: Side, x: number, z: number): number {
  const w = rectW(r);
  const h = rectH(r);
  const P = 2 * (w + h);

  let s = 0;

  if (side === "top") {
    s = x - r.x0;
  } else if (side === "right") {
    s = w + (z - r.z0);
  } else if (side === "bottom") {
    s = w + h + (r.x1 - x);
  } else {
    s = 2 * w + h + (r.z1 - z);
  }

  return s / P;
}

function nearestSide(r: Rect, p: { x: number; z: number }): Side {
  const dTop = Math.abs(p.z - r.z0);
  const dRight = Math.abs(p.x - r.x1);
  const dBottom = Math.abs(p.z - r.z1);
  const dLeft = Math.abs(p.x - r.x0);

  let best: Side = "top";
  let bestD = dTop;

  if (dRight < bestD) {
    bestD = dRight;
    best = "right";
  }
  if (dBottom < bestD) {
    bestD = dBottom;
    best = "bottom";
  }
  if (dLeft < bestD) {
    best = "left";
  }

  return best;
}

function projectToSide(r: Rect, side: Side, p: { x: number; z: number }, margin: number): { x: number; z: number } {
  if (side === "top") {
    return { x: clamp(p.x, r.x0 + margin, r.x1 - margin), z: r.z0 };
  }
  if (side === "right") {
    return { x: r.x1, z: clamp(p.z, r.z0 + margin, r.z1 - margin) };
  }
  if (side === "bottom") {
    return { x: clamp(p.x, r.x0 + margin, r.x1 - margin), z: r.z1 };
  }
  return { x: r.x0, z: clamp(p.z, r.z0 + margin, r.z1 - margin) };
}

function isDoorElement(v: unknown): v is Door {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<Door>;
  if (o.kind !== "door") return false;

  const aOk = typeof o.aRegion === "number";
  const bOk = o.bRegion === null || typeof o.bRegion === "number";

  const hingeOk =
    Array.isArray(o.hinge) &&
    o.hinge.length === 2 &&
    typeof o.hinge[0] === "number" &&
    typeof o.hinge[1] === "number";

  const endOk =
    Array.isArray(o.end) &&
    o.end.length === 2 &&
    typeof o.end[0] === "number" &&
    typeof o.end[1] === "number";

  return aOk && bOk && hingeOk && endOk;
}

function findFirstRectRegion(regions: Region[], name: string): { idx: number; rect: Rect; surface: Surface; meta?: Region["meta"] } | null {
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]!;
    if (r.name !== name) continue;
    if (r.type !== "rectangle") continue;
    const rect = rectFromPoints(r.points);
    return { idx: i, rect, surface: r.surface, meta: r.meta };
  }
  return null;
}

function findFirstRegionIndex(regions: Region[], name: string): number | null {
  for (let i = 0; i < regions.length; i++) {
    if (regions[i]!.name === name) return i;
  }
  return null;
}

function cwDistU(u0: number, u1: number): number {
  const a = ((u0 % 1) + 1) % 1;
  const b = ((u1 % 1) + 1) % 1;
  return b >= a ? b - a : b + 1 - a;
}

function inwardFromDoorOnRect(stairsRect: Rect, door: Door): { x: number; z: number } | null {
  const hx = door.hinge[0];
  const hz = door.hinge[1];
  const ex = door.end[0];
  const ez = door.end[1];

  const dx = ex - hx;
  const dz = ez - hz;

  // Vertical door segment (x constant)
  if (Math.abs(dx) <= 1e-6 && Math.abs(dz) > 1e-6) {
    const x = hx;
    const dL = Math.abs(x - stairsRect.x0);
    const dR = Math.abs(x - stairsRect.x1);
    return dL <= dR ? { x: +1, z: 0 } : { x: -1, z: 0 };
  }

  // Horizontal door segment (z constant)
  if (Math.abs(dz) <= 1e-6 && Math.abs(dx) > 1e-6) {
    const z = hz;
    const dT = Math.abs(z - stairsRect.z0);
    const dB = Math.abs(z - stairsRect.z1);
    return dT <= dB ? { x: 0, z: +1 } : { x: 0, z: -1 };
  }

  return null;
}

function pickMat(mats: Record<string, StandardMaterial>, surface: Surface): StandardMaterial {
  const m = mats[surface];
  if (m) return m;
  // Safe fallback that always exists in this project’s material set.
  // (wood_medium is a core surface and is used elsewhere as a default stair surface.)
  return mats["wood_medium"] ?? Object.values(mats)[0]!;
}

export function renderStairs(scene: Scene, houses: HouseWithModel[], mats: Record<string, StandardMaterial>) {
  const totalRise = SECOND_FLOOR_Y - FIRST_FLOOR_Y;

  // Choose a step count that:
  // - keeps riser <= 0.5m (auto-step can handle),
  // - keeps riser > STEP_THICK (guarantees no step/step volume overlap).
  // We clamp to a safe band and keep it deterministic.
  const minN = Math.ceil(totalRise / 0.5);
  const maxN = Math.floor(totalRise / (STEP_THICK + 0.01));
  const preferredN = Math.round(totalRise / 0.17); // realistic ~17cm riser
  const N = clamp(preferredN, minN, maxN);

  const rise = totalRise / N;

  // Keep steps clear of boundary wall collision thickness.
  // Wall collision boxes are centered on the wall line (±BOUNDARY_WALL_T/2).
  const inset = BOUNDARY_WALL_T * 0.5 + 0.02;

  for (const house of houses) {
    const first = house.model.firstFloor;
    const second = house.model.secondFloor;

    const stairs = findFirstRectRegion(first.regions, "stairs");
    const opening = findFirstRectRegion(second.regions, "stairs_opening");

    if (!stairs || !opening) {
      // Model invariants should guarantee these exist; skip rendering rather than crashing.
      // (A missing stairs_opening would already break gameplay regardless.)
      // eslint-disable-next-line no-console
      console.error(`[RBS] house ${house.houseNumber}: missing stairs or stairs_opening region; skipping stairs render.`);
      continue;
    }

    const lead = opening.meta?.stairsLeadDir as StairsLeadDir | undefined;
    if (!lead) {
      // eslint-disable-next-line no-console
      console.error(`[RBS] house ${house.houseNumber}: stairs_opening.meta.stairsLeadDir missing; skipping stairs render.`);
      continue;
    }

    // Base stairwell rectangle: always guaranteed inside the real stairs room (no overlaps with other rooms),
    // and (when possible) also inside the second-floor void opening (guarantees the top cannot intersect 2F floor).
    const stairsRect = stairs.rect;
    const openingRect = opening.rect;

    const clippedOpening = intersectRect(openingRect, stairsRect) ?? openingRect;
    const shaft = intersectRect(stairsRect, openingRect);

    // Prefer the intersection if it’s usable; otherwise fall back to the full stairs rectangle.
    const baseRectRaw =
      shaft && rectMinDim(shaft) >= 0.9
        ? shaft
        : stairsRect;

    const baseRect = insetRectSafe(baseRectRaw, inset);
    const topRect = insetRectSafe(clippedOpening, inset);

    // Stair material must match the first-floor "stairs" region surface.
    const stairMat = pickMat(mats, stairs.surface);

    // Identify the hallway->stairs doorway (for “enter, look left, stairs start there”).
    const hallwayIdx = findFirstRegionIndex(first.regions, "hallway");
    const doors = first.construction.filter(isDoorElement);

    let entryDoor: Door | null = null;

    if (hallwayIdx !== null) {
      entryDoor =
        doors.find((d) => (d.aRegion === stairs.idx && d.bRegion === hallwayIdx) || (d.bRegion === stairs.idx && d.aRegion === hallwayIdx)) ??
        null;
    }

    // Fallback: any interior door touching the stairs region (still deterministic).
    if (!entryDoor) {
      entryDoor = doors.find((d) => d.bRegion !== null && (d.aRegion === stairs.idx || d.bRegion === stairs.idx)) ?? null;
    }

    // --- Start point (bottom): inside the stairs room, biased to the LEFT of the doorway as you enter ---
    const cornerMargin = 0.10;

    let uStart = 0.0;

    if (entryDoor) {
      const mx = (entryDoor.hinge[0] + entryDoor.end[0]) * 0.5;
      const mz = (entryDoor.hinge[1] + entryDoor.end[1]) * 0.5;

      const inward = inwardFromDoorOnRect(stairsRect, entryDoor) ?? { x: 0, z: 1 };
      const left = { x: inward.z, z: -inward.x };

      // Force the start onto the wall that is physically to the LEFT as you enter,
      // so you can step through the door, look left, and the first tread is directly ahead.
      const sSide: Side =
        Math.abs(left.x) > Math.abs(left.z)
          ? left.x > 0
            ? "right"
            : "left"
          : left.z > 0
            ? "bottom"
            : "top";

      // Bias the anchor slightly inward and to the left of the doorway before projecting to the left wall.
      const leftBiased = {
        x: mx + inward.x * 0.15 + left.x * 0.70,
        z: mz + inward.z * 0.15 + left.z * 0.70,
      };

      const sPt = projectToSide(baseRect, sSide, leftBiased, cornerMargin);

      uStart = uFromPointOnSide(baseRect, sSide, sPt.x, sPt.z);
    } else {
      // Deterministic fallback: start on the left wall near the front.
      const sSide: Side = "left";
      const sPt = { x: baseRect.x0, z: baseRect.z1 - cornerMargin };
      uStart = uFromPointOnSide(baseRect, sSide, sPt.x, sPt.z);
    }

    // --- End point (top): last step must deliver you to the OPEN edge side on 2F ---
    // We end on the wall immediately BEFORE the open edge in clockwise order, at the corner that touches the open edge.
    const openSide = stairsLeadDirToOpenSide(lead);
    const endSide = prevClockwiseSide(openSide);

    // Corner touching the open edge in clockwise-preceding direction:
    // open=right  => corner top-right
    // open=bottom => corner bottom-right
    // open=left   => corner bottom-left
    // open=top    => corner top-left
    const destCorner: Corner =
      openSide === "right"
        ? "topRight"
        : openSide === "bottom"
          ? "bottomRight"
          : openSide === "left"
            ? "bottomLeft"
            : "topLeft";

    let cornerX = topRect.x0;
    let cornerZ = topRect.z0;
    if (destCorner === "topRight") {
      cornerX = topRect.x1;
      cornerZ = topRect.z0;
    } else if (destCorner === "bottomRight") {
      cornerX = topRect.x1;
      cornerZ = topRect.z1;
    } else if (destCorner === "bottomLeft") {
      cornerX = topRect.x0;
      cornerZ = topRect.z1;
    } else {
      cornerX = topRect.x0;
      cornerZ = topRect.z0;
    }

    // Place the end-anchor a little away from the corner along the endSide wall,
    // so the last tread has room and you can step across the open edge immediately.
    const endOffset = 0.25;

    let endAnchor = { x: cornerX, z: cornerZ };

    if (endSide === "top") {
      endAnchor = { x: clamp(cornerX - endOffset, topRect.x0 + cornerMargin, topRect.x1 - cornerMargin), z: topRect.z0 };
    } else if (endSide === "right") {
      endAnchor = { x: topRect.x1, z: clamp(cornerZ - endOffset, topRect.z0 + cornerMargin, topRect.z1 - cornerMargin) };
    } else if (endSide === "bottom") {
      endAnchor = { x: clamp(cornerX + endOffset, topRect.x0 + cornerMargin, topRect.x1 - cornerMargin), z: topRect.z1 };
    } else {
      endAnchor = { x: topRect.x0, z: clamp(cornerZ + endOffset, topRect.z0 + cornerMargin, topRect.z1 - cornerMargin) };
    }

    const uEnd = uFromPointOnSide(topRect, endSide, endAnchor.x, endAnchor.z);

    // Determine how far we move clockwise in parameter-space.
    // We never add loops here (loops increase stride). Instead we cap stride by increasing N above,
    // and accept tight spacing if start/end are close.
    const baseU = cwDistU(uStart, uEnd);

    // Target “meter travel” along the average perimeter.
    const Pavg = 0.5 * (perimeterLen(baseRect) + perimeterLen(topRect));
    const desiredU = (N * STEP_RUN_DESIRED) / Math.max(1e-6, Pavg);

    // If start->end is longer than desired, we must traverse it (spec requires reaching the open edge).
    // If it’s shorter, we keep it shorter (tighter steps are fine; they do NOT create overlaps due to vertical separation).
    const totalU = Math.max(baseU, desiredU);

    // Physical spacing between successive steps along the (smaller) perimeter.
    // Used to cap tread length so planks cannot heavily overlap in projection.
    const deltaU = totalU / Math.max(1, N - 1);
    const minPerim = Math.min(perimeterLen(baseRect), perimeterLen(topRect));
    const stepSpacing = minPerim * deltaU;

    // --- Step planning pass ---
    type StepPlan =
      | { kind: "corner"; rect: Rect; corner: Corner; treadDepth: number; side: Side }
      | { kind: "wall"; rect: Rect; side: Side; treadDepth: number; treadWidth: number };

    const plans: StepPlan[] = [];

    let prevSide: Side | null = null;

    for (let i = 0; i < N; i++) {
      const t = N <= 1 ? 1 : i / (N - 1);
      const u = (uStart + t * totalU) % 1;

      // Force the last few steps into the opening shaft to make it impossible to collide with 2F floor.
      const rect = i >= N - TOP_STEPS_FORCE_OPENING ? topRect : baseRect;

      const sample = pointAtU(rect, u);

      const w = rectW(rect);
      const h = rectH(rect);
      const minDim = Math.min(w, h);

      // Depth: how far the plank protrudes from the wall into the stairwell.
      // Make steps 2x wider by doubling this protrusion (area touching wall remains the same).
      const treadDepth = clamp(minDim * 0.30, 0.30, 0.42) * 2;

      // Width along the wall (the "length" of the plank).
      // Cap it by step-to-step spacing so planks cannot heavily overlap in projection.
      const sideLen = sample.side === "top" || sample.side === "bottom" ? w : h;
      const maxWidth = Math.max(0.25, sideLen - 2 * cornerMargin);

      const widthBySpacing = clamp(stepSpacing * 0.72, 0.40, 0.65);
      const treadWidth = Math.min(widthBySpacing, maxWidth);

      // ---- Corner overlap fix ----
      // Reserve a treadDepth x treadDepth "corner pocket" at both ends of each wall.
      // - Wall steps are distributed evenly along the edge span outside the corner pockets.
      // - When we turn a corner (side changes), we place a square corner step that fills that pocket.
      const edgeClear = treadDepth;

      const turningCorner = prevSide !== null ? cornerForTurn(prevSide, sample.side) : null;

      if (turningCorner) {
        plans.push({ kind: "corner", rect, corner: turningCorner, treadDepth, side: sample.side });
      } else {
        // If the wall is too short to place a non-overlapping wall step (given fixed treadWidth),
        // fall back to a corner step at the nearer end of this side.
        const canPlaceWall = sideLen >= 2 * edgeClear + treadWidth + 1e-3;

        if (!canPlaceWall) {
          const corner = nearestCornerOnSide(rect, sample.side, sample.x, sample.z);
          plans.push({ kind: "corner", rect, corner, treadDepth, side: sample.side });
        } else {
          plans.push({ kind: "wall", rect, side: sample.side, treadDepth, treadWidth });
        }
      }

      prevSide = sample.side;
    }

    // --- Even spacing pass for wall (rectangular) steps on each edge ---
    type WallGroup = { rect: Rect; side: Side; treadDepth: number; treadWidth: number; idxs: number[] };

    function wallGroupKey(rect: Rect, side: Side): string {
      const tag = rect === topRect ? "top" : "base";
      return `${tag}|${side}`;
    }

    const wallGroups = new Map<string, WallGroup>();

    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      if (p.kind !== "wall") continue;

      const key = wallGroupKey(p.rect, p.side);
      const g = wallGroups.get(key);

      if (g) {
        g.idxs.push(i);
        g.treadDepth = Math.max(g.treadDepth, p.treadDepth);
        g.treadWidth = Math.max(g.treadWidth, p.treadWidth);
      } else {
        wallGroups.set(key, { rect: p.rect, side: p.side, treadDepth: p.treadDepth, treadWidth: p.treadWidth, idxs: [i] });
      }
    }

    const wallPos = new Map<number, { cx: number; cz: number }>();

    for (const g of wallGroups.values()) {
      const rect = g.rect;
      const side = g.side;

      const w = rectW(rect);
      const h = rectH(rect);
      const sideLen = side === "top" || side === "bottom" ? w : h;

      const halfW = g.treadWidth * 0.5;

      // Keep the rectangular step fully outside the corner pocket:
      // - corner pocket length along edge is treadDepth
      // - plus half the step width so the step does not intrude into the pocket
      const insetAlong = g.treadDepth + halfW;

      const span = Math.max(0, sideLen - 2 * insetAlong);
      const n = g.idxs.length;

      for (let k = 0; k < n; k++) {
        const i = g.idxs[k]!;
        const tt = n === 1 ? 0.5 : k / (n - 1);
        const along = insetAlong + tt * span;

        // Place steps in the SAME clockwise order that pointAtU() walks:
        // top:    x0 -> x1
        // right:  z0 -> z1
        // bottom: x1 -> x0
        // left:   z1 -> z0
        if (side === "top") {
          wallPos.set(i, { cx: rect.x0 + along, cz: rect.z0 + g.treadDepth * 0.5 });
        } else if (side === "right") {
          wallPos.set(i, { cx: rect.x1 - g.treadDepth * 0.5, cz: rect.z0 + along });
        } else if (side === "bottom") {
          wallPos.set(i, { cx: rect.x1 - along, cz: rect.z1 - g.treadDepth * 0.5 });
        } else {
          wallPos.set(i, { cx: rect.x0 + g.treadDepth * 0.5, cz: rect.z1 - along });
        }
      }
    }

    // --- Render steps using the planned geometry ---
    let lastStepWasDestCorner = false;

    for (let i = 0; i < N; i++) {
      const p = plans[i]!;

      let cx = 0;
      let cz = 0;
      let dim: { width: number; height: number; depth: number };

      if (p.kind === "corner") {
        // Square corner step (no overlap with either wall's steps).
        const c = cornerCenter(p.rect, p.corner, p.treadDepth);
        cx = c.x;
        cz = c.z;
        dim = { width: p.treadDepth, height: STEP_THICK, depth: p.treadDepth };

        if (i === N - 1 && p.rect === topRect && p.corner === destCorner) {
          lastStepWasDestCorner = true;
        }
      } else {
        // Rectangular wall step: evenly spaced along this edge.
        const pos = wallPos.get(i);
        if (!pos) {
          throw new Error(`[RBS] house ${house.houseNumber}: missing wallPos for stairs step ${i}`);
        }

        cx = pos.cx;
        cz = pos.cz;

        if (p.side === "top" || p.side === "bottom") {
          dim = { width: p.treadWidth, height: STEP_THICK, depth: p.treadDepth };
        } else {
          dim = { width: p.treadDepth, height: STEP_THICK, depth: p.treadWidth };
        }
      }

      const yTop = FIRST_FLOOR_Y + (i + 1) * rise;
      const yCenter = yTop - STEP_THICK * 0.5;

      const wp = lotLocalToWorld(house, cx, cz);

      const step = MeshBuilder.CreateBox(`stairs_step_${house.houseNumber}_${i}`, dim, scene);

      step.position.x = wp.x;
      step.position.y = yCenter;
      step.position.z = wp.z;

      step.material = stairMat;
      applyWorldBoxUVs(step, SURFACE_TEX_METERS);

      // Collisions are required for traversal.
      step.checkCollisions = true;

      // Make steps behave like "floor" for floor-picking/autostep (raycasts must hit them).
      step.metadata = { rbs: { kind: "floor", layer: "stairs", houseNumber: house.houseNumber, regionName: "stairs_step" } };
    }

    // If the staircase terminates near a corner, the corner pocket can be empty at SECOND_FLOOR_Y,
    // making it impossible to pivot onto the open edge without falling into the void.
    // Add a square corner landing step at the destination corner ONLY if we never placed a dest-corner
    // pocket step on the topRect path (otherwise this extra platform is redundant/obstructive).
    const hasTopDestCornerPocket = plans.some(
      (q) => q.kind === "corner" && q.rect === topRect && q.corner === destCorner
    );

    if (!lastStepWasDestCorner && !hasTopDestCornerPocket) {
      const topMinDim = Math.min(rectW(topRect), rectH(topRect));
      const topTreadDepth = clamp(topMinDim * 0.30, 0.30, 0.42) * 2;

      const c = cornerCenter(topRect, destCorner, topTreadDepth);
      const wp = lotLocalToWorld(house, c.x, c.z);

      const yTop = SECOND_FLOOR_Y;
      const yCenter = yTop - STEP_THICK * 0.5;

      const step = MeshBuilder.CreateBox(
        `stairs_step_${house.houseNumber}_${N}`,
        { width: topTreadDepth, height: STEP_THICK, depth: topTreadDepth },
        scene
      );

      step.position.x = wp.x;
      step.position.y = yCenter;
      step.position.z = wp.z;

      step.material = stairMat;
      applyWorldBoxUVs(step, SURFACE_TEX_METERS);

      step.checkCollisions = true;
      step.metadata = { rbs: { kind: "floor", layer: "stairs", houseNumber: house.houseNumber, regionName: "stairs_step" } };
    }
  }
}
