import { Scene, MeshBuilder, StandardMaterial, Texture, Color3 } from "@babylonjs/core";

import type { HouseWithModel, BrickTextureFile } from "../world/houseModel/types";
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

  // --- Streaming setup ---
  const SPAWN_HOUSE = 7;

  // What we render immediately (so the player never sees “nothing” near spawn).
  const INITIAL_EXTERIOR_RADIUS = 3; // houses 4..10 get plot+exterior immediately
  const INITIAL_INTERIOR_RADIUS = 0; // only house 7 gets full interior immediately

  // How much work to do per rendered frame (ms). Lower = smoother, higher = faster completion.
  const FRAME_BUDGET_MS = 6;

  const wallMat = matsDouble.wall;

  // Use a slightly different material for ceilings so planes are visually distinguishable.
  // Keep it double-sided (we often view ceilings from below).
  const ceilingMat = new StandardMaterial("ceiling_mat", scene);
  ceilingMat.diffuseTexture = wallMat.diffuseTexture;
  ceilingMat.backFaceCulling = false;
  ceilingMat.diffuseColor = new Color3(0.92, 0.92, 0.92);
  ceilingMat.specularColor = new Color3(0.03, 0.03, 0.03);

  const dist = (h: HouseWithModel) => Math.abs(h.houseNumber - SPAWN_HOUSE);

  const housesByPriority = [...houses].sort((a, b) => {
    const da = dist(a);
    const db = dist(b);
    if (da !== db) return da - db;
    return a.houseNumber - b.houseNumber;
  });

  const exteriorDone = new Set<number>();
  const interiorDone = new Set<number>();

  // Caches so streaming does NOT recreate textures/materials repeatedly.
  const brickMats = new Map<BrickTextureFile, StandardMaterial>();
  let roofMat: StandardMaterial | undefined;

  function renderHousePlot(house: HouseWithModel) {
    renderFloorLayer(scene, [house], mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
  }

  function renderHouseExterior(house: HouseWithModel) {
    renderExteriorBrickPrisms(scene, [house], brickMats);
    roofMat = renderRoofs(scene, [house], roofMat);
  }

  function renderHouseInterior(house: HouseWithModel) {
    // First floor
    renderFloorLayer(scene, [house], mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.firstFloor.regions,
      (h) => h.model.firstFloor.construction,
      PLOT_Y, // walls start at plot level (fixes "floating")
      SECOND_FLOOR_Y, // walls end at second-floor level
      PLOT_Y, // door openings start at plot level (so exterior doors are traversable without porch/steps yet)
      FIRST_FLOOR_Y, // sill/threshold should sit at real first-floor height
      "ff",
      wallMat
    );

    // Stairs
    renderStairs(scene, [house], matsDouble as unknown as Record<string, StandardMaterial>);

    // First-floor ceiling (no ceiling above stairs)
    renderCeilingLayer(
      scene,
      [house],
      ceilingMat,
      "firstCeiling",
      (h) => h.model.firstFloor.regions.filter((r) => r.name !== "stairs"),
      SECOND_FLOOR_Y - INTER_FLOOR_CEILING_EPS
    );

    // Second floor
    renderFloorLayer(scene, [house], matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, true);

    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.secondFloor.regions,
      (h) => h.model.secondFloor.construction,
      SECOND_FLOOR_Y, // walls start at second-floor level
      CEILING_Y, // walls end at ceiling level
      SECOND_FLOOR_Y, // door openings start at second-floor level
      SECOND_FLOOR_Y, // sill/threshold should sit at real second-floor height
      "sf",
      wallMat
    );

    // Second-floor ceiling (include void regions so stairwell is capped)
    renderCeilingLayer(
      scene,
      [house],
      ceilingMat,
      "secondCeiling",
      (h) => h.model.secondFloor.regions,
      CEILING_Y,
      { includeVoid: true }
    );
  }

  function renderHousePlotAndExterior(house: HouseWithModel) {
    renderHousePlot(house);
    renderHouseExterior(house);
  }

  // --- Immediate render near spawn ---
  for (const h of housesByPriority) {
    if (dist(h) <= INITIAL_EXTERIOR_RADIUS) {
      exteriorDone.add(h.houseNumber);
      renderHousePlotAndExterior(h);
    }
  }

  for (const h of housesByPriority) {
    if (dist(h) <= INITIAL_INTERIOR_RADIUS) {
      interiorDone.add(h.houseNumber);
      renderHouseInterior(h);
    }
  }

  // --- Background jobs (plot+exterior first, then interiors) ---
  const tasks: Array<() => void> = [];

  for (const h of housesByPriority) {
    if (!exteriorDone.has(h.houseNumber)) {
      tasks.push(() => {
        if (exteriorDone.has(h.houseNumber)) return;
        exteriorDone.add(h.houseNumber);
        renderHousePlotAndExterior(h);
      });
    }
  }

  for (const h of housesByPriority) {
    if (!interiorDone.has(h.houseNumber)) {
      tasks.push(() => {
        if (interiorDone.has(h.houseNumber)) return;
        interiorDone.add(h.houseNumber);
        renderHouseInterior(h);
      });
    }
  }

  if (tasks.length > 0) {
    let obs: any = null;

    obs = scene.onBeforeRenderObservable.add(() => {
      const t0 = performance.now();

      while (tasks.length > 0 && performance.now() - t0 < FRAME_BUDGET_MS) {
        const job = tasks.shift();
        if (job) job();
      }

      if (tasks.length === 0 && obs) {
        scene.onBeforeRenderObservable.remove(obs);
        obs = null;
      }
    });
  }
}
