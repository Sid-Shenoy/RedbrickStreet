import { Engine, Scene, UniversalCamera, HemisphericLight, DirectionalLight, Vector3, Color3, MeshBuilder } from "@babylonjs/core";
import { UniversalCameraXZKeyboardInput } from "./scene/universalCameraXZKeyboardInput";

import { loadStreetConfig } from "./config/loadStreetConfig";
import { attachHouseModel } from "./world/houseModel/attachHouseModel";
import { renderStreet } from "./scene/street";
import { spawnPlayerAtHouse7Walkway } from "./scene/spawn";
import { setupAutoStep } from "./scene/autoStep";
import { pickFloorY } from "./scene/floorPick";
import { createHud } from "./ui/hud";
import { loadWeaponsConfig } from "./config/loadWeaponsConfig";
import { createWeaponUi } from "./ui/weaponUi";
import { createIntroOverlay } from "./ui/intro";

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

  // Camera is created immediately so the scene can render behind the intro overlay,
  // but controls are not attached until the player presses Space to begin.
  const camera = new UniversalCamera("cam", new Vector3(100, 1.7, 35), scene);

  // Fix: keep keyboard movement on the XZ plane so looking up/down doesn't change speed.
  camera.inputs.removeByType("FreeCameraKeyboardMoveInput");
  camera.inputs.add(new UniversalCameraXZKeyboardInput());

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

  // Load config + attach seeded models
  const { houses } = await loadStreetConfig();
  const { weapons } = await loadWeaponsConfig();
  const housesWithModel = houses.map((h) => attachHouseModel(h, STREET_SEED));

  renderStreet(scene, camera, housesWithModel);
  spawnPlayerAtHouse7Walkway(scene, camera, housesWithModel);

  // Start rendering immediately so the world is visible behind the intro.
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // Intro overlay (Space to begin)
  const intro = createIntroOverlay(scene);
  await intro.waitForStart();

  // Click-to-pointer-lock (better mouse look)
  scene.onPointerDown = () => {
    canvas.requestPointerLock?.();
  };

  // Enable WASD + mouse look now that the player has started.
  camera.attachControl(canvas, true);

  setupAutoStep(scene, camera);

  // Space: jump ~60cm (smooth), only when grounded.
  // Fix: animate BOTH ascent and descent so the fall isn't an instant "slam" under strong scene gravity.
  // We temporarily disable Babylon gravity during the jump arc, then restore it on landing (or when the arc ends).
  const JUMP_HEIGHT_M = 0.6;
  const JUMP_ASCEND_S = 0.5;
  const JUMP_DESCEND_S = 0.4; // slightly longer descent for a smoother, more natural fall
  const GROUND_TOL_M = 0.12;
  const LAND_TOL_M = 0.03;

  // Approx standing offset: camera.position.y - floorY when grounded.
  let groundOffsetY: number | null = null;

  let jumpActive = false;
  let jumpT = 0;
  let jumpStartY = 0;

  // The actually-achieved jump peak delta (may be reduced if the head hits a ceiling).
  let jumpPeakDY = JUMP_HEIGHT_M;

  // Standing offset captured at jump start (used to land cleanly back on the floor).
  let jumpGroundOffsetY = 0;

  const baseApplyGravity = camera.applyGravity;

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

  function easeInQuad(t: number) {
    return t * t;
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

    const floorY = sampleFloorY();
    if (floorY === null) return;

    // Capture the current grounded offset so landing is stable even if the floor height changes slightly.
    jumpGroundOffsetY = camera.position.y - floorY;
    groundOffsetY = jumpGroundOffsetY;

    jumpActive = true;
    jumpT = 0;
    jumpStartY = camera.position.y;
    jumpPeakDY = JUMP_HEIGHT_M;

    // Disable gravity during the scripted jump arc.
    camera.applyGravity = false;
  };

  window.addEventListener("keydown", jumpHandler);
  scene.onDisposeObservable.add(() => window.removeEventListener("keydown", jumpHandler));

  scene.onBeforeRenderObservable.add(() => {
    if (!jumpActive) {
      // Keep the grounded offset fresh when we're not jumping.
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

    const total = JUMP_ASCEND_S + JUMP_DESCEND_S;

    // Compute targetY from a smooth, quadratic-ish arc (ease-out up, ease-in down).
    let targetY = jumpStartY;

    if (jumpT <= JUMP_ASCEND_S) {
      const a = Math.min(1, jumpT / JUMP_ASCEND_S);
      targetY = jumpStartY + easeOutQuad(a) * jumpPeakDY;
    } else {
      const d = Math.min(1, (jumpT - JUMP_ASCEND_S) / JUMP_DESCEND_S);
      targetY = jumpStartY + (1 - easeInQuad(d)) * jumpPeakDY;
    }

    const desiredDy = targetY - camera.position.y;

    if (Math.abs(desiredDy) > 1e-6) {
      jumpProxy.setEnabled(true);
      jumpProxy.position.copyFrom(camera.position);
      jumpProxy.moveWithCollisions(new Vector3(0, desiredDy, 0));
      jumpProxy.setEnabled(false);

      const prevY = camera.position.y;
      camera.position.copyFrom(jumpProxy.position);

      // If we're ascending and collision prevented reaching the target height, treat that as the peak.
      if (jumpT < JUMP_ASCEND_S - 1e-4) {
        const climbed = camera.position.y - prevY;
        const wanted = desiredDy;

        // If we wanted to go up but couldn't (hit ceiling), clamp peak and begin descent.
        if (wanted > 0 && climbed < wanted - 1e-4) {
          jumpPeakDY = Math.max(0, camera.position.y - jumpStartY);
          jumpT = Math.max(jumpT, JUMP_ASCEND_S);
        }
      }
    }

    // If descending, land smoothly when we're back at (floorY + jumpGroundOffsetY).
    if (jumpT >= JUMP_ASCEND_S) {
      const floorY = sampleFloorY();
      if (floorY !== null) {
        const desiredGroundY = floorY + jumpGroundOffsetY;

        if (camera.position.y <= desiredGroundY + LAND_TOL_M) {
          const snapDy = desiredGroundY - camera.position.y;
          if (Math.abs(snapDy) > 1e-6) {
            jumpProxy.setEnabled(true);
            jumpProxy.position.copyFrom(camera.position);
            jumpProxy.moveWithCollisions(new Vector3(0, snapDy, 0));
            jumpProxy.setEnabled(false);
            camera.position.copyFrom(jumpProxy.position);
          }

          groundOffsetY = jumpGroundOffsetY;

          jumpActive = false;
          camera.applyGravity = baseApplyGravity;
          return;
        }
      }
    }

    // If the arc finished but we didn't land (e.g. jumped over a drop), restore gravity so normal falling continues.
    if (jumpT >= total) {
      jumpActive = false;
      camera.applyGravity = baseApplyGravity;
    }
  });

  // HUD + weapon UI (created after start so they don't clutter the intro)
  createHud(scene, camera, housesWithModel);
  createWeaponUi(scene, canvas, weapons);
}

boot().catch(console.error);
