import { Scene, UniversalCamera } from "@babylonjs/core";
import type { HouseWithModel } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { pickFloorY } from "./floorPick";
import { PLOT_Y } from "./constants";

export function spawnPlayerAtHouse7Walkway(scene: Scene, camera: UniversalCamera, houses: HouseWithModel[]) {
  const h7 = houses.find((h) => h.houseNumber === 7);
  if (!h7) throw new Error("[RBS] Spawn failed: house 7 not found");

  const walkway = h7.model.plot.regions.find((r) => r.name === "walkway");
  if (!walkway || walkway.type !== "rectangle") {
    throw new Error("[RBS] Spawn failed: house 7 plot missing 'walkway' rectangle region");
  }

  const [[ax, az], [bx, bz]] = walkway.points;

  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const z0 = Math.min(az, bz);
  const z1 = Math.max(az, bz);

  const cx = (x0 + x1) * 0.5;
  const cz = (z0 + z1) * 0.5;

  const p = lotLocalToWorld(h7, cx, cz);

  // Put the player on the plot surface (walkway is a plot region), preserving the current camera eye height.
  const eyeH = camera.position.y; // default is 1.7
  const floorY = pickFloorY(scene, p.x, p.z, 20, 50) ?? PLOT_Y;

  camera.position.x = p.x;
  camera.position.z = p.z;
  camera.position.y = floorY + eyeH;
}
