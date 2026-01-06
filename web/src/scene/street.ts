import {
  Scene,
  UniversalCamera,
  MeshBuilder,
  StandardMaterial,
  Texture,
  Color3,
  AbstractMesh,
} from "@babylonjs/core";

import type { HouseWithModel, BrickTextureFile } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { surfaceMaterial } from "./materials";
import { applyWorldUVs, applyWorldBoxUVs } from "./uvs";
import { renderFloorLayer, renderCeilingLayer } from "./regions";
import { renderCurbFaces } from "./curb";
import { renderBoundaryWallsForLayer } from "./boundaryWalls";
import { renderExteriorBrickPrisms } from "./exteriorBrick";
import { renderRoofs } from "./roof";
import { renderStairs } from "./stairs";
import {
  SURFACE_TEX_METERS,
  PLOT_Y,
  FIRST_FLOOR_Y,
  SECOND_FLOOR_Y,
  CEILING_Y,
  INTER_FLOOR_CEILING_EPS,
} from "./constants";

type Rect = { x0: number; z0: number; x1: number; z1: number };

function distPointToRectXZ(px: number, pz: number, r: Rect): number {
  const dx = px < r.x0 ? r.x0 - px : px > r.x1 ? px - r.x1 : 0;
  const dz = pz < r.z0 ? r.z0 - pz : pz > r.z1 ? pz - r.z1 : 0;
  return Math.hypot(dx, dz);
}

function houseLotRect(h: HouseWithModel): Rect {
  return {
    x0: h.bounds.x,
    z0: h.bounds.z,
    x1: h.bounds.x + h.bounds.xsize,
    z1: h.bounds.z + h.bounds.zsize,
  };
}

function houseFootprintRectWorld(h: HouseWithModel): Rect | null {
  const hr = h.model.plot.regions.find((r) => r.name === "houseregion");
  if (!hr) return null;

  // Polygon footprint is expected, but handle rectangle defensively.
  const pts =
    hr.type === "polygon"
      ? hr.points
      : [hr.points[0], [hr.points[1][0], hr.points[0][1]], hr.points[1], [hr.points[0][0], hr.points[1][1]]];

  if (pts.length < 3) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const [lx, lz] of pts) {
    const p = lotLocalToWorld(h, lx, lz);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  // Tiny safety clamp so we never build degenerate boxes.
  if (!isFinite(minX) || !isFinite(minZ) || maxX - minX < 0.01 || maxZ - minZ < 0.01) return null;

  return { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
}

export function renderStreet(scene: Scene, camera: UniversalCamera, houses: HouseWithModel[]) {
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

  // --- Always-visible placeholders (prevents invisible ground/buildings) ---
  // These are cheap and get disabled per-house once the detailed meshes exist.
  const placeholders = new Map<number, { lot: AbstractMesh; house?: AbstractMesh }>();

  for (const h of houses) {
    // Placeholder lot ground: 1 mesh per house (always visible, collidable).
    const lot = MeshBuilder.CreateGround(`lot_placeholder_${h.houseNumber}`, { width: h.bounds.xsize, height: h.bounds.zsize }, scene);
    lot.position.x = h.bounds.x + h.bounds.xsize / 2;
    lot.position.z = h.bounds.z + h.bounds.zsize / 2;
    lot.position.y = PLOT_Y;
    lot.material = mats.grass;
    applyWorldUVs(lot, SURFACE_TEX_METERS);
    lot.checkCollisions = true;
    lot.metadata = { rbs: { kind: "floor", layer: "plot_placeholder", houseNumber: h.houseNumber } };

    // Placeholder building: axis-aligned box from the houseregion footprint bounding box (cheap, visible).
    const fr = houseFootprintRectWorld(h);
    let houseBox: AbstractMesh | undefined;

    if (fr) {
      const w = Math.max(0.01, fr.x1 - fr.x0);
      const d = Math.max(0.01, fr.z1 - fr.z0);
      const hgt = Math.max(0.01, CEILING_Y - PLOT_Y);

      const box = MeshBuilder.CreateBox(`house_placeholder_${h.houseNumber}`, { width: w, depth: d, height: hgt }, scene);
      box.position.x = fr.x0 + w / 2;
      box.position.z = fr.z0 + d / 2;
      box.position.y = PLOT_Y + hgt / 2;

      box.material = streetBrickDarkMat;
      applyWorldBoxUVs(box, SURFACE_TEX_METERS);
      box.checkCollisions = true;

      houseBox = box;
    }

    placeholders.set(h.houseNumber, { lot, house: houseBox });
  }

  function disablePlaceholderLot(houseNumber: number) {
    const p = placeholders.get(houseNumber);
    if (p?.lot) p.lot.setEnabled(false);
  }

  function disablePlaceholderHouse(houseNumber: number) {
    const p = placeholders.get(houseNumber);
    if (p?.house) p.house.setEnabled(false);
  }

  // --- Streaming setup ---
  const SPAWN_HOUSE = 7;

  // What we render immediately (so the player never sees "nothing" near spawn).
  const INITIAL_EXTERIOR_RADIUS = 3; // houses 4..10 get plot+exterior immediately
  const INITIAL_INTERIOR_RADIUS = 0; // only house 7 gets interior immediately

  // Interiors: generated lazily only when the player is near a house lot.
  const INTERIOR_PREFETCH_DIST_M = 14; // start building interior before the player reaches the door
  const MAX_INTERIOR_PREFETCH = 4; // cap how many houses we prefetch at once

  // Keep background work small (prevents startup 1–2 FPS).
  const FRAME_BUDGET_MS = 4;
  const MAX_JOBS_PER_FRAME = 2;

  const wallMat = matsDouble.wall;

  const ceilingMat = new StandardMaterial("ceiling_mat", scene);
  ceilingMat.diffuseTexture = wallMat.diffuseTexture;
  ceilingMat.backFaceCulling = false;
  ceilingMat.diffuseColor = new Color3(0.92, 0.92, 0.92);
  ceilingMat.specularColor = new Color3(0.03, 0.03, 0.03);

  const housesByPriority = [...houses].sort((a, b) => {
    const da = Math.abs(a.houseNumber - SPAWN_HOUSE);
    const db = Math.abs(b.houseNumber - SPAWN_HOUSE);
    if (da !== db) return da - db;
    return a.houseNumber - b.houseNumber;
  });

  const plotDone = new Set<number>();
  const exteriorDone = new Set<number>();
  const interiorDone = new Set<number>();

  const plotQueued = new Set<number>();
  const exteriorQueued = new Set<number>();
  const interiorQueued = new Set<number>();

  const tasks: Array<() => void> = [];

  // Caches so streaming does NOT recreate textures/materials repeatedly.
  const brickMats = new Map<BrickTextureFile, StandardMaterial>();
  let roofMat: StandardMaterial | undefined;

  function renderHousePlot(house: HouseWithModel) {
    renderFloorLayer(scene, [house], mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
    disablePlaceholderLot(house.houseNumber);
  }

  function renderHouseExterior(house: HouseWithModel) {
    renderExteriorBrickPrisms(scene, [house], brickMats);
    roofMat = renderRoofs(scene, [house], roofMat);
    disablePlaceholderHouse(house.houseNumber);
  }

  function renderHouseFirstFloor(house: HouseWithModel) {
    renderFloorLayer(scene, [house], mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.firstFloor.regions,
      (h) => h.model.firstFloor.construction,
      PLOT_Y,
      SECOND_FLOOR_Y,
      PLOT_Y,
      FIRST_FLOOR_Y,
      "ff",
      wallMat
    );

    renderStairs(scene, [house], matsDouble as unknown as Record<string, StandardMaterial>);

    renderCeilingLayer(
      scene,
      [house],
      ceilingMat,
      "firstCeiling",
      (h) => h.model.firstFloor.regions.filter((r) => r.name !== "stairs"),
      SECOND_FLOOR_Y - INTER_FLOOR_CEILING_EPS
    );
  }

  function renderHouseSecondFloor(house: HouseWithModel) {
    renderFloorLayer(scene, [house], matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, true);

    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.secondFloor.regions,
      (h) => h.model.secondFloor.construction,
      SECOND_FLOOR_Y,
      CEILING_Y,
      SECOND_FLOOR_Y,
      SECOND_FLOOR_Y,
      "sf",
      wallMat
    );

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

  function queuePlot(house: HouseWithModel, priority: boolean) {
    const n = house.houseNumber;
    if (plotDone.has(n) || plotQueued.has(n)) return;

    plotQueued.add(n);

    const job = () => {
      if (plotDone.has(n)) {
        plotQueued.delete(n);
        return;
      }
      renderHousePlot(house);
      plotDone.add(n);
      plotQueued.delete(n);
    };

    if (priority) tasks.unshift(job);
    else tasks.push(job);
  }

  function queueExterior(house: HouseWithModel, priority: boolean) {
    const n = house.houseNumber;
    if (exteriorDone.has(n) || exteriorQueued.has(n)) return;

    exteriorQueued.add(n);

    const job = () => {
      if (exteriorDone.has(n)) {
        exteriorQueued.delete(n);
        return;
      }
      renderHouseExterior(house);
      exteriorDone.add(n);
      exteriorQueued.delete(n);
    };

    if (priority) tasks.unshift(job);
    else tasks.push(job);
  }

  function queueInterior(house: HouseWithModel) {
    const n = house.houseNumber;
    if (interiorDone.has(n) || interiorQueued.has(n)) return;

    interiorQueued.add(n);

    // We want ordering: plot -> exterior -> firstFloor -> secondFloor.
    // Using unshift, we add in reverse.
    if (!plotDone.has(n)) queuePlot(house, true);
    if (!exteriorDone.has(n)) queueExterior(house, true);

    const jobSecond = () => {
      if (interiorDone.has(n)) {
        interiorQueued.delete(n);
        return;
      }
      renderHouseSecondFloor(house);
      interiorDone.add(n);
      interiorQueued.delete(n);
    };

    const jobFirst = () => {
      if (interiorDone.has(n)) return;
      renderHouseFirstFloor(house);
    };

    tasks.unshift(jobSecond);
    tasks.unshift(jobFirst);
  }

  // --- Immediate render near spawn (detail replaces placeholders) ---
  for (const h of housesByPriority) {
    if (Math.abs(h.houseNumber - SPAWN_HOUSE) <= INITIAL_EXTERIOR_RADIUS) {
      queuePlot(h, true);
      queueExterior(h, true);
    }
  }

  for (const h of housesByPriority) {
    if (Math.abs(h.houseNumber - SPAWN_HOUSE) <= INITIAL_INTERIOR_RADIUS) {
      queueInterior(h);
    }
  }

  // --- Low-priority: eventually detail the whole street exterior/plot (placeholders prevent invisibility meanwhile) ---
  for (const h of housesByPriority) {
    queuePlot(h, false);
    queueExterior(h, false);
  }

  // --- Runtime: prefetch interiors based on player proximity ---
  function prefetchNearbyInteriors() {
    const px = camera.position.x;
    const pz = camera.position.z;

    const nearby = houses
      .map((h) => ({ h, d: distPointToRectXZ(px, pz, houseLotRect(h)) }))
      .filter((x) => x.d <= INTERIOR_PREFETCH_DIST_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_INTERIOR_PREFETCH);

    for (const { h } of nearby) {
      queueInterior(h);
    }
  }

  // --- Background job runner (small slices per frame to keep FPS stable) ---
  scene.onBeforeRenderObservable.add(() => {
    prefetchNearbyInteriors();

    const t0 = performance.now();
    let ran = 0;

    while (tasks.length > 0 && ran < MAX_JOBS_PER_FRAME && performance.now() - t0 < FRAME_BUDGET_MS) {
      const job = tasks.shift();
      if (!job) break;
      job();
      ran++;
    }
  });
}
