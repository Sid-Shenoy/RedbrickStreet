import { Engine, Scene, UniversalCamera, HemisphericLight, DirectionalLight, Vector3, Color3, MeshBuilder } from "@babylonjs/core";
import { UniversalCameraXZKeyboardInput } from "./scene/universalCameraXZKeyboardInput";

import { loadStreetConfig } from "./config/loadStreetConfig";
import { attachHouseModel } from "./world/houseModel/attachHouseModel";
import { renderStreet } from "./scene/street";
import { spawnPlayerAtHouse7Walkway } from "./scene/spawn";
import { setupAutoStep } from "./scene/autoStep";
import { pickFloorY } from "./scene/floorPick";

const STREET_SEED = "redbrick-street/v0";

async function boot() {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("Missing <canvas id='renderCanvas'> in index.html");

  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.35, 0);

  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.95;

  // Bounce light so downward-facing surfaces (e.g. door lintel undersides) aren't unrealistically black.
  light.groundColor = new Color3(0.35, 0.35, 0.35);

  // Key light to create directional shading (makes walls distinguishable / more 3D).
  const key = new DirectionalLight("key", new Vector3(-0.6, -1.0, -0.4), scene);
  key.position = new Vector3(115, 50, 35); // above the street center
  key.intensity = 0.35;

  // WASD + mouse look
  const camera = new UniversalCamera("cam", new Vector3(100, 1.7, 35), scene);

  // Fix: keep keyboard movement on the XZ plane so looking up/down doesn't change speed.
  camera.inputs.removeByType("FreeCameraKeyboardMoveInput");
  camera.inputs.add(new UniversalCameraXZKeyboardInput());

  camera.attachControl(canvas, true);
  camera.speed = 0.05;
  camera.angularSensibility = 4000;

  camera.applyGravity = true;
  camera.checkCollisions = true;
  camera.ellipsoid = new Vector3(0.35, 0.9, 0.35);

  // Set near plane to a very small value to prevent seeing through walls when close
  // This allows the player to get very close to objects without clipping issues
  camera.minZ = 0.05;

  camera.keysUp = [87]; // W
  camera.keysDown = [83]; // S
  camera.keysLeft = [65]; // A
  camera.keysRight = [68]; // D

  // Space: jump ~60cm (smooth), only when grounded. Gravity remains enabled.
  const JUMP_HEIGHT_M = 0.6;
  const JUMP_ASCEND_S = 0.5;
  const GROUND_TOL_M = 0.12;

  // Approx standing offset: camera.position.y - floorY when grounded.
  let groundOffsetY: number | null = null;

  let jumpActive = false;
  let jumpT = 0;
  let jumpStartY = 0;

  // Proxy mesh used ONLY to run a collision-aware vertical move (cameras don't have moveWithCollisions).
  const jumpProxy = MeshBuilder.CreateSphere("rbs_jump_proxy", { diameter: 0.1 }, scene);
  jumpProxy.isVisible = false;
  jumpProxy.isPickable = false;
  jumpProxy.checkCollisions = true;
  jumpProxy.ellipsoid = camera.ellipsoid.clone();
  jumpProxy.ellipsoidOffset = camera.ellipsoidOffset.clone();
  jumpProxy.setEnabled(false);
  scene.onDisposeObservable.add(() => jumpProxy.dispose());

  function easeOutQuad(t: number) {
    return 1 - (1 - t) * (1 - t);
  }

  function sampleFloorY(): number | null {
    // Probe from just above the camera so we don't start above indoor ceilings (which would block the ray).
    return pickFloorY(scene, camera.position.x, camera.position.z, camera.position.y + 0.1, 30);
  }

  function isGrounded(): boolean {
    const floorY = sampleFloorY();
    if (floorY === null) return false;

    const dy = camera.position.y - floorY;

    // Initialize and/or refresh standing offset when we're plausibly on the ground.
    if (groundOffsetY === null) groundOffsetY = dy;
    if (Math.abs(dy - groundOffsetY) <= 0.25) groundOffsetY = dy;

    return Math.abs(dy - groundOffsetY) <= GROUND_TOL_M;
  }

  const jumpHandler = (ev: KeyboardEvent) => {
    if (ev.code !== "Space" || ev.repeat) return;
    ev.preventDefault();

    if (jumpActive) return;
    if (!isGrounded()) return;

    jumpActive = true;
    jumpT = 0;
    jumpStartY = camera.position.y;
  };

  window.addEventListener("keydown", jumpHandler);
  scene.onDisposeObservable.add(() => window.removeEventListener("keydown", jumpHandler));

  scene.onBeforeRenderObservable.add(() => {
    // Keep the grounded offset fresh when we're not jumping.
    if (!jumpActive) {
      const floorY = sampleFloorY();
      if (floorY !== null) {
        const dy = camera.position.y - floorY;
        if (groundOffsetY === null || Math.abs(dy - groundOffsetY) <= 0.25) {
          groundOffsetY = dy;
        }
      }
      return;
    }

    const dtReal = scene.getEngine().getDeltaTime() / 1000;
    const dtJump = Math.min(dtReal, 1 / 30);
    jumpT += dtJump;

    const a = Math.min(1, jumpT / JUMP_ASCEND_S);
    const targetY = jumpStartY + easeOutQuad(a) * JUMP_HEIGHT_M;

    const dy = targetY - camera.position.y;
    if (Math.abs(dy) > 1e-6) {
      jumpProxy.setEnabled(true);
      jumpProxy.position.copyFrom(camera.position);
      jumpProxy.moveWithCollisions(new Vector3(0, dy, 0));
      jumpProxy.setEnabled(false);
      camera.position.copyFrom(jumpProxy.position);
    }

    if (a >= 1) {
      // Stop forcing upward motion; gravity handles the fall naturally.
      jumpActive = false;
    }
  });

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
