import {
  Engine,
  Scene,
  UniversalCamera,
  HemisphericLight,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Mesh,
  VertexData,
} from "@babylonjs/core";

import earcut from "earcut";

import { loadStreetConfig } from "./config/loadStreetConfig";
import { attachHouseModel } from "./world/houseModel/attachHouseModel";
import type { HouseWithModel, Region } from "./world/houseModel/types";
import { lotLocalToWorld } from "./world/houseModel/lotTransform";

const STREET_SEED = "redbrick-street/v0";

function makeMat(scene: Scene, name: string, color: Color3): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  return m;
}

function surfaceMaterial(scene: Scene) {
  return {
    black: makeMat(scene, "mat_black", new Color3(0.08, 0.08, 0.08)),
    grass: makeMat(scene, "mat_grass", new Color3(0.18, 0.35, 0.18)),
    concrete_light: makeMat(scene, "mat_conc_light", new Color3(0.75, 0.75, 0.75)),
    concrete_medium: makeMat(scene, "mat_conc_med", new Color3(0.55, 0.55, 0.55)),
    concrete_dark: makeMat(scene, "mat_conc_dark", new Color3(0.32, 0.32, 0.32)),
    road: makeMat(scene, "mat_road", new Color3(0.12, 0.12, 0.12)),
    wall: makeMat(scene, "mat_wall", new Color3(0.45, 0.20, 0.18)),
  } as const;
}

// Rect region renderer (CreateGround)
function renderRectRegion(
  scene: Scene,
  house: HouseWithModel,
  region: Extract<Region, { type: "rectangle" }>,
  mat: StandardMaterial
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
    `region_${house.houseNumber}_${region.name}`,
    { width, height, subdivisions: 1 },
    scene
  );

  mesh.position.x = minX + width / 2;
  mesh.position.z = minZ + height / 2;
  mesh.material = mat;
  mesh.checkCollisions = true;

  return mesh;
}

// Polygon region renderer (triangulated via earcut)
function renderPolyRegion(
  scene: Scene,
  house: HouseWithModel,
  region: Extract<Region, { type: "polygon" }>,
  mat: StandardMaterial
): Mesh {
  // If polygon is explicitly closed (last point == first), drop the last point for triangulation.
  const pts = region.points;
  const basePts =
    pts.length >= 4 &&
    pts[0]![0] === pts[pts.length - 1]![0] &&
    pts[0]![1] === pts[pts.length - 1]![1]
      ? pts.slice(0, -1)
      : pts;

  if (basePts.length < 3) {
    const empty = new Mesh(`region_${house.houseNumber}_${region.name}`, scene);
    empty.material = mat;
    return empty;
  }

  // Convert to world-space XZ points
  const world = basePts.map(([lx, lz]) => lotLocalToWorld(house, lx, lz));

  // earcut expects a flat [x0, y0, x1, y1, ...] array (we use x,z)
  const coords2d: number[] = [];
  const positions: number[] = [];
  const uvs: number[] = [];

  // Simple planar UVs (not used for flat colors, but keeps mesh valid for future)
  const uvScale = 0.1;

  for (const p of world) {
    coords2d.push(p.x, p.z);
    positions.push(p.x, 0, p.z);
    uvs.push(p.x * uvScale, p.z * uvScale);
  }

  const indices = earcut(coords2d, undefined, 2);

  const mesh = new Mesh(`region_${house.houseNumber}_${region.name}`, scene);

  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.uvs = uvs;

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;

  vd.applyToMesh(mesh);

  mesh.material = mat;
  mesh.checkCollisions = true;

  return mesh;
}

function renderStreet(scene: Scene, houses: HouseWithModel[]) {
  const mats = surfaceMaterial(scene);

  // Road: x 0..200, z 30..40 => width=200, height=10
  const road = MeshBuilder.CreateGround("road", { width: 200, height: 10 }, scene);
  road.position.x = 100;
  road.position.z = 35;
  road.material = mats.road;
  road.checkCollisions = true;

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

  // Plot regions only (2D)
  for (const house of houses) {
    for (const region of house.model.plot.regions) {
      const mat = mats[region.surface];

      if (region.type === "rectangle") {
        renderRectRegion(scene, house, region, mat);
      } else {
        renderPolyRegion(scene, house, region, mat);
      }
    }
  }
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

  // Load config + attach seeded models
  const { houses } = await loadStreetConfig();
  const housesWithModel = houses.map((h) => attachHouseModel(h, STREET_SEED));

  renderStreet(scene, housesWithModel);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

boot().catch(console.error);
