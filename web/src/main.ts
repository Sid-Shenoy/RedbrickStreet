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
} from "@babylonjs/core";

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

// For now, our generator only emits rectangles. This keeps rendering simple.
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

function renderHouseBlock(scene: Scene, house: HouseWithModel, mats: ReturnType<typeof surfaceMaterial>) {
  // Find the "houseregion" (black) and draw a simple box so houses are visible
  const hr = house.model.plot.regions.find((r) => r.name === "houseregion" && r.type === "rectangle") as
    | Extract<Region, { type: "rectangle" }>
    | undefined;

  if (!hr) return;

  const [[x0, z0], [x1, z1]] = hr.points;
  const pA = lotLocalToWorld(house, x0, z0);
  const pB = lotLocalToWorld(house, x1, z1);

  const minX = Math.min(pA.x, pB.x);
  const maxX = Math.max(pA.x, pB.x);
  const minZ = Math.min(pA.z, pB.z);
  const maxZ = Math.max(pA.z, pB.z);

  const w = Math.max(0.5, maxX - minX);
  const d = Math.max(0.5, maxZ - minZ);
  const h = 6;

  const box = MeshBuilder.CreateBox(`house_${house.houseNumber}`, { width: w, depth: d, height: h }, scene);
  box.position.x = minX + w / 2;
  box.position.z = minZ + d / 2;
  box.position.y = h / 2;
  box.material = mats.wall;
  box.checkCollisions = true;
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

  // Plot regions + simple house boxes
  for (const house of houses) {
    for (const region of house.model.plot.regions) {
      if (region.type !== "rectangle") continue; // keep prototype simple for now
      const mat = mats[region.surface];
      renderRectRegion(scene, house, region, mat);
    }
    renderHouseBlock(scene, house, mats);
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
  camera.speed = 0.6;
  camera.angularSensibility = 4000;

  camera.applyGravity = true;
  camera.checkCollisions = true;
  camera.ellipsoid = new Vector3(0.35, 0.9, 0.35);

  camera.keysUp = [87];    // W
  camera.keysDown = [83];  // S
  camera.keysLeft = [65];  // A
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
