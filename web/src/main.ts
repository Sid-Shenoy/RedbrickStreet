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
import { lotLocalToWorld } from "./world/houseModel/lotTransform";

const STREET_SEED = "redbrick-street/v0";

// Surface texture scale: each texture image represents 0.5m x 0.5m.
const SURFACE_TEX_METERS = 0.5;

// Vertical layout (meters)
const PLOT_Y = 0.0;
const FIRST_FLOOR_Y = 0.2;
const SECOND_FLOOR_Y = 3.2;
const CEILING_Y = 6.2;

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
    w.material = mats.wall;
    w.checkCollisions = true;
  }

  // Plot + floors as stacked 2D layers
  renderFloorLayer(scene, houses, mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
  renderFloorLayer(scene, houses, mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

  // Second floor: double-sided so underside is visible while walking below.
  renderFloorLayer(scene, houses, matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, false);

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

  renderStreet(scene, housesWithModel);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

boot().catch(console.error);
