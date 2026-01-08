import { Engine, Scene, UniversalCamera, HemisphericLight, DirectionalLight, Vector3, Color3, MeshBuilder } from "@babylonjs/core";
import { UniversalCameraXZKeyboardInput } from "./scene/universalCameraXZKeyboardInput";
import { preloadZombieAssets, createZombieHouseStreamer, type ZombieHouseStreamer } from "./world/zombies/spawnZombies";

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
import { createWastedOverlay } from "./ui/wasted";
import { SECOND_FLOOR_Y } from "./scene/constants";

const STREET_SEED = "redbrick-street/v0";

async function boot() {
  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  if (!canvas) throw new Error("Missing <canvas id='renderCanvas'> in index.html");

  const engine = new Engine(canvas, true);
  const scene = new Scene(engine);

  scene.collisionsEnabled = true;
  scene.gravity = new Vector3(0, -0.35, 0);

  // Preload zombie model while the intro is visible.
  const zombieAssetsPromise = preloadZombieAssets(scene);

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

  const interiorsLoaded = new Set<number>();
  let zombieStreamer: ZombieHouseStreamer | null = null;

  renderStreet(scene, camera, housesWithModel, {
    onInteriorLoaded: (houseNumber) => {
      interiorsLoaded.add(houseNumber);
      zombieStreamer?.ensureHouse(houseNumber);
    },
  });

  spawnPlayerAtHouse7Walkway(scene, camera, housesWithModel);

  // Start rendering immediately so the world is visible behind the intro.
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // Intro overlay (Space to begin)
  const intro = createIntroOverlay(scene);
  await intro.waitForStart();

  // HUD + weapon UI + death overlay (created after start so they don't clutter the intro)
  const hud = createHud(scene, camera, housesWithModel);
  createWeaponUi(scene, canvas, weapons);
  const wasted = createWastedOverlay(scene);

  // Player health state (driven by zombie attacks)
  let dead = false;
  let health = 100;
  hud.setHealth(health);

  // If the camera (eye) is above this Y, the player is considered "upstairs" and cannot be damaged.
  // This prevents first-floor zombies from damaging the player through ceilings/floors.
  const PLAYER_INVULNERABLE_Y = SECOND_FLOOR_Y + 0.5;

  function killPlayer() {
    if (dead) return;
    dead = true;

    hud.setHealth(0);

    // Stop player input + pointer lock attempts.
    scene.onPointerDown = null;
    try {
      camera.detachControl();
    } catch {
      // ignore
    }
    document.exitPointerLock?.();

    // Stop zombie updates/spawns (optional, but prevents further damage work).
    zombieStreamer?.dispose();
    zombieStreamer = null;

    // Trigger death overlay (fade + gif + audio)
    wasted.trigger();

    // Restart the game shortly after death.
    window.setTimeout(() => {
      window.location.reload();
    }, 6000);
  }

  function applyDamage(dmg: number) {
    if (dead) return;
    if (!isFinite(dmg) || dmg <= 0) return;

    // Upstairs invulnerability: prevents first-floor zombies from damaging the player through floors.
    if (camera.position.y > PLAYER_INVULNERABLE_Y) return;

    health = Math.max(0, health - dmg);
    hud.setHealth(health);

    if (health <= 0) {
      killPlayer();
    }
  }

  // Create a per-house zombie streamer AFTER the intro starts, so we don't hitch during boot.
  // Player hasn't moved yet here, so camera.position is the game-start origin for MIN_ZOMBIE_SPAWN_DIST_M.
  const zombieAssets = await zombieAssetsPromise;
  zombieStreamer = createZombieHouseStreamer(
    scene,
    housesWithModel,
    { x: camera.position.x, z: camera.position.z },
    zombieAssets,
    () => ({ x: camera.position.x, z: camera.position.z }),
    (damage) => applyDamage(damage)
  );

  // Spawn zombies for any interiors that were already loaded while the intro was up.
  for (const houseNumber of interiorsLoaded) {
    zombieStreamer.ensureHouse(houseNumber);
  }

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
}

boot().catch(console.error);
