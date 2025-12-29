import { Scene, MeshBuilder, StandardMaterial, Mesh, VertexData, AbstractMesh } from "@babylonjs/core";
import earcut from "earcut";

import type { HouseWithModel, Region } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { SURFACE_TEX_METERS, CEILING_Y } from "./constants";
import { applyWorldUVs } from "./uvs";

export type RegionMeshKind = "floor" | "ceiling";

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

export function renderFloorLayer(
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

export function renderCeilingLayer(
  scene: Scene,
  houses: HouseWithModel[],
  ceilingMat: StandardMaterial,
  layerTag: string,
  getRegions: (h: HouseWithModel) => Region[],
  baseY: number,
  opts?: { includeVoid?: boolean }
) {
  const includeVoid = opts?.includeVoid ?? false;

  for (const house of houses) {
    const regions = getRegions(house);

    for (const region of regions) {
      if (!includeVoid && region.surface === "void") continue;

      if (region.type === "rectangle") {
        renderRectRegion(scene, house, region, ceilingMat, "ceiling", layerTag, baseY, false);
      } else {
        renderPolyRegion(scene, house, region, ceilingMat, "ceiling", layerTag, baseY, false);
      }
    }
  }
}

export function renderCeilings(scene: Scene, houses: HouseWithModel[], ceilingMat: StandardMaterial) {
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
