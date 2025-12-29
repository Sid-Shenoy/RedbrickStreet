import {
  Engine,
  Scene,
  UniversalCamera,
  HemisphericLight,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Texture,
  VertexBuffer,
  Color3,
  Mesh,
  VertexData,
  Ray,
  AbstractMesh,
} from "@babylonjs/core";

import earcut from "earcut";

import { loadStreetConfig } from "./config/loadStreetConfig";
import { attachHouseModel } from "./world/houseModel/attachHouseModel";
import type { HouseWithModel, Region } from "./world/houseModel/types";
import type { Door } from "./world/houseModel/generation/doors";
import { lotLocalToWorld } from "./world/houseModel/lotTransform";

const STREET_SEED = "redbrick-street/v0";

// Surface texture scale: each texture image represents 0.5m x 0.5m.
const SURFACE_TEX_METERS = 0.5;

// Vertical layout (meters)
const PLOT_Y = 0.2;
const FIRST_FLOOR_Y = 0.4;
const SECOND_FLOOR_Y = 3.4;
const CEILING_Y = 6.4;

// Boundary wall rendering (between regions + along exterior edges)
const BOUNDARY_WALL_H = 0.2;
const BOUNDARY_WALL_T = 0.06;

// Auto-step (meters)
const MAX_STEP_UP = 0.5;
const STEP_PROBE_DIST = 0.55;
const STEP_NUDGE_FWD = 0.05;

type RegionMeshKind = "floor" | "ceiling";

function makeMat(scene: Scene, name: string, color: Color3, doubleSided = false): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.backFaceCulling = !doubleSided; // doubleSided => render both sides
  return m;
}

function makeTexMat(scene: Scene, name: string, url: string, doubleSided = false): StandardMaterial {
  const m = new StandardMaterial(name, scene);

  const tex = new Texture(url, scene);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;

  m.diffuseTexture = tex;
  m.diffuseColor = new Color3(1, 1, 1); // do not tint textures
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.backFaceCulling = !doubleSided;

  return m;
}

function surfaceMaterial(scene: Scene, opts?: { doubleSided?: boolean }) {
  const doubleSided = opts?.doubleSided ?? false;
  const suf = doubleSided ? "_2s" : "";

  return {
    black: makeTexMat(scene, `mat_black${suf}`, "/assets/textures/surfaces/black.jpg", doubleSided),
    brick: makeTexMat(scene, `mat_brick${suf}`, "/assets/textures/surfaces/brick.jpg", doubleSided),
    grass: makeTexMat(scene, `mat_grass${suf}`, "/assets/textures/surfaces/grass.jpg", doubleSided),
    concrete_light: makeTexMat(scene, `mat_conc_light${suf}`, "/assets/textures/surfaces/concrete_light.jpg", doubleSided),
    concrete_medium: makeTexMat(scene, `mat_conc_med${suf}`, "/assets/textures/surfaces/concrete_medium.jpg", doubleSided),
    concrete_dark: makeTexMat(scene, `mat_conc_dark${suf}`, "/assets/textures/surfaces/concrete_dark.jpg", doubleSided),
    wood_light: makeTexMat(scene, `mat_wood_light${suf}`, "/assets/textures/surfaces/wood_light.jpg", doubleSided),
    wood_medium: makeTexMat(scene, `mat_wood_medium${suf}`, "/assets/textures/surfaces/wood_medium.jpg", doubleSided),
    wood_dark: makeTexMat(scene, `mat_wood_dark${suf}`, "/assets/textures/surfaces/wood_dark.jpg", doubleSided),
    tile_light: makeTexMat(scene, `mat_tile_light${suf}`, "/assets/textures/surfaces/tile_light.jpg", doubleSided),
    tile_medium: makeTexMat(scene, `mat_tile_medium${suf}`, "/assets/textures/surfaces/tile_medium.jpg", doubleSided),
    tile_dark: makeTexMat(scene, `mat_tile_dark${suf}`, "/assets/textures/surfaces/tile_dark.jpg", doubleSided),

    // Not part of the Region surface enum, but still render with a real texture.
    road: makeTexMat(scene, `mat_road${suf}`, "/assets/textures/surfaces/concrete_dark.jpg", doubleSided),

    // No wall texture exists yet; keep as solid color for now.
    wall: makeMat(scene, `mat_wall${suf}`, new Color3(0.45, 0.20, 0.18), doubleSided),
  } as const;
}

function tagRegionMesh(mesh: AbstractMesh, kind: RegionMeshKind, layerTag: string, houseNumber: number, regionName: string) {
  mesh.metadata = {
    rbs: {
      kind,
      layer: layerTag,
      houseNumber,
      regionName,
    },
  };
}

function isFloorMesh(m: AbstractMesh): boolean {
  if (m.name === "road") return true;
  const md = m.metadata as { rbs?: { kind?: string } } | undefined;
  return md?.rbs?.kind === "floor";
}

function pickFloorY(scene: Scene, x: number, z: number, originY: number, maxDist: number): number | null {
  const ray = new Ray(new Vector3(x, originY, z), new Vector3(0, -1, 0), maxDist);
  const hit = scene.pickWithRay(ray, isFloorMesh);
  if (!hit?.hit || !hit.pickedPoint) return null;
  return hit.pickedPoint.y;
}

/**
 * Make surface textures repeat in real-world meters.
 * Uses world-space XZ to generate UVs, so all regions share consistent texture scale and alignment.
 */
function applyWorldUVs(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wz = pos[i + 2]! + mesh.position.z;
    uvs[j] = wx / metersPerTile;
    uvs[j + 1] = wz / metersPerTile;
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/**
 * World-space UVs for vertical meshes: uses world X/Y so textures tile in meters.
 */
function applyWorldUVsXY(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wy = pos[i + 1]! + mesh.position.y;
    uvs[j] = wx / metersPerTile;
    uvs[j + 1] = wy / metersPerTile;
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/**
 * World-space UVs for axis-aligned boxes (no rotation):
 * - Vertical faces tile in meters using (X,Y) or (Z,Y) depending on face normal.
 * - Top/bottom faces tile using (X,Z).
 */
function applyWorldBoxUVs(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nrm) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wy = pos[i + 1]! + mesh.position.y;
    const wz = pos[i + 2]! + mesh.position.z;

    const nx = nrm[i]!;
    const ny = nrm[i + 1]!;
    const nz = nrm[i + 2]!;

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    // Decide which face we're on by dominant normal axis.
    if (ax >= ay && ax >= az) {
      // ±X face => YZ plane: tile along Z and Y
      uvs[j] = wz / metersPerTile;
      uvs[j + 1] = wy / metersPerTile;
    } else if (az >= ax && az >= ay) {
      // ±Z face => XY plane: tile along X and Y
      uvs[j] = wx / metersPerTile;
      uvs[j + 1] = wy / metersPerTile;
    } else {
      // ±Y face (top/bottom) => XZ plane: tile along X and Z
      uvs[j] = wx / metersPerTile;
      uvs[j + 1] = wz / metersPerTile;
    }
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

// Rect region renderer (CreateGround)
function renderRectRegion(
  scene: Scene,
  house: HouseWithModel,
  region: Extract<Region, { type: "rectangle" }>,
  mat: StandardMaterial,
  kind: RegionMeshKind,
  layerTag: string,
  baseY: number,
  collisions: boolean
): Mesh {
  const [[x0, z0], [x1, z1]] = region.points;

  // Convert both corners to world, then normalize to min/max (handles odd-house mirroring)
  const pA = lotLocalToWorld(house, x0, z0);
  const pB = lotLocalToWorld(house, x1, z1);

  const minX = Math.min(pA.x, pB.x);
  const maxX = Math.max(pA.x, pB.x);
  const minZ = Math.min(pA.z, pB.z);
  const maxZ = Math.max(pA.z, pB.z);

  const width = Math.max(0.001, maxX - minX);
  const height = Math.max(0.001, maxZ - minZ);

  const mesh = MeshBuilder.CreateGround(
    `region_${layerTag}_${house.houseNumber}_${region.name}`,
    { width, height, subdivisions: 1 },
    scene
  );

  mesh.position.x = minX + width / 2;
  mesh.position.z = minZ + height / 2;
  mesh.position.y = baseY;

  // World-scaled UVs (0.5m tiles)
  applyWorldUVs(mesh, SURFACE_TEX_METERS);

  mesh.material = mat;
  mesh.checkCollisions = collisions;
  tagRegionMesh(mesh, kind, layerTag, house.houseNumber, region.name);

  return mesh;
}

// Polygon region renderer (triangulated via earcut)
function renderPolyRegion(
  scene: Scene,
  house: HouseWithModel,
  region: Extract<Region, { type: "polygon" }>,
  mat: StandardMaterial,
  kind: RegionMeshKind,
  layerTag: string,
  baseY: number,
  collisions: boolean
): Mesh {
  // If polygon is explicitly closed (last point == first), drop the last point for triangulation.
  const pts = region.points;
  const basePts =
    pts.length >= 4 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
      ? pts.slice(0, -1)
      : pts;

  const mesh = new Mesh(`region_${layerTag}_${house.houseNumber}_${region.name}`, scene);
  mesh.material = mat;
  mesh.checkCollisions = collisions;
  tagRegionMesh(mesh, kind, layerTag, house.houseNumber, region.name);

  if (basePts.length < 3) return mesh;

  // Convert to world-space XZ points
  const world = basePts.map(([lx, lz]) => lotLocalToWorld(house, lx, lz));

  // earcut expects a flat [x0, y0, x1, y1, ...] array (we use x,z)
  const coords2d: number[] = [];
  const positions: number[] = [];
  const uvs: number[] = [];

  for (const p of world) {
    coords2d.push(p.x, p.z);
    positions.push(p.x, baseY, p.z);

    // World-scaled UVs (0.5m tiles)
    uvs.push(p.x / SURFACE_TEX_METERS, p.z / SURFACE_TEX_METERS);
  }

  const indices = earcut(coords2d, undefined, 2);

  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.uvs = uvs;

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;

  vd.applyToMesh(mesh);

  return mesh;
}

function renderFloorLayer(
  scene: Scene,
  houses: HouseWithModel[],
  mats: Record<string, StandardMaterial>,
  layerTag: string,
  getRegions: (h: HouseWithModel) => Region[],
  baseY: number,
  collisions: boolean
) {
  for (const house of houses) {
    const regions = getRegions(house);

    for (const region of regions) {
      if (region.surface === "void") continue;

      const mat = mats[region.surface];

      if (region.type === "rectangle") {
        renderRectRegion(scene, house, region, mat, "floor", layerTag, baseY, collisions);
      } else {
        renderPolyRegion(scene, house, region, mat, "floor", layerTag, baseY, collisions);
      }
    }
  }
}

function renderCeilings(scene: Scene, houses: HouseWithModel[], ceilingMat: StandardMaterial) {
  for (const house of houses) {
    const hr = house.model.plot.regions.find((r) => r.name === "houseregion");
    if (!hr) continue;

    // Ceiling must be congruent with houseregion; render the same footprint at CEILING_Y.
    if (hr.type === "polygon") {
      renderPolyRegion(scene, house, hr, ceilingMat, "ceiling", "ceiling", CEILING_Y, false);
    } else {
      renderRectRegion(scene, house, hr, ceilingMat, "ceiling", "ceiling", CEILING_Y, false);
    }
  }
}

function renderCurbFaces(scene: Scene, houses: HouseWithModel[], mats: ReturnType<typeof surfaceMaterial>) {
  // Plot is raised to PLOT_Y, but the road remains at y=0.0.
  // Add a thin vertical face along the lot front edge so the curb doesn't look like it's floating.
  const faceH = PLOT_Y;
  if (faceH <= 0) return;

  for (const house of houses) {
    const xsize = house.bounds.xsize;

    // Front edge in lot-local coordinates is always localZ=30.
    const p0 = lotLocalToWorld(house, 0, 30);
    const p1 = lotLocalToWorld(house, xsize, 30);

    const minX = Math.min(p0.x, p1.x);
    const maxX = Math.max(p0.x, p1.x);
    const width = Math.max(0.001, maxX - minX);

    const frontZ = p0.z; // same as p1.z

    // A single vertical face at the lot front edge (no thickness, avoids top-face UV mismatch).
    const face = MeshBuilder.CreatePlane(
      `curb_face_${house.houseNumber}`,
      { width, height: faceH, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );

    face.position.x = minX + width / 2;
    face.position.y = faceH / 2;
    face.position.z = frontZ;

    // World-scaled UVs (0.5m tiles) using X/Y for vertical surfaces.
    applyWorldUVsXY(face, SURFACE_TEX_METERS);

    face.material = mats.concrete_light;
    face.checkCollisions = false; // visual only
  }
}

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

function renderBoundaryWallsForLayer(
  scene: Scene,
  houses: HouseWithModel[],
  getRegions: (h: HouseWithModel) => Region[],
  getConstruction: (h: HouseWithModel) => unknown[],
  baseY: number,
  meshPrefix: string,
  wallMat: StandardMaterial
) {
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
    // This draws short walls along the outer boundary of the generated floor footprint (house edges).
    const exterior = [...segStats.values()].filter((v) => v.nonVoid === 1 && v.void === 0);

    const allToRender = [...interior, ...exterior];

    let idx = 0;
    for (const { seg } of allToRender) {
      // Carve door gaps out of this atomic segment in lot-local space.
      const pieces = carveDoorsFromAtomicSeg(seg, doorCuts);

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

          const box = MeshBuilder.CreateBox(
            `${meshPrefix}_wall_${house.houseNumber}_${idx++}`,
            {
              width: len,
              height: BOUNDARY_WALL_H,
              depth: BOUNDARY_WALL_T,
            },
            scene
          );

          box.position.x = (x0 + x1) * 0.5;
          box.position.z = p0.z; // same as p1.z
          box.position.y = baseY + BOUNDARY_WALL_H / 2;

          box.material = wallMat;
          box.checkCollisions = false; // visual only
        } else {
          const z0 = Math.min(p0.z, p1.z);
          const z1 = Math.max(p0.z, p1.z);
          const len = z1 - z0;
          if (len <= MIN_WALL_SEG) continue;

          const box = MeshBuilder.CreateBox(
            `${meshPrefix}_wall_${house.houseNumber}_${idx++}`,
            {
              width: BOUNDARY_WALL_T,
              height: BOUNDARY_WALL_H,
              depth: len,
            },
            scene
          );

          box.position.x = p0.x; // same as p1.x
          box.position.z = (z0 + z1) * 0.5;
          box.position.y = baseY + BOUNDARY_WALL_H / 2;

          box.material = wallMat;
          box.checkCollisions = false; // visual only
        }
      }
    }
  }
}

function setupAutoStep(scene: Scene, camera: UniversalCamera) {
  scene.onBeforeRenderObservable.add(() => {
    // Only attempt stepping when the player is actively trying to move.
    const move = camera.cameraDirection;
    if (move.lengthSquared() < 1e-8) return;

    const dir = new Vector3(move.x, 0, move.z);
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-6) return;
    dir.x /= len;
    dir.z /= len;

    // Current floor height under player.
    const curY = pickFloorY(scene, camera.position.x, camera.position.z, camera.position.y + 2.0, 30);
    if (curY == null) return;

    // Probe ahead. Start the ray below any "upper storey" ceilings (but above possible step height),
    // so we don't accidentally hit the second floor when we're trying to step onto the first floor.
    const probeX = camera.position.x + dir.x * STEP_PROBE_DIST;
    const probeZ = camera.position.z + dir.z * STEP_PROBE_DIST;
    const probeOriginY = curY + MAX_STEP_UP + 1.0;

    const aheadY = pickFloorY(scene, probeX, probeZ, probeOriginY, 30);
    if (aheadY == null) return;

    const dy = aheadY - curY;
    if (dy > 0.01 && dy <= MAX_STEP_UP + 1e-3) {
      // Lift the camera to match the higher platform and give a tiny forward nudge so collisions
      // don't keep us pinned on the edge.
      camera.position.y += dy;
      camera.position.x += dir.x * STEP_NUDGE_FWD;
      camera.position.z += dir.z * STEP_NUDGE_FWD;
    }
  });
}

function renderStreet(scene: Scene, houses: HouseWithModel[]) {
  const mats = surfaceMaterial(scene); // normal (single-sided)
  const matsDouble = surfaceMaterial(scene, { doubleSided: true }); // for viewing from below

  // Road: x 0..200, z 30..40 => width=200, height=10
  const road = MeshBuilder.CreateGround("road", { width: 200, height: 10 }, scene);
  road.position.x = 100;
  road.position.z = 35;
  road.material = mats.road;
  applyWorldUVs(road, SURFACE_TEX_METERS);
  road.checkCollisions = true;
  road.metadata = { rbs: { kind: "floor", layer: "road" } };

  // Add a vertical curb face so the raised plot meets the road visually.
  renderCurbFaces(scene, houses, mats);

  // Boundary wall around 200 x 70
  const wallH = 5;
  const wallT = 0.5;

  const wallNorth = MeshBuilder.CreateBox("wall_n", { width: 200, height: wallH, depth: wallT }, scene);
  wallNorth.position.set(100, wallH / 2, wallT / 2);

  const wallSouth = MeshBuilder.CreateBox("wall_s", { width: 200, height: wallH, depth: wallT }, scene);
  wallSouth.position.set(100, wallH / 2, 70 - wallT / 2);

  const wallWest = MeshBuilder.CreateBox("wall_w", { width: wallT, height: wallH, depth: 70 }, scene);
  wallWest.position.set(wallT / 2, wallH / 2, 35);

  const wallEast = MeshBuilder.CreateBox("wall_e", { width: wallT, height: wallH, depth: 70 }, scene);
  wallEast.position.set(200 - wallT / 2, wallH / 2, 35);

  for (const w of [wallNorth, wallSouth, wallWest, wallEast]) {
    w.material = mats.brick;
    applyWorldBoxUVs(w, SURFACE_TEX_METERS);
    w.checkCollisions = true;
  }

  // Plot + floors as stacked 2D layers
  renderFloorLayer(scene, houses, mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
  renderFloorLayer(scene, houses, mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

  // Boundary walls between rooms AND along exterior edges (white, 0.2m tall) for first & second floor.
  // Doors are rendered as 0.8m gaps in these boundary walls (no door mesh yet).
  const boundaryWallMat = makeMat(scene, "mat_boundary_wall", new Color3(1, 1, 1), false);

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.firstFloor.regions,
    (h) => h.model.firstFloor.construction,
    FIRST_FLOOR_Y,
    "ff",
    boundaryWallMat
  );

  // Second floor: double-sided so underside is visible while walking below.
  renderFloorLayer(scene, houses, matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, false);

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.secondFloor.regions,
    (h) => h.model.secondFloor.construction,
    SECOND_FLOOR_Y,
    "sf",
    boundaryWallMat
  );

  // Ceiling (congruent with houseregion) at 6.2m, double-sided so underside is visible.
  renderCeilings(scene, houses, matsDouble.concrete_light);
}

async function boot() {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("Missing <canvas id='renderCanvas'> in index.html");

  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.35, 0);

  new HemisphericLight("light", new Vector3(0, 1, 0), scene);

  // WASD + mouse look
  const camera = new UniversalCamera("cam", new Vector3(100, 1.7, 35), scene);
  camera.attachControl(canvas, true);
  camera.speed = 0.1;
  camera.angularSensibility = 4000;

  camera.applyGravity = true;
  camera.checkCollisions = true;
  camera.ellipsoid = new Vector3(0.35, 0.9, 0.35);

  camera.keysUp = [87]; // W
  camera.keysDown = [83]; // S
  camera.keysLeft = [65]; // A
  camera.keysRight = [68]; // D

  // Click-to-pointer-lock (better mouse look)
  scene.onPointerDown = () => {
    canvas.requestPointerLock?.();
  };

  setupAutoStep(scene, camera);

  // Load config + attach seeded models
  const { houses } = await loadStreetConfig();
  const housesWithModel = houses.map((h) => attachHouseModel(h, STREET_SEED));

  // Log all transformed houses (HouseConfig + generated model) as soon as config is loaded.
  console.log("[RBS] Houses with models:", housesWithModel);

  renderStreet(scene, housesWithModel);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

boot().catch(console.error);
