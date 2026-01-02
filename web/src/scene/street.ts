import { Scene, MeshBuilder, StandardMaterial, Texture, Color3 } from "@babylonjs/core";

import type { HouseWithModel } from "../world/houseModel/types";
import { surfaceMaterial } from "./materials";
import { applyWorldUVs, applyWorldBoxUVs } from "./uvs";
import { renderFloorLayer, renderCeilingLayer } from "./regions";
import { renderCurbFaces } from "./curb";
import { renderBoundaryWallsForLayer } from "./boundaryWalls";
import { renderExteriorBrickPrisms } from "./exteriorBrick";
import { renderRoofs } from "./roof";
import { renderStairs } from "./stairs";
import { SURFACE_TEX_METERS, PLOT_Y, FIRST_FLOOR_Y, SECOND_FLOOR_Y, CEILING_Y, INTER_FLOOR_CEILING_EPS } from "./constants";

export function renderStreet(scene: Scene, houses: HouseWithModel[]) {
  const mats = surfaceMaterial(scene); // normal (single-sided)
  const matsDouble = surfaceMaterial(scene, { doubleSided: true }); // for viewing from below

  // Street: 230m (x-axis) by 70m (z-axis)
  // Road: x 0..230, z 30..40 => width=230, height=10
  const road = MeshBuilder.CreateGround("road", { width: 230, height: 10 }, scene);
  road.position.x = 115;
  road.position.z = 35;
  road.material = mats.road;
  applyWorldUVs(road, SURFACE_TEX_METERS);
  road.checkCollisions = true;
  road.metadata = { rbs: { kind: "floor", layer: "road" } };

  // Add a vertical curb face so the raised plot meets the road visually.
  renderCurbFaces(scene, houses, mats);

  // Boundary wall around 230 x 70
  // IMPORTANT: Only these 4 exterior street walls use brick_dark.jpg.
  const streetBrickDarkMat = new StandardMaterial("street_brick_dark", scene);
  streetBrickDarkMat.diffuseTexture = new Texture("/assets/textures/surfaces/brick_dark.jpg", scene);
  streetBrickDarkMat.specularColor = new Color3(0.08, 0.08, 0.08);
  const wallH = 10;
  const wallT = 0.5;

  const wallNorth = MeshBuilder.CreateBox("wall_n", { width: 230, height: wallH, depth: wallT }, scene);
  // Move walls outward so their INNER faces align with the street outer edges:
  // - north inner face at z=0
  // - south inner face at z=70
  // - west inner face at x=0
  // - east inner face at x=230
  wallNorth.position.set(115, wallH / 2, -wallT / 2);

  const wallSouth = MeshBuilder.CreateBox("wall_s", { width: 230, height: wallH, depth: wallT }, scene);
  wallSouth.position.set(115, wallH / 2, 70 + wallT / 2);

  const wallWest = MeshBuilder.CreateBox("wall_w", { width: wallT, height: wallH, depth: 70 }, scene);
  wallWest.position.set(-wallT / 2, wallH / 2, 35);

  const wallEast = MeshBuilder.CreateBox("wall_e", { width: wallT, height: wallH, depth: 70 }, scene);
  wallEast.position.set(230 + wallT / 2, wallH / 2, 35);


  for (const w of [wallNorth, wallSouth, wallWest, wallEast]) {
    w.material = streetBrickDarkMat;
    applyWorldBoxUVs(w, SURFACE_TEX_METERS);
    w.checkCollisions = true;
  }

  // Plot + floors as stacked 2D layers
  renderFloorLayer(scene, houses, mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
  renderFloorLayer(scene, houses, mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

  // Boundary walls between rooms AND along exterior edges use the house wall texture.
  // Doors are rendered as 0.8m gaps in these boundary walls (no door mesh yet).
  const wallMat = matsDouble.wall;

  // Use a slightly different material for ceilings so planes are visually distinguishable.
  // Keep it double-sided (we often view ceilings from below).
  const ceilingMat = new StandardMaterial("ceiling_mat", scene);
  ceilingMat.diffuseTexture = wallMat.diffuseTexture;
  ceilingMat.backFaceCulling = false;
  ceilingMat.diffuseColor = new Color3(0.92, 0.92, 0.92);
  ceilingMat.specularColor = new Color3(0.03, 0.03, 0.03);

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.firstFloor.regions,
    (h) => h.model.firstFloor.construction,
    PLOT_Y,         // walls start at plot level (fixes "floating")
    SECOND_FLOOR_Y, // walls end at second-floor level
    PLOT_Y,         // door openings start at plot level (so exterior doors are traversable without porch/steps yet)
    FIRST_FLOOR_Y,  // sill/threshold should sit at real first-floor height
    "ff",
    wallMat
  );

  // Stairs: 10cm planks (same surface as the "stairs" region), clockwise ascent to the 2F opening lead edge.
  renderStairs(scene, houses, matsDouble as unknown as Record<string, StandardMaterial>);

  // First-floor ceiling:
  // - Same material as walls (painted drywall look).
  // - Offset slightly below SECOND_FLOOR_Y to avoid z-fighting with second-floor floors.
  // - No ceiling above the first-floor stairs (stairwell opening).
  renderCeilingLayer(
    scene,
    houses,
    ceilingMat,
    "firstCeiling",
    (h) => h.model.firstFloor.regions.filter((r) => r.name !== "stairs"),
    SECOND_FLOOR_Y - INTER_FLOOR_CEILING_EPS
  );

  // Second floor: double-sided so underside is visible while walking below.
  renderFloorLayer(scene, houses, matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, true);

  renderBoundaryWallsForLayer(
    scene,
    houses,
    (h) => h.model.secondFloor.regions,
    (h) => h.model.secondFloor.construction,
    SECOND_FLOOR_Y, // walls start at second-floor level
    CEILING_Y,      // walls end at ceiling level
    SECOND_FLOOR_Y, // door openings start at second-floor level
    SECOND_FLOOR_Y, // sill/threshold should sit at real second-floor height
    "sf",
    wallMat
  );

  // Ceiling (congruent with houseregion) at 6.2m, double-sided so underside is visible.
  // Second-floor ceiling (roof underside) must match the second-floor footprint.
  // Include void regions so the stairwell is capped at roof level (realistic).
  renderCeilingLayer(
    scene,
    houses,
    ceilingMat,
    "secondCeiling",
    (h) => h.model.secondFloor.regions,
    CEILING_Y,
    { includeVoid: true }
  );

  // Exterior envelope: brick-clad houseregion prism (no caps => no z-fighting with floors/ceilings).
  // Offset slightly outward from the existing boundary walls to avoid coplanar overlap.
  renderExteriorBrickPrisms(scene, houses);

  // Roof: 0.2m prism on top of the brick perimeter.
  renderRoofs(scene, houses);
}
