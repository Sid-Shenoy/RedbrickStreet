import { Scene, UniversalCamera, Vector3, MeshBuilder } from "@babylonjs/core";
import { pickFloorY } from "./floorPick";

const MAX_STEP_UP = 0.5;       // max vertical step
const STEP_PROBE_DIST = 0.5;  // how far ahead we sample the floor
const STEP_NUDGE_FWD = 0.05;   // small forward push after stepping
const STEP_LAND_TOL = 0.08;    // how close we must be to the target floor height to "count" as landed

export function setupAutoStep(scene: Scene, camera: UniversalCamera) {
  // Proxy mesh used ONLY to run a collision-aware nudge.
  // (Cameras don’t have moveWithCollisions, meshes do.)
  const stepProxy = MeshBuilder.CreateSphere("rbs_step_proxy", { diameter: 0.1 }, scene);
  stepProxy.isVisible = false;
  stepProxy.isPickable = false;
  stepProxy.checkCollisions = true;
  stepProxy.ellipsoid = camera.ellipsoid.clone();
  stepProxy.ellipsoidOffset = camera.ellipsoidOffset.clone();
  stepProxy.setEnabled(false);

  scene.onDisposeObservable.add(() => stepProxy.dispose());

  scene.onBeforeRenderObservable.add(() => {
    // Only consider horizontal intent.
    const v = camera.cameraDirection;
    const dir = new Vector3(v.x, 0, v.z);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.scaleInPlace(1 / len);

    const curY = pickFloorY(scene, camera.position.x, camera.position.z, camera.position.y + 2.0, 30);
    if (curY === null) return;

    const probeX = camera.position.x + dir.x * STEP_PROBE_DIST;
    const probeZ = camera.position.z + dir.z * STEP_PROBE_DIST;
    const aheadY = pickFloorY(scene, probeX, probeZ, camera.position.y + 2.0, 30);
    if (aheadY === null) return;

    const dy = aheadY - curY;
    if (dy <= 0 || dy > MAX_STEP_UP) return;

    const prevPos = camera.position.clone();

    // Step up (temporarily).
    camera.position.y += dy;

    // Collision-aware forward nudge using the proxy mesh.
    stepProxy.setEnabled(true);
    stepProxy.position.copyFrom(camera.position);
    stepProxy.moveWithCollisions(new Vector3(dir.x * STEP_NUDGE_FWD, 0, dir.z * STEP_NUDGE_FWD));
    stepProxy.setEnabled(false);

    const movedFwd =
      (stepProxy.position.x - prevPos.x) * dir.x +
      (stepProxy.position.z - prevPos.z) * dir.z;

    // Critical: only commit the step if we actually "land" on the higher surface.
    // This prevents stepping up when the higher floor is behind a full-height wall (the house glitch),
    // and also prevents "wall climbing" by sliding along the wall at an angle.
    const landedY = pickFloorY(
      scene,
      stepProxy.position.x,
      stepProxy.position.z,
      camera.position.y + 2.0,
      30
    );

    const landedOnTarget =
      landedY !== null &&
      Math.abs(landedY - aheadY) <= STEP_LAND_TOL &&
      landedY > curY + 1e-3;

    if (movedFwd > STEP_NUDGE_FWD * 0.25 && landedOnTarget) {
      camera.position.x = stepProxy.position.x;
      camera.position.z = stepProxy.position.z;
      // keep the stepped-up Y we already applied
    } else {
      // Blocked (e.g. exterior wall): revert completely.
      camera.position.copyFrom(prevPos);
    }
  });
}
