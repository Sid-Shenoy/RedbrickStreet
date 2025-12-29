import { Scene, MeshBuilder } from "@babylonjs/core";

import type { HouseWithModel } from "../world/houseModel/types";
import { surfaceMaterial } from "./materials";
import { applyWorldUVs, applyWorldBoxUVs } from "./uvs";
import { renderFloorLayer, renderCeilings } from "./regions";
import { renderCurbFaces } from "./curb";
import { renderBoundaryWallsForLayer } from "./boundaryWalls";
import { SURFACE_TEX_METERS, PLOT_Y, FIRST_FLOOR_Y, SECOND_FLOOR_Y, CEILING_Y } from "./constants";

export function renderStreet(scene: Scene, houses: HouseWithModel[]) {
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

  // Add a vertical curb face so the raised plot meets the road visually.
  renderCurbFaces(scene, houses, mats);

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
    w.material = mats.brick;
    applyWorldBoxUVs(w, SURFACE_TEX_METERS);
    w.checkCollisions = true;
  }

  // Plot + floors as stacked 2D layers
  renderFloorLayer(scene, houses, mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
  renderFloorLayer(scene, houses, mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

  // Boundary walls between rooms AND along exterior edges use the house wall texture.
  // Doors are rendered as 0.8m gaps in these boundary walls (no door mesh yet).
  const boundaryWallMat = matsDouble.wall;

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.firstFloor.regions,
    (h) => h.model.firstFloor.construction,
    PLOT_Y,        // walls start at plot level (fixes "floating")
    SECOND_FLOOR_Y, // walls end at second-floor level
    FIRST_FLOOR_Y,  // door openings start at first-floor level
    "ff",
    boundaryWallMat
  );

  // Second floor: double-sided so underside is visible while walking below.
  renderFloorLayer(scene, houses, matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, false);

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.secondFloor.regions,
    (h) => h.model.secondFloor.construction,
    SECOND_FLOOR_Y, // walls start at second-floor level
    CEILING_Y,      // walls end at ceiling level
    SECOND_FLOOR_Y, // door openings start at second-floor level
    "sf",
    boundaryWallMat
  );

  // Ceiling (congruent with houseregion) at 6.2m, double-sided so underside is visible.
  renderCeilings(scene, houses, matsDouble.concrete_light);
}
