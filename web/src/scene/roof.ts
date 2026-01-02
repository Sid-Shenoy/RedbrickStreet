// web/src/scene/roof.ts
import { Scene, Mesh, StandardMaterial, Texture, Color3, VertexData } from "@babylonjs/core";
import earcut from "earcut";

import type { HouseWithModel } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { SURFACE_TEX_METERS, CEILING_Y, BOUNDARY_WALL_T } from "./constants";

type Pt = { x: number; z: number };

const EPS = 1e-6;

// Roof is a thin prism on top of the house.
const ROOF_H = 0.2; // 20 cm

// Match the exterior brick perimeter offset (same logic/values as exteriorBrick.ts).
const BRICK_GAP = 0.05;
const BRICK_OFFSET = BOUNDARY_WALL_T * 0.5 + BRICK_GAP;

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    a += p0.x * p1.z - p1.x * p0.z;
  }
  return a * 0.5;
}

// Builds an offset polygon by shifting each edge outward by BRICK_OFFSET and intersecting adjacent offset lines.
// Assumes an orthogonal (axis-aligned) simple polygon (by project invariants).
function buildOffsetPolygon(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();

  const ccw = signedArea(pts) > 0;

  const edgeOrient: Array<"h" | "v"> = new Array(n);
  const edgeOffC: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % n]!;
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;

    // Outward normal based on winding:
    // CCW => outward is right normal (dz, -dx)
    // CW  => outward is left  normal (-dz, dx)
    let nx = ccw ? dz : -dz;
    let nz = ccw ? -dx : dx;

    const len = Math.hypot(nx, nz);
    if (len > EPS) {
      nx /= len;
      nz /= len;
    } else {
      nx = 0;
      nz = 0;
    }

    if (Math.abs(dz) <= EPS && Math.abs(dx) > EPS) {
      // Horizontal edge => z constant, offset in z
      edgeOrient[i] = "h";
      edgeOffC[i] = p0.z + nz * BRICK_OFFSET;
    } else if (Math.abs(dx) <= EPS && Math.abs(dz) > EPS) {
      // Vertical edge => x constant, offset in x
      edgeOrient[i] = "v";
      edgeOffC[i] = p0.x + nx * BRICK_OFFSET;
    } else {
      // Shouldn't happen (orthogonal polygon invariant); treat as horizontal fallback.
      edgeOrient[i] = "h";
      edgeOffC[i] = p0.z;
    }
  }

  const out: Pt[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const next = i;

    const prevOrient = edgeOrient[prev]!;
    const nextOrient = edgeOrient[next]!;

    if (prevOrient === "v" && nextOrient === "h") {
      out[i] = { x: edgeOffC[prev]!, z: edgeOffC[next]! };
    } else if (prevOrient === "h" && nextOrient === "v") {
      out[i] = { x: edgeOffC[next]!, z: edgeOffC[prev]! };
    } else {
      // Degenerate (collinear edges); fall back to original vertex.
      out[i] = { x: pts[i]!.x, z: pts[i]!.z };
    }
  }

  return out;
}

function buildRoofPrismMesh(scene: Scene, name: string, perimeter: Pt[], y0: number, y1: number): Mesh {
  const mesh = new Mesh(name, scene);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const n = perimeter.length;
  if (n < 3) return mesh;

  const ccw = signedArea(perimeter) > 0;

  // --- Side faces (vertical band y0..y1) ---
  for (let i = 0; i < n; i++) {
    const a = perimeter[i]!;
    const b = perimeter[(i + 1) % n]!;

    const dx = b.x - a.x;
    const dz = b.z - a.z;

    const span = Math.hypot(dx, dz);
    if (span <= EPS) continue;

    // Outward normal (horizontal vector)
    let nx = ccw ? dz : -dz;
    let nz = ccw ? -dx : dx;

    const len = Math.hypot(nx, nz);
    if (len > EPS) {
      nx /= len;
      nz /= len;
    } else {
      nx = 0;
      nz = 0;
    }

    const base = positions.length / 3;

    // Quad vertices: a(y0) -> b(y0) -> b(y1) -> a(y1)
    positions.push(
      a.x, y0, a.z,
      b.x, y0, b.z,
      b.x, y1, b.z,
      a.x, y1, a.z
    );

    for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);

    // World-scaled UVs: U along the dominant world axis of the edge, V along Y.
    const useX = Math.abs(dx) >= Math.abs(dz);

    const uA = (useX ? a.x : a.z) / SURFACE_TEX_METERS;
    const uB = (useX ? b.x : b.z) / SURFACE_TEX_METERS;

    const v0 = y0 / SURFACE_TEX_METERS;
    const v1 = y1 / SURFACE_TEX_METERS;

    uvs.push(
      uA, v0,
      uB, v0,
      uB, v1,
      uA, v1
    );

    indices.push(
      base + 0, base + 1, base + 2,
      base + 0, base + 2, base + 3
    );
  }

  // --- Top cap (at y1), triangulated ---
  const capBase = positions.length / 3;

  const coords2d: number[] = [];
  for (const p of perimeter) {
    coords2d.push(p.x, p.z);
    positions.push(p.x, y1, p.z);
    normals.push(0, 1, 0);
    uvs.push(p.x / SURFACE_TEX_METERS, p.z / SURFACE_TEX_METERS);
  }

  const capIdx = earcut(coords2d, undefined, 2);
  for (let i = 0; i < capIdx.length; i += 3) {
    indices.push(capBase + capIdx[i]!, capBase + capIdx[i + 1]!, capBase + capIdx[i + 2]!);
  }

  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.applyToMesh(mesh);

  return mesh;
}

export function renderRoofs(scene: Scene, houses: HouseWithModel[]) {
  const roofMat = new StandardMaterial("roofing_mat", scene);

  const tex = new Texture("/assets/textures/surfaces/roofing.jpg", scene);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;

  roofMat.diffuseTexture = tex;
  roofMat.specularColor = new Color3(0.08, 0.08, 0.08);

  // Roof should be visible from below where ceilings may not cover the full houseregion.
  roofMat.backFaceCulling = false;

  const y0 = CEILING_Y;
  const y1 = CEILING_Y + ROOF_H;

  for (const house of houses) {
    const hr = house.model.plot.regions.find((r) => r.name === "houseregion");
    if (!hr || hr.type !== "polygon" || hr.points.length < 3) continue;

    const orig: Pt[] = hr.points.map(([lx, lz]) => lotLocalToWorld(house, lx, lz));
    const off: Pt[] = buildOffsetPolygon(orig);

    const roof = buildRoofPrismMesh(scene, `roof_${house.houseNumber}`, off, y0, y1);
    roof.material = roofMat;
    roof.checkCollisions = true;
    roof.isPickable = false;
  }
}
