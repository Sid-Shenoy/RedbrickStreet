import "@babylonjs/loaders/glTF";

import { AssetContainer, Scene, SceneLoader, TransformNode } from "@babylonjs/core";

import type { HouseWithModel, Region } from "../houseModel/types";
import { lotLocalToWorld } from "../houseModel/lotTransform";
import { FIRST_FLOOR_Y } from "../../scene/constants";

// Tweakable constants (per requirements)
export const ZOMBIE_COUNT = 50;
export const MIN_ZOMBIE_SPAWN_DIST_M = 30;

type Candidate = {
  house: HouseWithModel;
  region: Region;
  area: number;
};

type ZombiePlan = {
  houseNumber: number;
  localX: number;
  localZ: number;
  rotY: number;
};

export interface ZombieHouseStreamer {
  ensureHouse(houseNumber: number): void;
  dispose(): void;
}

export async function preloadZombieAssets(scene: Scene): Promise<AssetContainer> {
  return SceneLoader.LoadAssetContainerAsync("/assets/models/", "zombie.glb", scene);
}

/**
 * Plans ZOMBIE_COUNT spawns across all houses (area-weighted), but only instantiates zombies for a house
 * when ensureHouse(houseNumber) is called (typically when that house interior is streamed in).
 */
export function createZombieHouseStreamer(
  scene: Scene,
  houses: HouseWithModel[],
  playerStartXZ: { x: number; z: number },
  zombieAssets: AssetContainer
): ZombieHouseStreamer {
  const candidates = buildCandidates(houses);
  if (candidates.length === 0) {
    throw new Error("createZombieHouseStreamer: no first-floor spawn regions found");
  }

  const totalArea = candidates.reduce((sum, c) => sum + c.area, 0);
  if (totalArea <= 0) {
    throw new Error("createZombieHouseStreamer: spawn regions have zero total area");
  }

  const houseByNumber = new Map<number, HouseWithModel>();
  for (const h of houses) houseByNumber.set(h.houseNumber, h);

  // Plan spawns up-front, but group them per house.
  const planByHouse = new Map<number, ZombiePlan[]>();

  for (let i = 0; i < ZOMBIE_COUNT; i++) {
    const plan = planOneZombie(candidates, totalArea, playerStartXZ);
    if (!plan) {
      throw new Error(
        `createZombieHouseStreamer: failed to plan zombie ${i} with minDist=${MIN_ZOMBIE_SPAWN_DIST_M}m`
      );
    }

    const arr = planByHouse.get(plan.houseNumber) ?? [];
    arr.push(plan);
    planByHouse.set(plan.houseNumber, arr);
  }

  const spawnedHouses = new Set<number>();
  const roots: TransformNode[] = [];

  function ensureHouse(houseNumber: number) {
    if (spawnedHouses.has(houseNumber)) return;
    spawnedHouses.add(houseNumber);

    const plans = planByHouse.get(houseNumber);
    if (!plans || plans.length === 0) return;

    const house = houseByNumber.get(houseNumber);
    if (!house) return;

    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      const inst = zombieAssets.instantiateModelsToScene();

      const root = new TransformNode(`rbs_zombie_h${houseNumber}_${i}`, scene);
      for (const n of inst.rootNodes) n.parent = root;

      const world = lotLocalToWorld(house, p.localX, p.localZ);
      root.position.set(world.x, FIRST_FLOOR_Y, world.z);
      root.rotation.y = p.rotY;

      // Disable collisions + picking for all meshes in this instance.
      for (const m of root.getChildMeshes(false)) {
        m.checkCollisions = false;
        m.isPickable = false;
      }

      roots.push(root);
    }
  }

  function dispose() {
    for (const r of roots) r.dispose();
    roots.length = 0;
    spawnedHouses.clear();
    planByHouse.clear();
  }

  scene.onDisposeObservable.add(() => dispose());

  return { ensureHouse, dispose };
}

function buildCandidates(houses: HouseWithModel[]): Candidate[] {
  const out: Candidate[] = [];

  for (const house of houses) {
    for (const region of house.model.firstFloor.regions) {
      if (region.name === "stairs") continue;
      if (region.surface === "void") continue;

      const area = regionArea(region);
      if (area <= 0) continue;

      out.push({ house, region, area });
    }
  }

  return out;
}

function planOneZombie(
  candidates: Candidate[],
  totalArea: number,
  playerStartXZ: { x: number; z: number }
): ZombiePlan | null {
  const MAX_ATTEMPTS = 800;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cand = weightedPick(candidates, totalArea);
    const [lx, lz] = randomPointInRegion(cand.region);

    const world = lotLocalToWorld(cand.house, lx, lz);

    const dx = world.x - playerStartXZ.x;
    const dz = world.z - playerStartXZ.z;
    if (Math.hypot(dx, dz) < MIN_ZOMBIE_SPAWN_DIST_M) continue;

    return {
      houseNumber: cand.house.houseNumber,
      localX: lx,
      localZ: lz,
      rotY: Math.random() * Math.PI * 2,
    };
  }

  return null;
}

function regionArea(region: Region): number {
  if (region.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = region.points;
    return Math.abs(x1 - x0) * Math.abs(z1 - z0);
  }

  // polygon area in XZ via shoelace
  const pts = region.points;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i]!;
    const [x1, z1] = pts[(i + 1) % pts.length]!;
    sum += x0 * z1 - x1 * z0;
  }
  return Math.abs(sum) * 0.5;
}

function weightedPick(candidates: Candidate[], totalArea: number): Candidate {
  let t = Math.random() * totalArea;
  for (const c of candidates) {
    t -= c.area;
    if (t <= 0) return c;
  }
  return candidates[candidates.length - 1]!;
}

function randomPointInRegion(region: Region): [number, number] {
  if (region.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = region.points;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    return [minX + Math.random() * (maxX - minX), minZ + Math.random() * (maxZ - minZ)];
  }

  const pts = region.points;

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;

  for (const [x, z] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  const MAX_TRIES = 300;
  for (let i = 0; i < MAX_TRIES; i++) {
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    if (pointInPolygon(x, z, pts)) return [x, z];
  }

  return pts[0]!;
}

function pointInPolygon(px: number, pz: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]!;
    const [xj, zj] = pts[j]!;
    const intersects = (zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
