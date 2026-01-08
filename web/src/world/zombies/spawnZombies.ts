import "@babylonjs/loaders/glTF";

import {
  AssetContainer,
  Scene,
  SceneLoader,
  TransformNode,
  type AnimationGroup,
  type Observer,
} from "@babylonjs/core";

import type { HouseWithModel, Region } from "../houseModel/types";
import { lotLocalToWorld } from "../houseModel/lotTransform";
import { FIRST_FLOOR_Y } from "../../scene/constants";

// Tweakable constants (per requirements)
export const ZOMBIE_COUNT = 25;
export const MIN_ZOMBIE_SPAWN_DIST_M = 30;

// Zombie AI distance thresholds (per requirements)
export const ZOMBIE_AI_FOLLOW_DIST_M = 20;
export const ZOMBIE_AI_ATTACK_DIST_M = 1;

// Player damage while being attacked (new)
export const ZOMBIE_AI_HIT_DAMAGE = 8;          // health per hit
export const ZOMBIE_AI_HIT_COOLDOWN_S = 0.9;    // seconds between hits per zombie while attacking

// Internal tuning (not part of config yet)
const ZOMBIE_WALK_SPEED_MPS = 1.6;

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

type ZombieState = "idle" | "walk" | "attack";

type ZombieInstance = {
  root: TransformNode;
  walkAnim: AnimationGroup | null;
  attackAnim: AnimationGroup | null;
  state: ZombieState;
  hitCooldownS: number;
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
 *
 * Also runs lightweight AI:
 * - if XZ dist > ZOMBIE_AI_FOLLOW_DIST_M => idle, no animation, no movement
 * - if ZOMBIE_AI_ATTACK_DIST_M < dist <= ZOMBIE_AI_FOLLOW_DIST_M => walk toward player + walk anim
 * - if dist <= ZOMBIE_AI_ATTACK_DIST_M => attack anim, no movement
 *
 * While attacking, zombies damage the player via onPlayerDamaged (if provided),
 * at most once every ZOMBIE_AI_HIT_COOLDOWN_S seconds per zombie.
 *
 * Zombies do not use collision-based movement (can pass through walls),
 * and are clamped to FIRST_FLOOR_Y (cannot climb stairs).
 */
export function createZombieHouseStreamer(
  scene: Scene,
  houses: HouseWithModel[],
  playerStartXZ: { x: number; z: number },
  zombieAssets: AssetContainer,
  getPlayerXZ: () => { x: number; z: number },
  onPlayerDamaged?: (damage: number) => void
): ZombieHouseStreamer {
  const damageCb = onPlayerDamaged ?? (() => {});

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
  const zombies: ZombieInstance[] = [];

  function setZombieState(z: ZombieInstance, next: ZombieState) {
    if (z.state === next) return;

    // Stop all animations first to enforce the "far = no animation" rule.
    z.walkAnim?.stop();
    z.attackAnim?.stop();

    if (next === "walk") {
      z.walkAnim?.start(true, 1.0);
    } else if (next === "attack") {
      z.attackAnim?.start(true, 1.0);
    }

    z.state = next;
  }

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

      // Animation mapping based on `/public/assets/models/requirements.txt`:
      // 0: Attack, 1: Reel back, 2: Die, 3: Jog forward
      const attackAnim = inst.animationGroups?.[0] ?? null;
      const walkAnim = inst.animationGroups?.[3] ?? null;

      // Start in idle (no animation playing).
      attackAnim?.stop();
      walkAnim?.stop();

      zombies.push({ root, walkAnim, attackAnim, state: "idle", hitCooldownS: 0 });
      roots.push(root);
    }
  }

  const aiObserver: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    const p = getPlayerXZ();

    for (const z of zombies) {
      // Cooldown tick (always counts down).
      z.hitCooldownS = Math.max(0, z.hitCooldownS - dt);

      const zx = z.root.position.x;
      const zz = z.root.position.z;

      const dx = p.x - zx;
      const dz = p.z - zz;

      const dist = Math.hypot(dx, dz);

      // Clamp Y so zombies cannot climb stairs.
      if (z.root.position.y !== FIRST_FLOOR_Y) z.root.position.y = FIRST_FLOOR_Y;

      if (dist <= ZOMBIE_AI_ATTACK_DIST_M) {
        setZombieState(z, "attack");

        // Damage the player at a fixed cadence while attacking.
        if (z.hitCooldownS <= 1e-6) {
          damageCb(ZOMBIE_AI_HIT_DAMAGE);
          z.hitCooldownS = ZOMBIE_AI_HIT_COOLDOWN_S;
        }

        // Face the player while attacking.
        z.root.rotation.y = Math.atan2(dx, dz);
        continue;
      }

      if (dist <= ZOMBIE_AI_FOLLOW_DIST_M) {
        setZombieState(z, "walk");

        // Move toward player (XZ only; no collisions so they can pass through walls).
        if (dist > 1e-6) {
          const step = Math.min(dist, ZOMBIE_WALK_SPEED_MPS * dt);
          z.root.position.x = zx + (dx / dist) * step;
          z.root.position.z = zz + (dz / dist) * step;

          // Face travel direction (toward player).
          z.root.rotation.y = Math.atan2(dx, dz);

          // Re-clamp Y after movement.
          z.root.position.y = FIRST_FLOOR_Y;
        }

        continue;
      }

      // Far away: idle, no animation (performance rule).
      setZombieState(z, "idle");
    }
  });

  function dispose() {
    scene.onBeforeRenderObservable.remove(aiObserver);

    // Stop + dispose all zombie animation groups we created via instantiation.
    for (const z of zombies) {
      z.walkAnim?.stop();
      z.attackAnim?.stop();
      z.walkAnim?.dispose();
      z.attackAnim?.dispose();
    }
    zombies.length = 0;

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
