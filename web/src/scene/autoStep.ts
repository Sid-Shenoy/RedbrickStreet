import { Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { pickFloorY } from "./floorPick";
import { MAX_STEP_UP, STEP_PROBE_DIST, STEP_NUDGE_FWD } from "./constants";

export function setupAutoStep(scene: Scene, camera: UniversalCamera) {
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
