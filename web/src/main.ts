import { Engine, Scene, UniversalCamera, HemisphericLight, Vector3 } from "@babylonjs/core";

import { loadStreetConfig } from "./config/loadStreetConfig";
import { attachHouseModel } from "./world/houseModel/attachHouseModel";
import { renderStreet } from "./scene/street";
import { spawnPlayerAtHouse7Walkway } from "./scene/spawn";
import { setupAutoStep } from "./scene/autoStep";

const STREET_SEED = "redbrick-street/v0";

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

  // ENABLED FOR TESTING!
  // Space: teleport 10m up (single activation per key press)
  const teleportUpHandler = (ev: KeyboardEvent) => {
    if (ev.code !== "Space" || ev.repeat) return;
    ev.preventDefault();
    camera.position.y += 10;
  };

  window.addEventListener("keydown", teleportUpHandler);
  scene.onDisposeObservable.add(() => window.removeEventListener("keydown", teleportUpHandler));

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
  spawnPlayerAtHouse7Walkway(scene, camera, housesWithModel);

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());
}

boot().catch(console.error);
