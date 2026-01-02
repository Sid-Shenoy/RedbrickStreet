import { MeshBuilder, Scene, StandardMaterial } from "@babylonjs/core";

import type { HouseWithModel, Region, StairsLeadDir, Surface } from "../world/houseModel/types";
import type { Door } from "../world/houseModel/generation/doors";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { BOUNDARY_WALL_T, FIRST_FLOOR_Y, SECOND_FLOOR_Y, SURFACE_TEX_METERS } from "./constants";
import { applyWorldBoxUVs } from "./uvs";

type Rect = { x0: number; x1: number; z0: number; z1: number };
type Side = "top" | "right" | "bottom" | "left";

const STEP_THICK = 0.10; // 10 cm
const STEP_RUN_DESIRED = 0.28; // horizontal spacing target (meters)
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
      const left = { x: -inward.z, z: inward.x };

      // Small deterministic nudge: step “in” then “left”, so nearest-side selection is stable.
      const inside = {
        x: mx + inward.x * 0.20 + left.x * 0.20,
        z: mz + inward.z * 0.20 + left.z * 0.20,
      };

      const sSide = nearestSide(baseRect, inside);
      const sPt = projectToSide(baseRect, sSide, inside, cornerMargin);

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
    let cornerX = topRect.x0;
    let cornerZ = topRect.z0;
    if (openSide === "right") {
      cornerX = topRect.x1;
      cornerZ = topRect.z0;
    } else if (openSide === "bottom") {
      cornerX = topRect.x1;
      cornerZ = topRect.z1;
    } else if (openSide === "left") {
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

    for (let i = 0; i < N; i++) {
      const t = N <= 1 ? 1 : i / (N - 1);
      const u = (uStart + t * totalU) % 1;

      // Force the last few steps into the opening shaft to make it impossible to collide with 2F floor.
      const r = i >= N - TOP_STEPS_FORCE_OPENING ? topRect : baseRect;

      const sample = pointAtU(r, u);

      const w = rectW(r);
      const h = rectH(r);
      const minDim = Math.min(w, h);

      // Depth: how far the plank protrudes from the wall into the stairwell.
      const treadDepth = clamp(minDim * 0.35, 0.22, 0.45);

      // Width along the wall: enough for the player ellipsoid (0.35 radius) + margin.
      const sideLen = sample.side === "top" || sample.side === "bottom" ? w : h;
      const maxWidth = Math.max(0.35, sideLen - 2 * cornerMargin);
      const treadWidth = clamp(sideLen * 0.55, 0.60, Math.min(1.00, maxWidth));

      // Place the plank so its back face is exactly on the inset wall line (no overlaps with wall collision),
      // and clamp along the wall to keep away from corners.
      let cx = sample.x;
      let cz = sample.z;

      if (sample.side === "top") {
        cx = clamp(sample.x, r.x0 + cornerMargin + treadWidth * 0.5, r.x1 - cornerMargin - treadWidth * 0.5);
        cz = r.z0 + treadDepth * 0.5;
      } else if (sample.side === "right") {
        cz = clamp(sample.z, r.z0 + cornerMargin + treadWidth * 0.5, r.z1 - cornerMargin - treadWidth * 0.5);
        cx = r.x1 - treadDepth * 0.5;
      } else if (sample.side === "bottom") {
        cx = clamp(sample.x, r.x0 + cornerMargin + treadWidth * 0.5, r.x1 - cornerMargin - treadWidth * 0.5);
        cz = r.z1 - treadDepth * 0.5;
      } else {
        cz = clamp(sample.z, r.z0 + cornerMargin + treadWidth * 0.5, r.z1 - cornerMargin - treadWidth * 0.5);
        cx = r.x0 + treadDepth * 0.5;
      }

      const yTop = FIRST_FLOOR_Y + (i + 1) * rise;
      const yCenter = yTop - STEP_THICK * 0.5;

      const wp = lotLocalToWorld(house, cx, cz);

      // Box dimensions: Babylon's CreateBox uses { width(x), height(y), depth(z) }.
      // For top/bottom walls, the tread width is along X and depth is along Z.
      // For left/right walls, the tread depth is along X and width is along Z.
      const dim =
        sample.side === "top" || sample.side === "bottom"
          ? { width: treadWidth, height: STEP_THICK, depth: treadDepth }
          : { width: treadDepth, height: STEP_THICK, depth: treadWidth };

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
  }
}
