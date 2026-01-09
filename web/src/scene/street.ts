import {
  Scene,
  UniversalCamera,
  MeshBuilder,
  StandardMaterial,
  Texture,
  Color3,
  AbstractMesh,
  Vector3,
} from "@babylonjs/core";

import type { HouseWithModel, BrickTextureFile, Region } from "../world/houseModel/types";
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
  BOUNDARY_WALL_T,
  DOOR_OPENING_H,
} from "./constants";

type Rect = { x0: number; z0: number; x1: number; z1: number };

type Door = {
  kind: "door";
  aRegion: number;
  bRegion: number | null;
  hinge: [number, number];
  end: [number, number];
};

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

function getHouseRegionLocalBounds(h: HouseWithModel): { minZ: number; maxZ: number } | null {
  const hr = h.model.plot.regions.find((r) => r.name === "houseregion");
  if (!hr) return null;

  if (hr.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = hr.points;
    return { minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) };
  }

  if (hr.points.length < 3) return null;

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [, z] of hr.points) {
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (!isFinite(minZ) || !isFinite(maxZ)) return null;
  return { minZ, maxZ };
}

function asDoor(x: unknown): Door | null {
  const d = x as Partial<Door> | null | undefined;
  if (!d || d.kind !== "door") return null;
  if (typeof d.aRegion !== "number") return null;
  if (!(typeof d.bRegion === "number" || d.bRegion === null)) return null;
  if (!Array.isArray(d.hinge) || d.hinge.length !== 2) return null;
  if (!Array.isArray(d.end) || d.end.length !== 2) return null;
  if (typeof d.hinge[0] !== "number" || typeof d.hinge[1] !== "number") return null;
  if (typeof d.end[0] !== "number" || typeof d.end[1] !== "number") return null;
  return d as Door;
}

type Seg = { a: [number, number]; b: [number, number] };

function regionEdges(r: Region): Seg[] {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz);
    const maxZ = Math.max(az, bz);

    return [
      { a: [minX, minZ], b: [maxX, minZ] }, // back
      { a: [maxX, minZ], b: [maxX, maxZ] }, // right
      { a: [maxX, maxZ], b: [minX, maxZ] }, // front
      { a: [minX, maxZ], b: [minX, minZ] }, // left
    ];
  }

  const pts = r.points;
  const out: Seg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    out.push({ a: [a[0], a[1]], b: [b[0], b[1]] });
  }
  return out;
}

type Interval = { t0: number; t1: number };

function clampInterval(i: Interval, minT: number, maxT: number): Interval | null {
  const a = Math.max(minT, Math.min(maxT, i.t0));
  const b = Math.max(minT, Math.min(maxT, i.t1));
  const t0 = Math.min(a, b);
  const t1 = Math.max(a, b);
  if (t1 - t0 <= 1e-4) return null;
  return { t0, t1 };
}

function mergeIntervals(ints: Interval[]): Interval[] {
  if (ints.length === 0) return [];
  const s = [...ints].sort((a, b) => a.t0 - b.t0);
  const out: Interval[] = [];
  let cur = { ...s[0]! };

  for (let i = 1; i < s.length; i++) {
    const n = s[i]!;
    if (n.t0 <= cur.t1 + 1e-4) {
      cur.t1 = Math.max(cur.t1, n.t1);
    } else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

function createWallBox(
  scene: Scene,
  name: string,
  center: Vector3,
  size: { w: number; h: number; d: number },
  mat: StandardMaterial
): AbstractMesh {
  const m = MeshBuilder.CreateBox(name, { width: size.w, height: size.h, depth: size.d }, scene);
  m.position.copyFrom(center);
  m.material = mat;
  m.isPickable = false;
  m.checkCollisions = false;
  applyWorldBoxUVs(m, SURFACE_TEX_METERS);
  return m;
}

export interface RenderStreetOptions {
  onInteriorLoaded?: (houseNumber: number) => void;
}

export function renderStreet(
  scene: Scene,
  camera: UniversalCamera,
  houses: HouseWithModel[],
  opts: RenderStreetOptions = {}
) {
  const mats = surfaceMaterial(scene);
  const matsDouble = surfaceMaterial(scene, { doubleSided: true });

  // Road
  const road = MeshBuilder.CreateGround("road", { width: 230, height: 10 }, scene);
  road.position.x = 115;
  road.position.z = 35;
  road.material = mats.road;
  applyWorldUVs(road, SURFACE_TEX_METERS);
  road.checkCollisions = true;
  road.metadata = { rbs: { kind: "floor", layer: "road" } };

  renderCurbFaces(scene, houses, mats);

  // Street boundary walls (brick_dark.jpg)
  const streetBrickDarkMat = new StandardMaterial("street_brick_dark", scene);
  streetBrickDarkMat.diffuseTexture = new Texture("assets//textures/surfaces/brick_dark.jpg", scene);
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
  const placeholders = new Map<number, { lot: AbstractMesh; house?: AbstractMesh }>();

  // Entry-room preload meshes to dispose when full interior loads
  const entryPreloadMeshes = new Map<number, AbstractMesh[]>();

  for (const h of houses) {
    const lot = MeshBuilder.CreateGround(`lot_placeholder_${h.houseNumber}`, { width: h.bounds.xsize, height: h.bounds.zsize }, scene);
    lot.position.x = h.bounds.x + h.bounds.xsize / 2;
    lot.position.z = h.bounds.z + h.bounds.zsize / 2;
    lot.position.y = PLOT_Y;
    lot.material = mats.grass;
    applyWorldUVs(lot, SURFACE_TEX_METERS);
    lot.checkCollisions = true;
    lot.isPickable = false;
    lot.metadata = { rbs: { kind: "floor", layer: "plot_placeholder", houseNumber: h.houseNumber } };

    // A solid placeholder house box (so distant houses never become “empty” before exterior is rendered)
    const hr = h.model.plot.regions.find((r) => r.name === "houseregion");
    let houseBox: AbstractMesh | undefined;

    if (hr) {
      // Use the houseregion bounding box in world coords.
      const pts =
        hr.type === "polygon"
          ? hr.points
          : [hr.points[0], [hr.points[1][0], hr.points[0][1]], hr.points[1], [hr.points[0][0], hr.points[1][1]]];

      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [lx, lz] of pts) {
        const p = lotLocalToWorld(h, lx, lz);
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }

      const w = Math.max(0.01, maxX - minX);
      const d = Math.max(0.01, maxZ - minZ);
      const hgt = Math.max(0.01, CEILING_Y - PLOT_Y);

      const box = MeshBuilder.CreateBox(`house_placeholder_${h.houseNumber}`, { width: w, depth: d, height: hgt }, scene);
      box.position.x = minX + w / 2;
      box.position.z = minZ + d / 2;
      box.position.y = PLOT_Y + hgt / 2;

      box.material = streetBrickDarkMat;
      applyWorldBoxUVs(box, SURFACE_TEX_METERS);
      box.checkCollisions = true;
      box.isPickable = false;

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

  function clearEntryPreload(houseNumber: number) {
    const arr = entryPreloadMeshes.get(houseNumber);
    if (!arr) return;
    for (const m of arr) m.dispose();
    entryPreloadMeshes.delete(houseNumber);
  }

  // --- Streaming setup ---
  const SPAWN_HOUSE = 7;

  const INITIAL_EXTERIOR_RADIUS = 3;
  const INITIAL_INTERIOR_RADIUS = 0;

  // Full interior: proximity-based (unchanged from previous improvement)
  const INTERIOR_PREFETCH_DIST_M = 14;
  const MAX_INTERIOR_PREFETCH = 4;

  // Work slicing (keep it smooth on UHD 620)
  const FRAME_BUDGET_MS = 4;
  const MAX_JOBS_PER_FRAME = 1;

  const wallMat = matsDouble.wall;

  // Ceiling material (double-sided)
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
  const entryDone = new Set<number>();
  const interiorDone = new Set<number>();

  function notifyInteriorLoaded(houseNumber: number) {
    opts.onInteriorLoaded?.(houseNumber);
  }

  const plotQueued = new Set<number>();
  const exteriorQueued = new Set<number>();
  const interiorQueued = new Set<number>();

  const tasks: Array<() => void> = [];

  const brickMats = new Map<BrickTextureFile, StandardMaterial>();
  let roofMat: StandardMaterial | undefined;

  function renderHousePlot(house: HouseWithModel) {
    renderFloorLayer(scene, [house], mats, "plot", (h) => h.model.plot.regions, PLOT_Y, true);
    disablePlaceholderLot(house.houseNumber);
  }

  // Exterior only (no placeholder disable here; we disable only after entry-room preload exists too)
  function renderHouseExterior(house: HouseWithModel) {
    renderExteriorBrickPrisms(scene, [house], brickMats);
    roofMat = renderRoofs(scene, [house], roofMat);
  }

  function renderEntryRoomsForHouse(house: HouseWithModel) {
    const hn = house.houseNumber;
    if (entryDone.has(hn)) return;
    if (interiorDone.has(hn)) {
      entryDone.add(hn);
      return;
    }

    const bounds = getHouseRegionLocalBounds(house);
    const allDoors = house.model.firstFloor.construction.map(asDoor).filter((d): d is Door => !!d);
    const exteriorDoors = allDoors.filter((d) => d.bRegion === null);

    if (!bounds || exteriorDoors.length === 0) {
      entryDone.add(hn);
      return;
    }

    // Choose front-most and back-most exterior doors (lot-local Z extreme).
    // This is robust even if the footprint front edge isn't at z=30.
    const byMidZ = [...exteriorDoors].sort((a, b) => {
      const az = (a.hinge[1] + a.end[1]) * 0.5;
      const bz = (b.hinge[1] + b.end[1]) * 0.5;
      return az - bz;
    });

    const backDoor = byMidZ[0]!;
    const frontDoor = byMidZ[byMidZ.length - 1]!;

    // If there is effectively only one exterior door, preload just that one room.
    const backMid = (backDoor.hinge[1] + backDoor.end[1]) * 0.5;
    const frontMid = (frontDoor.hinge[1] + frontDoor.end[1]) * 0.5;
    const distinct = Math.abs(frontMid - backMid) > 0.5;

    const roomDoors = new Map<number, Door[]>();
    roomDoors.set(frontDoor.aRegion, [frontDoor]);
    if (distinct) {
      roomDoors.set(backDoor.aRegion, [backDoor]);
    }

    const created: AbstractMesh[] = [];

    for (const [regionIdx, doorsForRoom] of roomDoors.entries()) {
      const region = house.model.firstFloor.regions[regionIdx];
      if (!region) continue;
      if (region.surface === "void") continue;

      // Floor (first floor) for that room only
      const floorTag = `ff_entry_${hn}_${regionIdx}`;
      renderFloorLayer(scene, [house], mats, floorTag, () => [region], FIRST_FLOOR_Y, false);

      const floorName = `region_${floorTag}_${hn}_${region.name}`;
      const floorMesh = scene.getMeshByName(floorName) as AbstractMesh | null;
      if (floorMesh) {
        floorMesh.isPickable = false;
        floorMesh.checkCollisions = false;
        created.push(floorMesh);
      }

      // Ceiling above that room (first-floor ceiling plane)
      const ceilTag = `ff_entry_ceiling_${hn}_${regionIdx}`;
      renderCeilingLayer(
        scene,
        [house],
        ceilingMat,
        ceilTag,
        () => [region],
        SECOND_FLOOR_Y - INTER_FLOOR_CEILING_EPS
      );

      const ceilName = `region_${ceilTag}_${hn}_${region.name}`;
      const ceilMesh = scene.getMeshByName(ceilName) as AbstractMesh | null;
      if (ceilMesh) {
        ceilMesh.isPickable = false;
        ceilMesh.checkCollisions = false;
        created.push(ceilMesh);
      }

      // Simple perimeter walls around the room, carving ONLY the exterior door openings we chose.
      const edges = regionEdges(region);

      const wallStartY = PLOT_Y;
      const wallEndY = SECOND_FLOOR_Y;
      const wallHeight = wallEndY - wallStartY;
      const wallCenterY = wallStartY + wallHeight / 2;

      const eps = 1e-4;

      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei]!;
        const [ax, az] = e.a;
        const [bx, bz] = e.b;

        const horiz = Math.abs(az - bz) < eps;
        const vert = Math.abs(ax - bx) < eps;
        if (!horiz && !vert) continue;

        if (horiz) {
          const z = az;
          const x0 = Math.min(ax, bx);
          const x1 = Math.max(ax, bx);

          // door intervals along X on this edge
          const doorIntervals: Interval[] = [];

          for (const d of doorsForRoom) {
            const dd = asDoor(d);
            if (!dd) continue;
            // door on horizontal edge => hingeZ == endZ == z
            if (Math.abs(dd.hinge[1] - dd.end[1]) > eps) continue;
            if (Math.abs(dd.hinge[1] - z) > 0.02) continue;

            const dx0 = Math.min(dd.hinge[0], dd.end[0]);
            const dx1 = Math.max(dd.hinge[0], dd.end[0]);
            const cl = clampInterval({ t0: dx0, t1: dx1 }, x0, x1);
            if (cl) doorIntervals.push(cl);
          }

          const merged = mergeIntervals(doorIntervals);

          // Build wall segments between intervals
          let cur = x0;

          for (const it of merged) {
            const s0 = cur;
            const s1 = it.t0;
            if (s1 - s0 > 0.05) {
              const cx = (s0 + s1) / 2;
              const p = lotLocalToWorld(house, cx, z);
              created.push(
                createWallBox(
                  scene,
                  `rbs_entry_wall_h_${hn}_${regionIdx}_${ei}_${s0.toFixed(3)}`,
                  new Vector3(p.x, wallCenterY, p.z),
                  { w: s1 - s0, h: wallHeight, d: BOUNDARY_WALL_T },
                  wallMat
                )
              );
            }

            // Lintel above door opening (so it doesn't become a full-height hole)
            const doorBottomY = wallStartY;
            const doorTopY = doorBottomY + DOOR_OPENING_H;
            const lintelH = wallEndY - doorTopY;
            if (lintelH > 0.02) {
              const cx = (it.t0 + it.t1) / 2;
              const p = lotLocalToWorld(house, cx, z);
              const lintelCenterY = doorTopY + lintelH / 2;
              created.push(
                createWallBox(
                  scene,
                  `rbs_entry_lintel_h_${hn}_${regionIdx}_${ei}_${it.t0.toFixed(3)}`,
                  new Vector3(p.x, lintelCenterY, p.z),
                  { w: it.t1 - it.t0, h: lintelH, d: BOUNDARY_WALL_T },
                  wallMat
                )
              );
            }

            cur = it.t1;
          }

          // trailing segment
          if (x1 - cur > 0.05) {
            const cx = (cur + x1) / 2;
            const p = lotLocalToWorld(house, cx, z);
            created.push(
              createWallBox(
                scene,
                `rbs_entry_wall_h_${hn}_${regionIdx}_${ei}_${cur.toFixed(3)}_tail`,
                new Vector3(p.x, wallCenterY, p.z),
                { w: x1 - cur, h: wallHeight, d: BOUNDARY_WALL_T },
                wallMat
              )
            );
          }
        } else if (vert) {
          const x = ax;
          const z0 = Math.min(az, bz);
          const z1 = Math.max(az, bz);

          // door intervals along Z on this edge
          const doorIntervals: Interval[] = [];

          for (const d of doorsForRoom) {
            const dd = asDoor(d);
            if (!dd) continue;
            // door on vertical edge => hingeX == endX == x
            if (Math.abs(dd.hinge[0] - dd.end[0]) > eps) continue;
            if (Math.abs(dd.hinge[0] - x) > 0.02) continue;

            const dz0 = Math.min(dd.hinge[1], dd.end[1]);
            const dz1 = Math.max(dd.hinge[1], dd.end[1]);
            const cl = clampInterval({ t0: dz0, t1: dz1 }, z0, z1);
            if (cl) doorIntervals.push(cl);
          }

          const merged = mergeIntervals(doorIntervals);

          let cur = z0;

          for (const it of merged) {
            const s0 = cur;
            const s1 = it.t0;
            if (s1 - s0 > 0.05) {
              const cz = (s0 + s1) / 2;
              const p = lotLocalToWorld(house, x, cz);
              created.push(
                createWallBox(
                  scene,
                  `rbs_entry_wall_v_${hn}_${regionIdx}_${ei}_${s0.toFixed(3)}`,
                  new Vector3(p.x, wallCenterY, p.z),
                  { w: BOUNDARY_WALL_T, h: wallHeight, d: s1 - s0 },
                  wallMat
                )
              );
            }

            const doorBottomY = wallStartY;
            const doorTopY = doorBottomY + DOOR_OPENING_H;
            const lintelH = wallEndY - doorTopY;
            if (lintelH > 0.02) {
              const cz = (it.t0 + it.t1) / 2;
              const p = lotLocalToWorld(house, x, cz);
              const lintelCenterY = doorTopY + lintelH / 2;
              created.push(
                createWallBox(
                  scene,
                  `rbs_entry_lintel_v_${hn}_${regionIdx}_${ei}_${it.t0.toFixed(3)}`,
                  new Vector3(p.x, lintelCenterY, p.z),
                  { w: BOUNDARY_WALL_T, h: lintelH, d: it.t1 - it.t0 },
                  wallMat
                )
              );
            }

            cur = it.t1;
          }

          if (z1 - cur > 0.05) {
            const cz = (cur + z1) / 2;
            const p = lotLocalToWorld(house, x, cz);
            created.push(
              createWallBox(
                scene,
                `rbs_entry_wall_v_${hn}_${regionIdx}_${ei}_${cur.toFixed(3)}_tail`,
                new Vector3(p.x, wallCenterY, p.z),
                { w: BOUNDARY_WALL_T, h: wallHeight, d: z1 - cur },
                wallMat
              )
            );
          }
        }
      }
    }

    if (created.length > 0) entryPreloadMeshes.set(hn, created);

    entryDone.add(hn);
  }

  function renderHouseFirstFloorFull(house: HouseWithModel) {
    // Remove entry-room preload to avoid z-fighting once the real interior appears.
    clearEntryPreload(house.houseNumber);

    // First-floor surfaces
    renderFloorLayer(scene, [house], mats, "firstFloor", (h) => h.model.firstFloor.regions, FIRST_FLOOR_Y, true);

    // First-floor walls + door openings
    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.firstFloor.regions,
      (h) => h.model.firstFloor.construction,
      PLOT_Y,          // walls start at plot level (prevents "floating")
      SECOND_FLOOR_Y,  // walls end at second-floor level
      PLOT_Y,          // door openings start at plot level
      FIRST_FLOOR_Y,   // sill/threshold sits at real first-floor height
      "ff",
      wallMat
    );

    // Stairs (full interior only)
    renderStairs(scene, [house], matsDouble as unknown as Record<string, StandardMaterial>);

    // First-floor ceiling (exclude stairs so stairwell is open upward)
    renderCeilingLayer(
      scene,
      [house],
      ceilingMat,
      "firstCeiling",
      (h) => h.model.firstFloor.regions.filter((r) => r.name !== "stairs"),
      SECOND_FLOOR_Y - INTER_FLOOR_CEILING_EPS
    );
  }

  function renderHouseSecondFloorFull(house: HouseWithModel) {
    // Second-floor surfaces
    renderFloorLayer(scene, [house], matsDouble, "secondFloor", (h) => h.model.secondFloor.regions, SECOND_FLOOR_Y, true);

    // Second-floor walls + door openings
    renderBoundaryWallsForLayer(
      scene,
      [house],
      (h) => h.model.secondFloor.regions,
      (h) => h.model.secondFloor.construction,
      SECOND_FLOOR_Y,  // walls start at second-floor level
      CEILING_Y,       // walls end at ceiling level
      SECOND_FLOOR_Y,  // door openings start at second-floor level
      SECOND_FLOOR_Y,  // sill/threshold at second-floor height
      "sf",
      wallMat
    );

    // Second-floor ceiling (include void so stairwell is capped)
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

  // Exterior job ALSO builds the two entry rooms BEFORE disabling the placeholder house.
  // This prevents any moment where door openings show an empty void inside.
  function queueExteriorAndEntryRooms(house: HouseWithModel, priority: boolean) {
    const n = house.houseNumber;
    if (exteriorDone.has(n) || exteriorQueued.has(n)) return;

    exteriorQueued.add(n);

    const job = () => {
      if (!exteriorDone.has(n)) {
        renderHouseExterior(house);
        exteriorDone.add(n);
      }

      // Ensure the door-connected rooms exist behind the exterior before we reveal the real exterior.
      renderEntryRoomsForHouse(house);

      // Now it's safe to reveal the real exterior (with door openings).
      disablePlaceholderHouse(n);

      exteriorQueued.delete(n);
    };

    if (priority) tasks.unshift(job);
    else tasks.push(job);
  }

  function queueInterior(house: HouseWithModel) {
    const n = house.houseNumber;
    if (interiorDone.has(n) || interiorQueued.has(n)) return;

    interiorQueued.add(n);

    // Ensure plot + exterior are prioritized for a near-interior house.
    if (!plotDone.has(n)) queuePlot(house, true);
    if (!exteriorDone.has(n)) queueExteriorAndEntryRooms(house, true);

    const jobSecond = () => {
      if (interiorDone.has(n)) {
        interiorQueued.delete(n);
        return;
      }
      renderHouseSecondFloorFull(house);
      interiorDone.add(n);
      notifyInteriorLoaded(n);
      interiorQueued.delete(n);
    };

    const jobFirst = () => {
      if (interiorDone.has(n)) return;
      renderHouseFirstFloorFull(house);
    };

    tasks.unshift(jobSecond);
    tasks.unshift(jobFirst);
  }

  // --- Hard preload: SPAWN_HOUSE must be fully ready before the first frame ---
  const spawnHouse = houses.find((h) => h.houseNumber === SPAWN_HOUSE);
  if (spawnHouse) {
    // Plot (disables plot placeholder lot)
    if (!plotDone.has(SPAWN_HOUSE)) {
      renderHousePlot(spawnHouse);
      plotDone.add(SPAWN_HOUSE);
    }

    // Exterior (do NOT rely on queued jobs)
    if (!exteriorDone.has(SPAWN_HOUSE)) {
      renderHouseExterior(spawnHouse);
      exteriorDone.add(SPAWN_HOUSE);
    }

    // Full interior (first + second floors, walls, ceilings, stairs)
    // Full interior makes the "entry room preload" unnecessary for spawn.
    entryDone.add(SPAWN_HOUSE);

    renderHouseFirstFloorFull(spawnHouse);
    renderHouseSecondFloorFull(spawnHouse);

    interiorDone.add(SPAWN_HOUSE);
    notifyInteriorLoaded(SPAWN_HOUSE);

    // Now reveal the real house meshes (safe: interior already exists)
    disablePlaceholderHouse(SPAWN_HOUSE);
  }

  // --- Immediate render near spawn (other houses can still stream) ---
  for (const h of housesByPriority) {
    if (Math.abs(h.houseNumber - SPAWN_HOUSE) <= INITIAL_EXTERIOR_RADIUS) {
      queuePlot(h, true);
      queueExteriorAndEntryRooms(h, true);
    }
  }

  for (const h of housesByPriority) {
    if (Math.abs(h.houseNumber - SPAWN_HOUSE) <= INITIAL_INTERIOR_RADIUS) {
      queueInterior(h);
    }
  }

  // --- Low-priority: detail the whole street exterior + entry rooms (placeholders prevent invisibility) ---
  for (const h of housesByPriority) {
    queuePlot(h, false);
    queueExteriorAndEntryRooms(h, false);
  }

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
