import { Scene, MeshBuilder, StandardMaterial, Mesh, VertexData } from "@babylonjs/core";

import type { HouseWithModel, Region } from "../world/houseModel/types";
import type { Door } from "../world/houseModel/generation/doors";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { BOUNDARY_WALL_T, DOOR_OPENING_H, SURFACE_TEX_METERS } from "./constants";
import { applyWorldBoxUVs } from "./uvs";

// -------- Boundary wall extraction/rendering (shared edges + exterior edges) --------

type Seg = { x0: number; z0: number; x1: number; z1: number };
const WALL_EPS = 1e-6;

function round6(v: number) {
  return Math.round(v * 1e6) / 1e6;
}

function uniqSorted(vals: number[]): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of s) {
    if (out.length === 0) out.push(v);
    else if (Math.abs(v - out[out.length - 1]!) > WALL_EPS) out.push(v);
  }
  return out;
}

function regionBoundarySegments(r: Region): Seg[] {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const z0 = Math.min(az, bz);
    const z1 = Math.max(az, bz);
    return [
      { x0, z0, x1, z1: z0 }, // bottom
      { x0: x1, z0, x1, z1 }, // right
      { x0: x1, z0: z1, x1: x0, z1 }, // top
      { x0, z0: z1, x1: x0, z1: z0 }, // left
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

function splitIntoAtomicSegments(segs: Seg[], xCuts: number[], zCuts: number[]): Seg[] {
  const out: Seg[] = [];

  for (const s of segs) {
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;

    // Horizontal
    if (Math.abs(dz) <= WALL_EPS && Math.abs(dx) > WALL_EPS) {
      const z = s.z0;
      const xa = Math.min(s.x0, s.x1);
      const xb = Math.max(s.x0, s.x1);

      const xs = [xa, xb];
      for (const x of xCuts) {
        if (x > xa + WALL_EPS && x < xb - WALL_EPS) xs.push(x);
      }
      const ux = uniqSorted(xs);

      for (let i = 0; i < ux.length - 1; i++) {
        const x0 = ux[i]!;
        const x1 = ux[i + 1]!;
        if (x1 - x0 > WALL_EPS) out.push({ x0, z0: z, x1, z1: z });
      }
      continue;
    }

    // Vertical
    if (Math.abs(dx) <= WALL_EPS && Math.abs(dz) > WALL_EPS) {
      const x = s.x0;
      const za = Math.min(s.z0, s.z1);
      const zb = Math.max(s.z0, s.z1);

      const zs = [za, zb];
      for (const z of zCuts) {
        if (z > za + WALL_EPS && z < zb - WALL_EPS) zs.push(z);
      }
      const uz = uniqSorted(zs);

      for (let i = 0; i < uz.length - 1; i++) {
        const z0 = uz[i]!;
        const z1 = uz[i + 1]!;
        if (z1 - z0 > WALL_EPS) out.push({ x0: x, z0, x1: x, z1 });
      }
      continue;
    }

    // Degenerate / non-axis-aligned (shouldn't happen by requirements); ignore.
  }

  return out;
}

function segKeyAtomic(s: Seg): string {
  // Canonicalize orientation and endpoint order.
  const dx = s.x1 - s.x0;
  const dz = s.z1 - s.z0;

  if (Math.abs(dz) <= WALL_EPS && Math.abs(dx) > WALL_EPS) {
    const z = round6(s.z0);
    const a = round6(Math.min(s.x0, s.x1));
    const b = round6(Math.max(s.x0, s.x1));
    return `h|${z}|${a}|${b}`;
  }

  if (Math.abs(dx) <= WALL_EPS && Math.abs(dz) > WALL_EPS) {
    const x = round6(s.x0);
    const a = round6(Math.min(s.z0, s.z1));
    const b = round6(Math.max(s.z0, s.z1));
    return `v|${x}|${a}|${b}`;
  }

  // Non-axis-aligned shouldn't happen; still return something stable.
  return `na|${round6(s.x0)}|${round6(s.z0)}|${round6(s.x1)}|${round6(s.z1)}`;
}

// --- Door gap carving (doors are rendered as gaps in boundary walls) ---

type DoorCut = { orient: "h" | "v"; c: number; a: number; b: number };
type Interval = { a: number; b: number };

const DOOR_CUT_TOL = 2e-3;
const MIN_WALL_SEG = 1e-4;

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

function doorCutsFromConstruction(construction: unknown[]): DoorCut[] {
  const cuts: DoorCut[] = [];

  for (const el of construction) {
    if (!isDoorElement(el)) continue;

    const x0 = el.hinge[0];
    const z0 = el.hinge[1];
    const x1 = el.end[0];
    const z1 = el.end[1];

    // Axis-aligned by invariant.
    if (Math.abs(z0 - z1) <= 1e-6 && Math.abs(x0 - x1) > 1e-6) {
      const a = Math.min(x0, x1);
      const b = Math.max(x0, x1);
      cuts.push({ orient: "h", c: z0, a, b });
    } else if (Math.abs(x0 - x1) <= 1e-6 && Math.abs(z0 - z1) > 1e-6) {
      const a = Math.min(z0, z1);
      const b = Math.max(z0, z1);
      cuts.push({ orient: "v", c: x0, a, b });
    }
  }

  return cuts;
}

function subtractOne(intervals: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const it of intervals) {
    // No overlap
    if (cut.b <= it.a + WALL_EPS || cut.a >= it.b - WALL_EPS) {
      out.push(it);
      continue;
    }

    // Left remainder
    const la = it.a;
    const lb = Math.max(it.a, cut.a);
    if (lb - la > WALL_EPS) out.push({ a: la, b: lb });

    // Right remainder
    const ra = Math.min(it.b, cut.b);
    const rb = it.b;
    if (rb - ra > WALL_EPS) out.push({ a: ra, b: rb });
  }
  return out;
}

function carveDoorsFromAtomicSeg(seg: Seg, cuts: DoorCut[]): Seg[] {
  const dx = seg.x1 - seg.x0;
  const dz = seg.z1 - seg.z0;

  // Horizontal in lot-local: z constant, interval in x.
  if (Math.abs(dz) <= WALL_EPS && Math.abs(dx) > WALL_EPS) {
    const z = seg.z0;
    const a0 = Math.min(seg.x0, seg.x1);
    const b0 = Math.max(seg.x0, seg.x1);

    let intervals: Interval[] = [{ a: a0, b: b0 }];

    const relevant = cuts.filter((c) => c.orient === "h" && Math.abs(c.c - z) <= DOOR_CUT_TOL);
    for (const c of relevant) {
      intervals = subtractOne(intervals, { a: c.a, b: c.b });
      if (intervals.length === 0) break;
    }

    return intervals
      .filter((it) => it.b - it.a > MIN_WALL_SEG)
      .map((it) => ({ x0: it.a, z0: z, x1: it.b, z1: z }));
  }

  // Vertical in lot-local: x constant, interval in z.
  if (Math.abs(dx) <= WALL_EPS && Math.abs(dz) > WALL_EPS) {
    const x = seg.x0;
    const a0 = Math.min(seg.z0, seg.z1);
    const b0 = Math.max(seg.z0, seg.z1);

    let intervals: Interval[] = [{ a: a0, b: b0 }];

    const relevant = cuts.filter((c) => c.orient === "v" && Math.abs(c.c - x) <= DOOR_CUT_TOL);
    for (const c of relevant) {
      intervals = subtractOne(intervals, { a: c.a, b: c.b });
      if (intervals.length === 0) break;
    }

    return intervals
      .filter((it) => it.b - it.a > MIN_WALL_SEG)
      .map((it) => ({ x0: x, z0: it.a, x1: x, z1: it.b }));
  }

  // Non-axis-aligned shouldn't happen.
  return [seg];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function createOpenBox(name: string, scene: Scene, width: number, height: number, depth: number): Mesh {
  const mesh = new Mesh(name, scene);

  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  // 4 vertical faces only: +Z, -Z, +X, -X. No top/bottom caps (prevents z-fighting with floors/ceilings).
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  function addQuad(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
    nx: number,
    ny: number,
    nz: number
  ) {
    const base = positions.length / 3;

    positions.push(
      ax, ay, az,
      bx, by, bz,
      cx, cy, cz,
      dx, dy, dz
    );

    // Flat normal per face
    for (let i = 0; i < 4; i++) normals.push(nx, ny, nz);

    // Simple UVs (walls are solid color now, but keep valid UVs)
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

    indices.push(
      base + 0, base + 1, base + 2,
      base + 0, base + 2, base + 3
    );
  }

  // +Z face
  addQuad(-hx, -hy, +hz, +hx, -hy, +hz, +hx, +hy, +hz, -hx, +hy, +hz, 0, 0, 1);
  // -Z face
  addQuad(+hx, -hy, -hz, -hx, -hy, -hz, -hx, +hy, -hz, +hx, +hy, -hz, 0, 0, -1);
  // +X face
  addQuad(+hx, -hy, +hz, +hx, -hy, -hz, +hx, +hy, -hz, +hx, +hy, +hz, 1, 0, 0);
  // -X face
  addQuad(-hx, -hy, -hz, -hx, -hy, +hz, -hx, +hy, +hz, -hx, +hy, -hz, -1, 0, 0);

  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.applyToMesh(mesh);

  return mesh;
}

export function renderBoundaryWallsForLayer(
  scene: Scene,
  houses: HouseWithModel[],
  getRegions: (h: HouseWithModel) => Region[],
  getConstruction: (h: HouseWithModel) => unknown[],
  bottomY: number,
  topY: number,
  doorBottomY: number,
  meshPrefix: string,
  wallMat: StandardMaterial
) {
  if (!(topY > bottomY + 1e-6)) {
    throw new Error(`renderBoundaryWallsForLayer: invalid Y range bottomY=${bottomY}, topY=${topY}`);
  }

  for (const house of houses) {
    const allRegions = getRegions(house);
    const doorCuts = doorCutsFromConstruction(getConstruction(house));

    // Build cut sets from ALL region vertices (including void) so we can split long edges into shared atomic segments.
    const xVals: number[] = [0, house.bounds.xsize];
    const zVals: number[] = [0, 30];

    for (const r of allRegions) {
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

    const xCuts = uniqSorted(xVals);
    const zCuts = uniqSorted(zVals);

    // Count atomic segments across all regions, tracking void vs non-void ownership.
    const segStats = new Map<string, { nonVoid: number; void: number; seg: Seg }>();

    for (const r of allRegions) {
      const boundary = regionBoundarySegments(r);
      const atomic = splitIntoAtomicSegments(boundary, xCuts, zCuts);

      const isVoid = r.surface === "void";

      for (const s of atomic) {
        const key = segKeyAtomic(s);
        const prev = segStats.get(key);
        if (prev) {
          if (isVoid) prev.void += 1;
          else prev.nonVoid += 1;
        } else {
          segStats.set(key, { nonVoid: isVoid ? 0 : 1, void: isVoid ? 1 : 0, seg: s });
        }
      }
    }

    // Interior wall segments: shared by exactly two non-void regions (room separators).
    const interior = [...segStats.values()].filter((v) => v.nonVoid === 2);

    // Exterior edge segments: owned by exactly one non-void region AND not adjacent to a void opening.
    // This draws walls along the outer boundary of the generated floor footprint (house edges).
    const exterior = [...segStats.values()].filter((v) => v.nonVoid === 1 && v.void === 0);

    const allToRender = [...interior, ...exterior];

    // Vertical slicing:
    // - Solid base from bottomY -> doorBottomY (no carving)
    // - Door opening band from doorBottomY -> doorBottomY + DOOR_OPENING_H (carved)
    // - Solid upper from end of door band -> topY (no carving)
    const yDoor0 = clamp(doorBottomY, bottomY, topY);
    const yDoor1 = clamp(yDoor0 + DOOR_OPENING_H, bottomY, topY);

    function renderPieces(seg: Seg, y0: number, y1: number, carveDoors: boolean, idxRef: { v: number }) {
      const h = y1 - y0;
      if (!(h > 1e-6)) return;

      const pieces = carveDoors ? carveDoorsFromAtomicSeg(seg, doorCuts) : [seg];

      for (const piece of pieces) {
        const p0 = lotLocalToWorld(house, piece.x0, piece.z0);
        const p1 = lotLocalToWorld(house, piece.x1, piece.z1);

        const dx = p1.x - p0.x;
        const dz = p1.z - p0.z;

        const isHoriz = Math.abs(dz) <= 1e-6 && Math.abs(dx) > 1e-6;
        const isVert = Math.abs(dx) <= 1e-6 && Math.abs(dz) > 1e-6;
        if (!isHoriz && !isVert) continue;

        if (isHoriz) {
          const x0 = Math.min(p0.x, p1.x);
          const x1 = Math.max(p0.x, p1.x);
          const len = x1 - x0;
          if (len <= MIN_WALL_SEG) continue;

          const wall = createOpenBox(
            `${meshPrefix}_wall_${house.houseNumber}_${idxRef.v++}`,
            scene,
            len,
            h,
            BOUNDARY_WALL_T
          );

          wall.position.x = (x0 + x1) * 0.5;
          wall.position.z = p0.z; // same as p1.z
          wall.position.y = y0 + h / 2;

          applyWorldBoxUVs(wall, SURFACE_TEX_METERS);

          wall.material = wallMat;
          wall.checkCollisions = false; // visual only
          wall.isPickable = false;
        } else {
          const z0 = Math.min(p0.z, p1.z);
          const z1 = Math.max(p0.z, p1.z);
          const len = z1 - z0;
          if (len <= MIN_WALL_SEG) continue;

          const wall = createOpenBox(
          `${meshPrefix}_wall_${house.houseNumber}_${idxRef.v++}`,
            scene,
            BOUNDARY_WALL_T,
            h,
            len
          );

          wall.position.x = p0.x; // same as p1.x
          wall.position.z = (z0 + z1) * 0.5;
          wall.position.y = y0 + h / 2;

          applyWorldBoxUVs(wall, SURFACE_TEX_METERS);

          wall.material = wallMat;
          wall.checkCollisions = false; // visual only
          wall.isPickable = false;

        }
      }
    }

    const idxRef = { v: 0 };

    for (const { seg } of allToRender) {
      // Solid base (plot/foundation to door bottom)
      if (yDoor0 > bottomY + 1e-6) {
        renderPieces(seg, bottomY, yDoor0, false, idxRef);
      }

      // Door band (carved openings)
      if (yDoor1 > yDoor0 + 1e-6) {
        renderPieces(seg, yDoor0, yDoor1, true, idxRef);
      }

      // Solid upper (above door to top)
      if (topY > yDoor1 + 1e-6) {
        renderPieces(seg, yDoor1, topY, false, idxRef);
      }
    }

    // Add a simple lintel underside at the top of each door opening, so openings look believable.
    // (We removed wall top/bottom caps to eliminate z-fighting.)
    const lintelIdx = { v: 0 };

    for (const cut of doorCuts) {
      const span = cut.b - cut.a;
      // Door width is invariant 0.8m, but keep a small tolerance.
      if (span < 0.79 || span > 0.81) continue;

      if (cut.orient === "h") {
        const midX = (cut.a + cut.b) * 0.5;
        const p = lotLocalToWorld(house, midX, cut.c);

        const lintel = MeshBuilder.CreatePlane(
          `${meshPrefix}_lintel_${house.houseNumber}_${lintelIdx.v++}`,
          { width: span, height: BOUNDARY_WALL_T, sideOrientation: Mesh.DOUBLESIDE },
          scene
        );

        // Convert XY plane to XZ plane (horizontal)
        lintel.rotation.x = Math.PI / 2;

        lintel.position.x = p.x;
        lintel.position.y = yDoor1;
        lintel.position.z = p.z;

        lintel.material = wallMat;
        lintel.checkCollisions = false;
        lintel.isPickable = false;
      } else {
        const midZ = (cut.a + cut.b) * 0.5;
        const p = lotLocalToWorld(house, cut.c, midZ);

        const lintel = MeshBuilder.CreatePlane(
          `${meshPrefix}_lintel_${house.houseNumber}_${lintelIdx.v++}`,
          { width: span, height: BOUNDARY_WALL_T, sideOrientation: Mesh.DOUBLESIDE },
          scene
        );

        lintel.rotation.x = Math.PI / 2;
        lintel.rotation.y = Math.PI / 2;

        lintel.position.x = p.x;
        lintel.position.y = yDoor1;
        lintel.position.z = p.z;

        lintel.material = wallMat;
        lintel.checkCollisions = false;
        lintel.isPickable = false;
      }
    }
  }
}
