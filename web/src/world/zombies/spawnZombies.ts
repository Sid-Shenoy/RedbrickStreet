import "@babylonjs/loaders/glTF";

import {
  AbstractMesh,
  AssetContainer,
  MeshBuilder,
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

// Combat (per new requirements)
export const ZOMBIE_MAX_HEALTH = 100;

// Zombie AI distance thresholds (per requirements)
export const ZOMBIE_AI_FOLLOW_DIST_M = 30;
export const ZOMBIE_AI_ATTACK_DIST_M = 1;

// Player damage while being attacked (new)
export const ZOMBIE_AI_HIT_DAMAGE = 8;          // health per hit
export const ZOMBIE_AI_HIT_COOLDOWN_S = 0.9;    // seconds between hits per zombie while attacking

// Internal tuning (not part of config yet)
const ZOMBIE_WALK_SPEED_MPS = 2.0;          // meters per second

// Nav tuning (simple, static)
const NAV_PORTAL_MIN_OVERLAP_M = 0.25;  // minimum shared edge overlap to be considered connected (outdoors/road)
const NAV_REPLAN_COOLDOWN_S = 0.6;      // per-zombie replanning cooldown
const NAV_ENTER_TOL_M = 0.35;           // how close we need to be to consider ourselves "through" a portal

type Door = {
  kind: "door";
  aRegion: number;
  bRegion: number | null;
  hinge: [number, number];
  end: [number, number];
};

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

type NavNodeKind = "road" | "plot" | "firstFloor";

type NavNode = {
  id: number;
  kind: NavNodeKind;

  // For house-associated nodes only
  houseNumber?: number;
  regionIndex?: number; // index into plot.regions or firstFloor.regions (depending on kind)
  region?: Region;      // lot-local region

  // World-space AABB + centroid for fast tests / heuristics
  aabb: { x0: number; z0: number; x1: number; z1: number };
  center: { x: number; z: number };

  // Precomputed world edges (axis-aligned segments)
  edges: Seg2[];
};

type NavEdge = {
  to: number;
  cost: number;
  waypoint: { x: number; z: number }; // midpoint of portal/shared boundary in world XZ
};

type NavGraph = {
  nodes: NavNode[];
  adj: NavEdge[][];

  roadNodeId: number;

  // Node lookup per house/region index (fast mapping for doors + point location)
  plotNodeIdByHouseRegion: Map<number, Map<number, number>>;
  firstFloorNodeIdByHouseRegion: Map<number, Map<number, number>>;
};

type ZombieNavState = {
  nodeId: number | null;
  targetNodeId: number | null;
  path: number[];          // node ids, starting at nodeId
  cursor: number;          // index into path (current node position within path)
  replanCooldownS: number; // time until next allowed plan
};

type ZombieInstance = {
  root: TransformNode;
  walkAnim: AnimationGroup | null;
  attackAnim: AnimationGroup | null;
  reelAnim: AnimationGroup | null;
  dieAnim: AnimationGroup | null;

  // Simple pickable hitbox used for shooting (walls are ignored by picking predicate).
  hitbox: AbstractMesh;

  health: number;
  dead: boolean;

  // Time remaining for the "reel back" reaction (during this, zombie AI is paused).
  reelS: number;

  state: ZombieState;
  hitCooldownS: number;
  nav: ZombieNavState;
};

export interface ZombieHouseStreamer {
  ensureHouse(houseNumber: number): void;
  dispose(): void;

  // Shooting helpers (used by the player gun logic)
  isZombieHitbox(mesh: AbstractMesh): boolean;
  damageZombieHitbox(mesh: AbstractMesh, damage: number): boolean;

  // UI helper: remaining zombies out of the initial total (ZOMBIE_COUNT).
  getZombieCounts(): { alive: number; total: number };
}

export async function preloadZombieAssets(scene: Scene): Promise<AssetContainer> {
  return SceneLoader.LoadAssetContainerAsync("/assets/models/", "zombie.glb", scene);
}

/**
 * Plans ZOMBIE_COUNT spawns across all houses (area-weighted), but only instantiates zombies for a house
 * when ensureHouse(houseNumber) is called (typically when that house interior is streamed in).
 *
 * New behavior:
 * - Zombies do NOT use engine collisions.
 * - Zombies do NOT walk through walls.
 * - Zombies pathfind using a lightweight region/door graph:
 *   - firstFloor regions connect only via doors
 *   - plot (outdoor) regions connect via shared boundaries (open)
 *   - road connects to curb regions via shared boundaries (open)
 *   - exterior doors connect firstFloor <-> plot
 *
 * Zombies can chase the player regardless of indoor/outdoor status.
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

  // Build navigation graph once (static).
  const nav = buildNavGraph(houses, houseByNumber);

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

  let deadCount = 0;

  // --- Zombie sound effects (distance-attenuated) ---
  const ZOMBIE_SFX_MASTER = 0.9;

  const ZOMBIE_SFX_ATTACK_SRC = "/assets/audio/sfx/zombie/attack.mp3";
  const ZOMBIE_SFX_DEATH_SRC = "/assets/audio/sfx/zombie/death.mp3";
  const ZOMBIE_SFX_GETHIT_SRC = "/assets/audio/sfx/zombie/gethit.mp3";
  const ZOMBIE_SFX_WALK_SRC = "/assets/audio/sfx/zombie/walk.mp3";

  // Base volumes (before distance attenuation), 0..1.
  const ZOMBIE_SFX_ATTACK_BASE = 0.85;
  const ZOMBIE_SFX_GETHIT_BASE = 0.75;
  const ZOMBIE_SFX_DEATH_BASE = 0.9;
  const ZOMBIE_SFX_WALK_BASE = 0.55;

  // Max distances (meters) where volume fades to 0.
  const ZOMBIE_SFX_ATTACK_MAX_DIST_M = 14;
  const ZOMBIE_SFX_GETHIT_MAX_DIST_M = 18;
  const ZOMBIE_SFX_DEATH_MAX_DIST_M = 22;
  const ZOMBIE_SFX_WALK_MAX_DIST_M = 18;

  // Rolloff distances (meters) controlling inverse-square-like attenuation.
  const ZOMBIE_SFX_ATTACK_ROLLOFF_M = 3.5;
  const ZOMBIE_SFX_GETHIT_ROLLOFF_M = 4.5;
  const ZOMBIE_SFX_DEATH_ROLLOFF_M = 5.5;
  const ZOMBIE_SFX_WALK_ROLLOFF_M = 5.0;

  // Limit simultaneous looping "walk" groans for performance.
  const ZOMBIE_WALK_LOOP_SLOTS = 6;

  type OneShotPool = { pool: HTMLAudioElement[]; idx: number };

  function clamp01(v: number) {
    return Math.max(0, Math.min(1, v));
  }

  // Realistic-ish attenuation: inverse-square-like rolloff + a smooth fade to 0 at maxDist.
  function distanceGain(d: number, maxDist: number, rolloffDist: number): number {
    if (!Number.isFinite(d)) return 0;
    if (d <= 0) return 1;
    if (d >= maxDist) return 0;

    const r = Math.max(0.001, rolloffDist);
    const inv = 1 / (1 + (d / r) * (d / r));
    const t = d / maxDist;
    const fade = 1 - t * t * t * t;
    return clamp01(inv * fade);
  }

  function makeOneShotPool(src: string, size: number): OneShotPool {
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < size; i++) {
      const a = new Audio(src);
      a.preload = "auto";
      try {
        a.load();
      } catch {
        // no-op
      }
      pool.push(a);
    }
    return { pool, idx: 0 };
  }

  function playOneShot(p: OneShotPool, volume01: number) {
    if (p.pool.length === 0) return;

    const a = p.pool[p.idx]!;
    p.idx = (p.idx + 1) % p.pool.length;

    const v = clamp01(volume01);

    try {
      a.pause();
    } catch {
      // no-op
    }

    try {
      a.currentTime = 0;
    } catch {
      // no-op
    }

    try {
      a.volume = v;
    } catch {
      // no-op
    }

    const pr = a.play();
    if (pr) pr.catch(() => {});
  }

  function makeLoopAudio(src: string): HTMLAudioElement {
    const a = new Audio(src);
    a.preload = "auto";
    a.loop = true;
    a.volume = 0;
    try {
      a.load();
    } catch {
      // no-op
    }
    return a;
  }

  const zombieAttackPool = makeOneShotPool(ZOMBIE_SFX_ATTACK_SRC, 8);
  const zombieGetHitPool = makeOneShotPool(ZOMBIE_SFX_GETHIT_SRC, 8);
  const zombieDeathPool = makeOneShotPool(ZOMBIE_SFX_DEATH_SRC, 8);

  type WalkSlot = { audio: HTMLAudioElement; zombie: ZombieInstance | null };
  const walkSlots: WalkSlot[] = [];
  for (let i = 0; i < ZOMBIE_WALK_LOOP_SLOTS; i++) {
    walkSlots.push({ audio: makeLoopAudio(ZOMBIE_SFX_WALK_SRC), zombie: null });
  }

  function playZombieAttackSfx(zx: number, zz: number) {
    const p = getPlayerXZ();
    const d = Math.hypot(p.x - zx, p.z - zz);
    const g = distanceGain(d, ZOMBIE_SFX_ATTACK_MAX_DIST_M, ZOMBIE_SFX_ATTACK_ROLLOFF_M);
    playOneShot(zombieAttackPool, ZOMBIE_SFX_MASTER * ZOMBIE_SFX_ATTACK_BASE * g);
  }

  function playZombieGetHitSfx(zx: number, zz: number) {
    const p = getPlayerXZ();
    const d = Math.hypot(p.x - zx, p.z - zz);
    const g = distanceGain(d, ZOMBIE_SFX_GETHIT_MAX_DIST_M, ZOMBIE_SFX_GETHIT_ROLLOFF_M);
    playOneShot(zombieGetHitPool, ZOMBIE_SFX_MASTER * ZOMBIE_SFX_GETHIT_BASE * g);
  }

  function playZombieDeathSfx(zx: number, zz: number) {
    const p = getPlayerXZ();
    const d = Math.hypot(p.x - zx, p.z - zz);
    const g = distanceGain(d, ZOMBIE_SFX_DEATH_MAX_DIST_M, ZOMBIE_SFX_DEATH_ROLLOFF_M);
    playOneShot(zombieDeathPool, ZOMBIE_SFX_MASTER * ZOMBIE_SFX_DEATH_BASE * g);
  }

  function updateZombieWalkLoops(px: number, pz: number) {
    // Find the closest walking zombies (within max distance).
    const candidates = zombies
      .filter((z) => !z.dead && z.state === "walk")
      .map((z) => ({ z, d: Math.hypot(z.root.position.x - px, z.root.position.z - pz) }))
      .filter((c) => c.d < ZOMBIE_SFX_WALK_MAX_DIST_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, ZOMBIE_WALK_LOOP_SLOTS);

    const desired = new Set<ZombieInstance>();
    for (const c of candidates) desired.add(c.z);

    // Unassign slots whose zombies are no longer desired.
    for (const s of walkSlots) {
      if (s.zombie && !desired.has(s.zombie)) s.zombie = null;
    }

    // Mark already-assigned desired zombies.
    const used = new Set<ZombieInstance>();
    for (const s of walkSlots) {
      if (s.zombie) used.add(s.zombie);
    }

    // Fill empty slots with remaining desired zombies.
    let ci = 0;
    for (const s of walkSlots) {
      if (s.zombie) continue;

      while (ci < candidates.length && used.has(candidates[ci]!.z)) ci++;
      if (ci >= candidates.length) break;

      s.zombie = candidates[ci]!.z;
      used.add(s.zombie);
      ci++;
    }

    // Apply volumes + playback state.
    for (const s of walkSlots) {
      const a = s.audio;

      if (!s.zombie) {
        try {
          a.volume = 0;
        } catch {
          // no-op
        }
        if (!a.paused) {
          try {
            a.pause();
          } catch {
            // no-op
          }
        }
        continue;
      }

      const zx = s.zombie.root.position.x;
      const zz = s.zombie.root.position.z;
      const d = Math.hypot(zx - px, zz - pz);
      const g = distanceGain(d, ZOMBIE_SFX_WALK_MAX_DIST_M, ZOMBIE_SFX_WALK_ROLLOFF_M);
      const v = ZOMBIE_SFX_MASTER * ZOMBIE_SFX_WALK_BASE * g;

      try {
        a.volume = clamp01(v);
      } catch {
        // no-op
      }

      if (a.paused) {
        const pr = a.play();
        if (pr) pr.catch(() => {});
      }
    }
  }

  function disposeZombieSfx() {
    for (const s of walkSlots) {
      try {
        s.audio.pause();
      } catch {
        // no-op
      }
      s.zombie = null;
    }

    const pools = [zombieAttackPool, zombieGetHitPool, zombieDeathPool];
    for (const p of pools) {
      for (const a of p.pool) {
        try {
          a.pause();
        } catch {
          // no-op
        }
      }
    }
  }

  // Map pickable hitboxes -> zombie instances (for fast shooting lookups).
  const zombieByHitbox = new Map<AbstractMesh, ZombieInstance>();

  // Reaction tuning (not part of config yet)
  const ZOMBIE_REEL_DURATION_S = 0.55;

  function setZombieState(z: ZombieInstance, next: ZombieState) {
    if (z.state === next) return;

    // Stop all animations first to enforce the "far = no animation" rule.
    z.walkAnim?.stop();
    z.attackAnim?.stop();
    z.reelAnim?.stop();

    // Death animation is only started explicitly on kill.
    if (!z.dead) z.dieAnim?.stop();

    if (next === "walk") {
      z.walkAnim?.start(true, 1.0);
    } else if (next === "attack") {
      z.attackAnim?.start(true, 1.0);
    }

    z.state = next;
  }

  function playReel(z: ZombieInstance) {
    if (z.dead) return;
    if (!z.reelAnim) return;

    z.reelS = ZOMBIE_REEL_DURATION_S;

    // Interrupt other animations and play reel once.
    z.walkAnim?.stop();
    z.attackAnim?.stop();
    z.reelAnim.stop();
    z.reelAnim.start(false, 1.0);

    z.state = "idle";
  }

  function killZombie(z: ZombieInstance) {
    if (z.dead) return;

    z.dead = true;
    z.health = 0;
    deadCount = Math.min(ZOMBIE_COUNT, deadCount + 1);

    // Death SFX (distance-attenuated).
    playZombieDeathSfx(z.root.position.x, z.root.position.z);

    // If this zombie was occupying a walk-loop slot, drop it immediately.
    for (const s of walkSlots) {
      if (s.zombie === z) s.zombie = null;
    }

    // Make it unshootable.
    z.hitbox.isPickable = false;
    z.hitbox.setEnabled(false);
    zombieByHitbox.delete(z.hitbox);

    // Stop any non-death animation and play die once.
    z.walkAnim?.stop();
    z.attackAnim?.stop();
    z.reelAnim?.stop();
    z.dieAnim?.stop();
    z.dieAnim?.start(false, 1.0);

    z.state = "idle";
  }

  function damageZombie(z: ZombieInstance, damage: number) {
    if (z.dead) return;
    if (!Number.isFinite(damage) || damage <= 0) return;

    z.health = Math.max(0, z.health - damage);

    if (z.health <= 0) {
      killZombie(z);
    } else {
      // "gethit.mp3": when a zombie gets shot but survives.
      playZombieGetHitSfx(z.root.position.x, z.root.position.z);
      playReel(z);
    }
  }

  function isZombieHitbox(mesh: AbstractMesh): boolean {
    return zombieByHitbox.has(mesh);
  }

  function damageZombieHitbox(mesh: AbstractMesh, damage: number): boolean {
    const z = zombieByHitbox.get(mesh);
    if (!z) return false;
    damageZombie(z, damage);
    return true;
  }

  function getZombieCounts(): { alive: number; total: number } {
    const total = ZOMBIE_COUNT;
    const dead = Math.max(0, Math.min(total, deadCount));
    return { alive: Math.max(0, total - dead), total };
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
      const reelAnim = inst.animationGroups?.[1] ?? null;
      const dieAnim = inst.animationGroups?.[2] ?? null;
      const walkAnim = inst.animationGroups?.[3] ?? null;

      // Start in idle (no animation playing).
      attackAnim?.stop();
      reelAnim?.stop();
      dieAnim?.stop();
      walkAnim?.stop();

      // Simple shoot hitbox (cylinder). This is what the player raycast targets.
      // It is NOT part of the zombie meshes so we can keep meshes non-pickable.
      const hitbox = MeshBuilder.CreateCylinder(
        `rbs_zombie_hitbox_h${houseNumber}_${i}`,
        { height: 1.7, diameter: 0.8, tessellation: 12 },
        scene
      );
      hitbox.isVisible = false;
      hitbox.isPickable = true;
      hitbox.checkCollisions = false;
      hitbox.parent = root;
      hitbox.position.y = 0.85;

      const startNode = findNodeForWorldXZ(nav, houseByNumber, root.position.x, root.position.z);

      const zi: ZombieInstance = {
        root,
        walkAnim,
        attackAnim,
        reelAnim,
        dieAnim,
        hitbox,
        health: ZOMBIE_MAX_HEALTH,
        dead: false,
        reelS: 0,
        state: "idle",
        hitCooldownS: 0,
        nav: {
          nodeId: startNode,
          targetNodeId: null,
          path: startNode !== null ? [startNode] : [],
          cursor: 0,
          replanCooldownS: 0,
        },
      };

      zombieByHitbox.set(hitbox, zi);
      zombies.push(zi);

      roots.push(root);
    }
  }

  function canAttack(
    zNode: number | null,
    pNode: number | null,
    zx: number,
    zz: number,
    px: number,
    pz: number
  ): boolean {
    if (zNode === null || pNode === null) return true;
    if (zNode === pNode) return true;

    // Outdoors: allow attacks even if regions differ (no walls between plot/road regions).
    const zk = nav.nodes[zNode]!.kind;
    const pk = nav.nodes[pNode]!.kind;
    if (zk !== "firstFloor" && pk !== "firstFloor") return true;

    // Indoors (or indoor<->outdoor): only allow attacking across a real portal (door/open adjacency)
    // and only if both are near it (prevents "through walls" attacks).
    const wp = getWaypoint(nav, zNode, pNode);
    if (!wp) return false;

    const dz = Math.hypot(zx - wp.x, zz - wp.z);
    const dp = Math.hypot(px - wp.x, pz - wp.z);
    return dz <= 1.2 && dp <= 1.2;
  }

  function maybeAdvancePath(z: ZombieInstance) {
    const path = z.nav.path;
    if (path.length === 0) return;

    // Ensure cursor points at the actual node, if possible.
    if (z.nav.nodeId !== null && path[z.nav.cursor] !== z.nav.nodeId) {
      const idx = path.indexOf(z.nav.nodeId);
      if (idx >= 0) z.nav.cursor = idx;
    }

    // Advance while our current position is inside the next node.
    while (z.nav.cursor + 1 < path.length) {
      const nextId = path[z.nav.cursor + 1]!;
      const insideNext = nodeContainsWorldXZ(nav, houseByNumber, nextId, z.root.position.x, z.root.position.z);
      if (!insideNext) break;

      z.nav.nodeId = nextId;
      z.nav.cursor++;
    }
  }

  function moveToward(z: ZombieInstance, targetX: number, targetZ: number, dt: number) {
    const x0 = z.root.position.x;
    const z0 = z.root.position.z;

    const dx = targetX - x0;
    const dz = targetZ - z0;
    const dist = Math.hypot(dx, dz);
    if (dist <= 1e-6) return;

    const indoorMul =
      z.nav.nodeId !== null && nav.nodes[z.nav.nodeId] && nav.nodes[z.nav.nodeId]!.kind === "firstFloor"
        ? 0.5
        : 1.0;

    const step = Math.min(dist, ZOMBIE_WALK_SPEED_MPS * indoorMul * dt);

    const vx = (dx / dist) * step;
    const vz = (dz / dist) * step;

    const curNode = z.nav.nodeId;
    const nextNode =
      z.nav.path.length > 0 && z.nav.cursor + 1 < z.nav.path.length ? z.nav.path[z.nav.cursor + 1]! : null;

    // Try full move, then axis-separated sliding to prevent crossing walls/boundaries without collisions.
    const moved = tryNavMove(z, nav, houseByNumber, vx, vz, curNode, nextNode);

    if (moved) {
      // Face travel direction.
      const mx = z.root.position.x - x0;
      const mz = z.root.position.z - z0;
      if (Math.hypot(mx, mz) > 1e-6) {
        z.root.rotation.y = Math.atan2(mx, mz);
      }
    }
  }

  const aiObserver: Observer<Scene> = scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    if (dt <= 0) return;

    const p = getPlayerXZ();
    const px = p.x;
    const pz = p.z;

    const playerNode = findNodeForWorldXZ(nav, houseByNumber, px, pz);

    for (const z of zombies) {

      if (z.dead) continue;

      // Cooldown tick (always counts down).
      z.hitCooldownS = Math.max(0, z.hitCooldownS - dt);

      // Replan cooldown tick.
      z.nav.replanCooldownS = Math.max(0, z.nav.replanCooldownS - dt);

      // Reel reaction tick (pauses AI while playing the "reel back" animation).
      z.reelS = Math.max(0, z.reelS - dt);

      if (z.reelS > 1e-6) {
        // While reacting to being shot, zombies pause AI and do not attack.
        z.walkAnim?.stop();
        z.attackAnim?.stop();
        z.state = "idle";
        continue;
      }

      const zx = z.root.position.x;
      const zz = z.root.position.z;

      // Clamp Y so zombies cannot climb stairs (and keep consistent everywhere).
      if (z.root.position.y !== FIRST_FLOOR_Y) z.root.position.y = FIRST_FLOOR_Y;

      const dx = px - zx;
      const dz = pz - zz;
      const dist = Math.hypot(dx, dz);

      // Update / repair current node if needed.
      if (z.nav.nodeId === null || !nodeContainsWorldXZ(nav, houseByNumber, z.nav.nodeId, zx, zz)) {
        z.nav.nodeId = findNodeForWorldXZ(nav, houseByNumber, zx, zz);
        z.nav.path = z.nav.nodeId !== null ? [z.nav.nodeId] : [];
        z.nav.cursor = 0;
        z.nav.targetNodeId = null;
      }

      // Far away: idle, no animation (performance rule).
      if (dist > ZOMBIE_AI_FOLLOW_DIST_M) {
        setZombieState(z, "idle");
        continue;
      }

      // Close enough to attack (but avoid "through walls" by requiring a portal/adjacency when nodes differ).
      if (dist <= ZOMBIE_AI_ATTACK_DIST_M) {
        if (canAttack(z.nav.nodeId, playerNode, zx, zz, px, pz)) {
          setZombieState(z, "attack");

          // Damage the player at a fixed cadence while attacking.
          if (z.hitCooldownS <= 1e-6) {
            // "attack.mp3": when a zombie attacks the player (i.e., when it applies damage).
            playZombieAttackSfx(zx, zz);
            damageCb(ZOMBIE_AI_HIT_DAMAGE);
            z.hitCooldownS = ZOMBIE_AI_HIT_COOLDOWN_S;
          }

          // Face the player while attacking.
          z.root.rotation.y = Math.atan2(dx, dz);
          continue;
        }

        // Otherwise, keep walking to find an actual path (e.g., door).
      }

      // Follow/chase state: pathfind toward the player.
      setZombieState(z, "walk");

      const zNode = z.nav.nodeId;
      const pNode = playerNode;

      // If we don't know nodes, fallback to naive chase (still clamped to first floor height).
      if (zNode === null || pNode === null) {
        moveToward(z, px, pz, dt);
        continue;
      }

      // Outdoors (plot/road): follow the player directly (no waypoint-hopping).
      // Movement remains constrained to outdoor navigable space by tryNavMove (cannot enter firstFloor/houseregion).
      const zKind = nav.nodes[zNode]!.kind;
      const pKind = nav.nodes[pNode]!.kind;
      if (zKind !== "firstFloor" && pKind !== "firstFloor") {
        z.nav.targetNodeId = pNode;
        z.nav.path = [zNode];
        z.nav.cursor = 0;

        moveToward(z, px, pz, dt);
        continue;
      }

      // Replan if:
      // - target node changed
      // - path empty
      // - cursor out of bounds
      // - allowed by cooldown
      const needsPlan =
        z.nav.targetNodeId !== pNode ||
        z.nav.path.length === 0 ||
        z.nav.cursor < 0 ||
        z.nav.cursor >= z.nav.path.length ||
        z.nav.path[z.nav.cursor] !== zNode;

      if (needsPlan && z.nav.replanCooldownS <= 1e-6) {
        const path = astar(nav, zNode, pNode);
        z.nav.path = path ?? [zNode];
        z.nav.cursor = 0;
        z.nav.nodeId = zNode;
        z.nav.targetNodeId = pNode;
        z.nav.replanCooldownS = NAV_REPLAN_COOLDOWN_S;
      }

      // Ensure cursor/node coherence.
      maybeAdvancePath(z);

      // Determine the next waypoint.
      let tx = px;
      let tz = pz;

      const path = z.nav.path;
      if (path.length > 0 && z.nav.cursor + 1 < path.length) {
        const nextId = path[z.nav.cursor + 1]!;
        const wp = getWaypoint(nav, z.nav.nodeId!, nextId);
        if (wp) {
          // Default: aim for the portal waypoint.
          tx = wp.x;
          tz = wp.z;

          const dwp = Math.hypot(z.root.position.x - wp.x, z.root.position.z - wp.z);

          // If we're basically at the portal, aim INTO the next node so we actually cross the boundary.
          // This allows outdoor->indoor (re-entering houses) and indoor->outdoor reliably using a single waypoint.
          if (dwp <= NAV_ENTER_TOL_M) {
            const nc = nav.nodes[nextId]!.center;
            tx = nc.x;
            tz = nc.z;

            // If we've already stepped into next, advance.
            if (nodeContainsWorldXZ(nav, houseByNumber, nextId, z.root.position.x, z.root.position.z)) {
              z.nav.nodeId = nextId;
              z.nav.cursor++;
            }
          }
        }
      }

      moveToward(z, tx, tz, dt);

      // Post-move: advance path if we ended up inside the next node.
      maybeAdvancePath(z);

      // Re-clamp Y after movement.
      z.root.position.y = FIRST_FLOOR_Y;
    }

    updateZombieWalkLoops(px, pz);
  });

  function dispose() {
    scene.onBeforeRenderObservable.remove(aiObserver);

    // Stop + dispose all zombie animation groups we created via instantiation.
    for (const z of zombies) {
      z.walkAnim?.stop();
      z.attackAnim?.stop();
      z.reelAnim?.stop();
      z.dieAnim?.stop();

      z.walkAnim?.dispose();
      z.attackAnim?.dispose();
      z.reelAnim?.dispose();
      z.dieAnim?.dispose();
    }
    zombies.length = 0;

    for (const r of roots) r.dispose();
    roots.length = 0;

    disposeZombieSfx();

    zombieByHitbox.clear();
    spawnedHouses.clear();
    planByHouse.clear();
  }

  scene.onDisposeObservable.add(() => dispose());

  return { ensureHouse, dispose, isZombieHitbox, damageZombieHitbox, getZombieCounts };
}

// ---------------------------
// Navigation (static graph)
// ---------------------------

type Seg2 = { ax: number; az: number; bx: number; bz: number };

function buildNavGraph(houses: HouseWithModel[], houseByNumber: Map<number, HouseWithModel>): NavGraph {
  const nodes: NavNode[] = [];
  const adj: NavEdge[][] = [];

  const plotNodeIdByHouseRegion = new Map<number, Map<number, number>>();
  const firstFloorNodeIdByHouseRegion = new Map<number, Map<number, number>>();

  function addNode(n: Omit<NavNode, "id">): number {
    const id = nodes.length;
    nodes.push({ ...n, id });
    adj.push([]);
    return id;
  }

  // Road node (world-space rectangle)
  const roadAabb = { x0: 0, z0: 30, x1: 230, z1: 40 };
  const roadCenter = { x: (roadAabb.x0 + roadAabb.x1) * 0.5, z: (roadAabb.z0 + roadAabb.z1) * 0.5 };
  const roadEdges = rectEdgesWorld(roadAabb.x0, roadAabb.z0, roadAabb.x1, roadAabb.z1);

  const roadNodeId = addNode({
    kind: "road",
    aabb: roadAabb,
    center: roadCenter,
    edges: roadEdges,
  });

  // House plot + first floor nodes
  for (const house of houses) {
    const hn = house.houseNumber;

    // Plot (outdoors): include all plot regions EXCEPT houseregion (the footprint).
    const plotMap = new Map<number, number>();
    for (let i = 0; i < house.model.plot.regions.length; i++) {
      const r = house.model.plot.regions[i]!;
      if (r.name === "houseregion") continue;

      const aabb = regionWorldAabb(house, r);
      const center = regionWorldCenter(house, r);
      const edges = regionEdgesWorld(house, r);

      const id = addNode({
        kind: "plot",
        houseNumber: hn,
        regionIndex: i,
        region: r,
        aabb,
        center,
        edges,
      });

      plotMap.set(i, id);
    }
    plotNodeIdByHouseRegion.set(hn, plotMap);

    // First floor (indoors): include all non-void regions.
    const ffMap = new Map<number, number>();
    for (let i = 0; i < house.model.firstFloor.regions.length; i++) {
      const r = house.model.firstFloor.regions[i]!;
      if (r.surface === "void") continue;

      const aabb = regionWorldAabb(house, r);
      const center = regionWorldCenter(house, r);
      const edges = regionEdgesWorld(house, r);

      const id = addNode({
        kind: "firstFloor",
        houseNumber: hn,
        regionIndex: i,
        region: r,
        aabb,
        center,
        edges,
      });

      ffMap.set(i, id);
    }
    firstFloorNodeIdByHouseRegion.set(hn, ffMap);
  }

  // Open adjacency (plot <-> plot, plot <-> road, road <-> road (none))
  const openNodeIds: number[] = [];
  for (const n of nodes) {
    if (n.kind === "plot" || n.kind === "road") openNodeIds.push(n.id);
  }

  for (let i = 0; i < openNodeIds.length; i++) {
    for (let j = i + 1; j < openNodeIds.length; j++) {
      const aId = openNodeIds[i]!;
      const bId = openNodeIds[j]!;
      const a = nodes[aId]!;
      const b = nodes[bId]!;

      // Quick AABB reject
      if (!aabbNear(a.aabb, b.aabb, 0.001)) continue;

      const portal = sharedPortalWaypoint(a.edges, b.edges);
      if (!portal) continue;

      const cost = Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z);
      addUndirectedEdge(adj, aId, bId, cost, portal);
    }
  }

  // Door adjacency (firstFloor <-> firstFloor via interior doors; firstFloor <-> plot via exterior doors)
  for (const house of houses) {
    const hn = house.houseNumber;

    const ffNodeMap = firstFloorNodeIdByHouseRegion.get(hn);
    const plotNodeMap = plotNodeIdByHouseRegion.get(hn);
    if (!ffNodeMap || !plotNodeMap) continue;

    for (const raw of house.model.firstFloor.construction) {
      const d = asDoor(raw);
      if (!d) continue;

      const aNode = ffNodeMap.get(d.aRegion);
      if (aNode === undefined) continue;

      const midLocal: [number, number] = [
        (d.hinge[0] + d.end[0]) * 0.5,
        (d.hinge[1] + d.end[1]) * 0.5,
      ];
      const midWorld = lotLocalToWorld(house, midLocal[0], midLocal[1]);
      const waypoint = { x: midWorld.x, z: midWorld.z };

      if (typeof d.bRegion === "number") {
        const bNode = ffNodeMap.get(d.bRegion);
        if (bNode === undefined) continue;

        const cost = Math.hypot(nodes[aNode]!.center.x - nodes[bNode]!.center.x, nodes[aNode]!.center.z - nodes[bNode]!.center.z);
        addUndirectedEdge(adj, aNode, bNode, cost, waypoint);
      } else {
        // Exterior door: connect to the plot region just outside the door.

        // Door midpoint in lot-local space.
        const mx = (d.hinge[0] + d.end[0]) * 0.5;
        const mz = (d.hinge[1] + d.end[1]) * 0.5;

        const plotRegions = house.model.plot.regions;

        let chosenPlotIdx: number | null = null;
        let chosenOutsideLocal: [number, number] | null = null;

        // (1) Robust probe using the plot "houseregion" footprint.
        // This avoids accidentally snapping the door to the wrong yard region (common cause of "stuck at back door").
        const houseRegion = plotRegions.find((r) => r.name === "houseregion") ?? null;

        const vertical = Math.abs(d.hinge[0] - d.end[0]) < 1e-6;
        const normals: Array<[number, number]> = vertical ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
        const probeDists = [0.35, 0.7, 1.05, 1.4];

        outerProbe: for (const [nx, nz] of normals) {
          for (const dist of probeDists) {
            const pLocal: [number, number] = [mx + nx * dist, mz + nz * dist];

            // Must be outside the house footprint (if we can identify it).
            if (houseRegion && pointInRegionLocal(pLocal[0], pLocal[1], houseRegion)) continue;

            const idx = findPlotRegionIndexContainingLocal(plotRegions, pLocal);
            if (idx !== null) {
              chosenPlotIdx = idx;
              chosenOutsideLocal = pLocal;
              break outerProbe;
            }
          }
        }

        // (2) Fallback probe using the first-floor region (older method).
        if (chosenPlotIdx === null) {
          const aRegion = house.model.firstFloor.regions[d.aRegion];
          if (!aRegion) continue;

          // Candidate points just outside the door (try several depths to avoid "midpoint inside wall" cases).
          const outsideLocal = pickOutsideOfDoorLocal(aRegion, d);
          const outsideLocalAlt = pickOutsideOfDoorLocalAlt(d);

          const candidatesLocal: Array<[number, number]> = [];

          function pushRay(base: [number, number]) {
            const dx = base[0] - mx;
            const dz = base[1] - mz;
            const len = Math.hypot(dx, dz) || 1;
            const ux = dx / len;
            const uz = dz / len;

            // base (near), then progressively farther outside.
            candidatesLocal.push(
              base,
              [mx + ux * 0.45, mz + uz * 0.45],
              [mx + ux * 0.9, mz + uz * 0.9],
              [mx + ux * 1.35, mz + uz * 1.35]
            );
          }

          pushRay(outsideLocal);
          pushRay(outsideLocalAlt);

          for (const c of candidatesLocal) {
            const idx = findPlotRegionIndexContainingLocal(plotRegions, c);
            if (idx !== null) {
              chosenPlotIdx = idx;
              chosenOutsideLocal = c;
              break;
            }
          }
        }

        let plotNode: number | undefined = undefined;
        if (chosenPlotIdx !== null) {
          plotNode = plotNodeMap.get(chosenPlotIdx);
        }

        // Prefer a waypoint that is actually OUTSIDE (inside the chosen plot region) so zombies can step through the door.
        let edgeWaypoint = waypoint;
        if (plotNode !== undefined && chosenOutsideLocal) {
          const wOut = lotLocalToWorld(house, chosenOutsideLocal[0], chosenOutsideLocal[1]);
          edgeWaypoint = { x: wOut.x, z: wOut.z };
        }

        // Fallback: choose nearest plot node in this house by world distance to the door midpoint.
        if (plotNode === undefined) {
          let bestId: number | null = null;
          let bestD = Infinity;

          for (const id of plotNodeMap.values()) {
            const c = nodes[id]!.center;
            const dd = Math.hypot(c.x - waypoint.x, c.z - waypoint.z);
            if (dd < bestD) {
              bestD = dd;
              bestId = id;
            }
          }

          if (bestId !== null) plotNode = bestId;
        }

        if (plotNode !== undefined) {
          const cost = Math.hypot(
            nodes[aNode]!.center.x - nodes[plotNode]!.center.x,
            nodes[aNode]!.center.z - nodes[plotNode]!.center.z
          );
          addUndirectedEdge(adj, aNode, plotNode, cost, edgeWaypoint);
        }
      }
    }
  }

  return {
    nodes,
    adj,
    roadNodeId,
    plotNodeIdByHouseRegion,
    firstFloorNodeIdByHouseRegion,
  };
}

function addUndirectedEdge(adj: NavEdge[][], a: number, b: number, cost: number, waypoint: { x: number; z: number }) {
  adj[a]!.push({ to: b, cost, waypoint });
  adj[b]!.push({ to: a, cost, waypoint });
}

function getWaypoint(nav: NavGraph, from: number, to: number): { x: number; z: number } | null {
  for (const e of nav.adj[from]!) {
    if (e.to === to) return e.waypoint;
  }
  return null;
}

function aabbNear(a: { x0: number; z0: number; x1: number; z1: number }, b: { x0: number; z0: number; x1: number; z1: number }, eps: number): boolean {
  return !(a.x1 < b.x0 - eps || b.x1 < a.x0 - eps || a.z1 < b.z0 - eps || b.z1 < a.z0 - eps);
}

function rectEdgesWorld(x0: number, z0: number, x1: number, z1: number): Seg2[] {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);

  return [
    { ax: minX, az: minZ, bx: maxX, bz: minZ }, // back
    { ax: maxX, az: minZ, bx: maxX, bz: maxZ }, // right
    { ax: maxX, az: maxZ, bx: minX, bz: maxZ }, // front
    { ax: minX, az: maxZ, bx: minX, bz: minZ }, // left
  ];
}

function regionEdgesWorld(house: HouseWithModel, r: Region): Seg2[] {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz);
    const maxZ = Math.max(az, bz);

    // Convert corners to world
    const p00 = lotLocalToWorld(house, minX, minZ);
    const p10 = lotLocalToWorld(house, maxX, minZ);
    const p11 = lotLocalToWorld(house, maxX, maxZ);
    const p01 = lotLocalToWorld(house, minX, maxZ);

    return [
      { ax: p00.x, az: p00.z, bx: p10.x, bz: p10.z },
      { ax: p10.x, az: p10.z, bx: p11.x, bz: p11.z },
      { ax: p11.x, az: p11.z, bx: p01.x, bz: p01.z },
      { ax: p01.x, az: p01.z, bx: p00.x, bz: p00.z },
    ];
  }

  const out: Seg2[] = [];
  const pts = r.points;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const wa = lotLocalToWorld(house, a[0], a[1]);
    const wb = lotLocalToWorld(house, b[0], b[1]);
    out.push({ ax: wa.x, az: wa.z, bx: wb.x, bz: wb.z });
  }

  return out;
}

function sharedPortalWaypoint(aEdges: Seg2[], bEdges: Seg2[]): { x: number; z: number } | null {
  const EPS = 1e-3;
  let bestLen = 0;
  let best: { x: number; z: number } | null = null;

  for (const a of aEdges) {
    for (const b of bEdges) {
      const aHoriz = Math.abs(a.az - a.bz) < EPS;
      const bHoriz = Math.abs(b.az - b.bz) < EPS;
      const aVert = Math.abs(a.ax - a.bx) < EPS;
      const bVert = Math.abs(b.ax - b.bx) < EPS;

      if (aHoriz && bHoriz && Math.abs(a.az - b.az) < 0.02) {
        const ax0 = Math.min(a.ax, a.bx);
        const ax1 = Math.max(a.ax, a.bx);
        const bx0 = Math.min(b.ax, b.bx);
        const bx1 = Math.max(b.ax, b.bx);
        const lo = Math.max(ax0, bx0);
        const hi = Math.min(ax1, bx1);
        const len = hi - lo;
        if (len >= NAV_PORTAL_MIN_OVERLAP_M && len > bestLen) {
          bestLen = len;
          best = { x: (lo + hi) * 0.5, z: a.az };
        }
      }

      if (aVert && bVert && Math.abs(a.ax - b.ax) < 0.02) {
        const az0 = Math.min(a.az, a.bz);
        const az1 = Math.max(a.az, a.bz);
        const bz0 = Math.min(b.az, b.bz);
        const bz1 = Math.max(b.az, b.bz);
        const lo = Math.max(az0, bz0);
        const hi = Math.min(az1, bz1);
        const len = hi - lo;
        if (len >= NAV_PORTAL_MIN_OVERLAP_M && len > bestLen) {
          bestLen = len;
          best = { x: a.ax, z: (lo + hi) * 0.5 };
        }
      }
    }
  }

  return best;
}

function regionWorldAabb(house: HouseWithModel, r: Region): { x0: number; z0: number; x1: number; z1: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  const pts = regionWorldPoints(house, r);
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  return { x0: minX, z0: minZ, x1: maxX, z1: maxZ };
}

function regionWorldCenter(house: HouseWithModel, r: Region): { x: number; z: number } {
  if (r.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = r.points;
    const mx = (x0 + x1) * 0.5;
    const mz = (z0 + z1) * 0.5;
    const w = lotLocalToWorld(house, mx, mz);
    return { x: w.x, z: w.z };
  }

  const pts = r.points;
  let sx = 0, sz = 0;
  for (const [x, z] of pts) {
    sx += x;
    sz += z;
  }
  const mx = sx / Math.max(1, pts.length);
  const mz = sz / Math.max(1, pts.length);
  const w = lotLocalToWorld(house, mx, mz);
  return { x: w.x, z: w.z };
}

function regionWorldPoints(house: HouseWithModel, r: Region): Array<{ x: number; z: number }> {
  if (r.type === "rectangle") {
    const [[ax, az], [bx, bz]] = r.points;
    const minX = Math.min(ax, bx);
    const maxX = Math.max(ax, bx);
    const minZ = Math.min(az, bz);
    const maxZ = Math.max(az, bz);

    return [
      lotLocalToWorld(house, minX, minZ),
      lotLocalToWorld(house, maxX, minZ),
      lotLocalToWorld(house, maxX, maxZ),
      lotLocalToWorld(house, minX, maxZ),
    ];
  }

  return r.points.map(([x, z]) => lotLocalToWorld(house, x, z));
}

function worldToLotLocal(house: HouseWithModel, worldX: number, worldZ: number): { x: number; z: number } {
  const { x, z, xsize, zsize } = house.bounds;
  const lx = worldX - x;

  if (house.houseNumber % 2 === 0) {
    return { x: lx, z: worldZ - z };
  }

  // Odd houses: inverse of lotLocalToWorld mirroring on Z.
  // worldZ = bounds.z + (zsize - localZ)  => localZ = zsize - (worldZ - bounds.z)
  return { x: lx, z: zsize - (worldZ - z) };
}

function nodeContainsWorldXZ(nav: NavGraph, houseByNumber: Map<number, HouseWithModel>, nodeId: number, x: number, z: number): boolean {
  const n = nav.nodes[nodeId]!;
  if (x < n.aabb.x0 - 1e-6 || x > n.aabb.x1 + 1e-6 || z < n.aabb.z0 - 1e-6 || z > n.aabb.z1 + 1e-6) {
    return false;
  }

  if (n.kind === "road") return true;

  const house = n.houseNumber !== undefined ? houseByNumber.get(n.houseNumber) : null;
  if (!house || !n.region) return false;

  const loc = worldToLotLocal(house, x, z);
  return pointInRegionLocal(loc.x, loc.z, n.region);
}

function findNodeForWorldXZ(nav: NavGraph, houseByNumber: Map<number, HouseWithModel>, x: number, z: number): number | null {
  // Road first (fast)
  const road = nav.nodes[nav.roadNodeId]!;
  if (x >= road.aabb.x0 && x <= road.aabb.x1 && z >= road.aabb.z0 && z <= road.aabb.z1) {
    return nav.roadNodeId;
  }

  // Find containing lot (30 houses, cheap)
  let house: HouseWithModel | null = null;
  for (const h of houseByNumber.values()) {
    const bx0 = h.bounds.x;
    const bx1 = h.bounds.x + h.bounds.xsize;
    const bz0 = h.bounds.z;
    const bz1 = h.bounds.z + h.bounds.zsize;
    if (x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1) {
      house = h;
      break;
    }
  }
  if (!house) return null;

  const hn = house.houseNumber;
  const loc = worldToLotLocal(house, x, z);

  // First floor nodes (indoors) first
  const ffMap = nav.firstFloorNodeIdByHouseRegion.get(hn);
  if (ffMap) {
    for (const [idx, nodeId] of ffMap.entries()) {
      const r = house.model.firstFloor.regions[idx];
      if (!r) continue;
      if (r.surface === "void") continue;
      if (pointInRegionLocal(loc.x, loc.z, r)) return nodeId;
    }
  }

  // Plot nodes (outdoors)
  const plotMap = nav.plotNodeIdByHouseRegion.get(hn);
  if (plotMap) {
    for (const [idx, nodeId] of plotMap.entries()) {
      const r = house.model.plot.regions[idx];
      if (!r) continue;
      if (r.name === "houseregion") continue;
      if (pointInRegionLocal(loc.x, loc.z, r)) return nodeId;
    }
  }

  // Fallback: choose nearest node in this lot (prevents getting "lost" in tiny wall-thickness gaps).
  let best: number | null = null;
  let bestD = Infinity;

  if (ffMap) {
    for (const nodeId of ffMap.values()) {
      const c = nav.nodes[nodeId]!.center;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) {
        bestD = d;
        best = nodeId;
      }
    }
  }

  if (plotMap) {
    for (const nodeId of plotMap.values()) {
      const c = nav.nodes[nodeId]!.center;
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) {
        bestD = d;
        best = nodeId;
      }
    }
  }

  return best;
}

function tryNavMove(
  z: ZombieInstance,
  nav: NavGraph,
  houseByNumber: Map<number, HouseWithModel>,
  vx: number,
  vz: number,
  curNode: number | null,
  nextNode: number | null
): boolean {
  const x0 = z.root.position.x;
  const z0 = z.root.position.z;

  const tries: Array<[number, number]> = [
    [vx, vz],
    [vx, 0],
    [0, vz],
  ];

  const curKind = curNode !== null ? nav.nodes[curNode]!.kind : null;
  const curIsOutdoor = curKind === "plot" || curKind === "road";

  for (const [tx, tz] of tries) {
    const nx = x0 + tx;
    const nz = z0 + tz;

    // Outdoors: allow free crossing between outdoor nodes while still forbidding entry into firstFloor/houseregion.
    // (We only accept the move if the candidate position is actually INSIDE a plot/road node.)
    if (curIsOutdoor) {
      // Allow stepping into the planned next node (including firstFloor) when we're at a portal.
      // This is what lets zombies re-enter houses through doors.
      if (nextNode !== null && nodeContainsWorldXZ(nav, houseByNumber, nextNode, nx, nz)) {
        z.root.position.x = nx;
        z.root.position.z = nz;
        z.nav.nodeId = nextNode;

        // Advance cursor if this is our planned next.
        if (z.nav.path.length > 0 && z.nav.cursor + 1 < z.nav.path.length && z.nav.path[z.nav.cursor + 1] === nextNode) {
          z.nav.cursor++;
        }
        return true;
      }

      // Otherwise, allow free crossing between outdoor nodes while still forbidding entry into firstFloor/houseregion.
      // (We only accept the move if the candidate position is actually INSIDE a plot/road node.)
      const nid = findNodeForWorldXZ(nav, houseByNumber, nx, nz);
      if (
        nid !== null &&
        (nav.nodes[nid]!.kind === "plot" || nav.nodes[nid]!.kind === "road") &&
        nodeContainsWorldXZ(nav, houseByNumber, nid, nx, nz)
      ) {
        z.root.position.x = nx;
        z.root.position.z = nz;
        z.nav.nodeId = nid;

        // Keep cursor coherent if we happened to enter the planned next node.
        if (z.nav.path.length > 0) {
          if (z.nav.cursor + 1 < z.nav.path.length && z.nav.path[z.nav.cursor + 1] === nid) {
            z.nav.cursor++;
          } else if (z.nav.path[z.nav.cursor] !== nid) {
            const idx = z.nav.path.indexOf(nid);
            if (idx >= 0) z.nav.cursor = idx;
          }
        }

        return true;
      }
    }

    // Indoors (or any constrained move): stay inside current node unless stepping into the planned next node.
    if (curNode !== null && nodeContainsWorldXZ(nav, houseByNumber, curNode, nx, nz)) {
      z.root.position.x = nx;
      z.root.position.z = nz;
      return true;
    }

    if (nextNode !== null && nodeContainsWorldXZ(nav, houseByNumber, nextNode, nx, nz)) {
      z.root.position.x = nx;
      z.root.position.z = nz;
      z.nav.nodeId = nextNode;

      // Advance cursor if this is our planned next.
      if (z.nav.path.length > 0 && z.nav.cursor + 1 < z.nav.path.length && z.nav.path[z.nav.cursor + 1] === nextNode) {
        z.nav.cursor++;
      }
      return true;
    }
  }

  return false;
}

function astar(nav: NavGraph, start: number, goal: number): number[] | null {
  if (start === goal) return [start];

  const n = nav.nodes.length;
  const g = new Array<number>(n).fill(Infinity);
  const f = new Array<number>(n).fill(Infinity);
  const came = new Array<number>(n).fill(-1);
  const inOpen = new Array<boolean>(n).fill(false);
  const open: number[] = [];

  g[start] = 0;
  f[start] = heuristic(nav, start, goal);
  open.push(start);
  inOpen[start] = true;

  while (open.length > 0) {
    // pick lowest f (small N => linear scan is fine)
    let bestIdx = 0;
    let bestNode = open[0]!;
    let bestF = f[bestNode]!;

    for (let i = 1; i < open.length; i++) {
      const id = open[i]!;
      const ff = f[id]!;
      if (ff < bestF) {
        bestF = ff;
        bestNode = id;
        bestIdx = i;
      }
    }

    // pop best
    open.splice(bestIdx, 1);
    inOpen[bestNode] = false;

    if (bestNode === goal) {
      return reconstructPath(came, goal);
    }

    for (const e of nav.adj[bestNode]!) {
      const tentative = g[bestNode]! + e.cost;
      if (tentative < g[e.to]!) {
        came[e.to] = bestNode;
        g[e.to] = tentative;
        f[e.to] = tentative + heuristic(nav, e.to, goal);

        if (!inOpen[e.to]) {
          inOpen[e.to] = true;
          open.push(e.to);
        }
      }
    }
  }

  return null;
}

function heuristic(nav: NavGraph, a: number, b: number): number {
  const pa = nav.nodes[a]!.center;
  const pb = nav.nodes[b]!.center;
  return Math.hypot(pa.x - pb.x, pa.z - pb.z);
}

function reconstructPath(came: number[], goal: number): number[] {
  const out: number[] = [goal];
  let cur = goal;

  while (came[cur] !== -1) {
    cur = came[cur]!;
    out.push(cur);
  }

  out.reverse();
  return out;
}

function pickOutsideOfDoorLocal(aRegion: Region, d: Door): [number, number] {
  const mx = (d.hinge[0] + d.end[0]) * 0.5;
  const mz = (d.hinge[1] + d.end[1]) * 0.5;

  const eps = 0.18;

  const vertical = Math.abs(d.hinge[0] - d.end[0]) < 1e-6;
  const c1: [number, number] = vertical ? [mx + eps, mz] : [mx, mz + eps];
  const c2: [number, number] = vertical ? [mx - eps, mz] : [mx, mz - eps];

  const in1 = pointInRegionLocal(c1[0], c1[1], aRegion);
  const in2 = pointInRegionLocal(c2[0], c2[1], aRegion);

  if (in1 && !in2) return c2;
  if (in2 && !in1) return c1;

  // If ambiguous (numeric boundary), prefer c1, but caller will try an alternate too.
  return c1;
}

function pickOutsideOfDoorLocalAlt(d: Door): [number, number] {
  const mx = (d.hinge[0] + d.end[0]) * 0.5;
  const mz = (d.hinge[1] + d.end[1]) * 0.5;

  const eps = 0.18;
  const vertical = Math.abs(d.hinge[0] - d.end[0]) < 1e-6;

  return vertical ? [mx - eps, mz] : [mx, mz - eps];
}

function findPlotRegionIndexContainingLocal(plotRegions: Region[], p: [number, number]): number | null {
  const [x, z] = p;
  for (let i = 0; i < plotRegions.length; i++) {
    const r = plotRegions[i]!;
    if (r.name === "houseregion") continue;
    if (pointInRegionLocal(x, z, r)) return i;
  }
  return null;
}

// ---------------------------
// Spawn planning helpers
// ---------------------------

function buildCandidates(houses: HouseWithModel[]): Candidate[] {
  const out: Candidate[] = [];

  for (const house of houses) {
    for (const region of house.model.firstFloor.regions) {
      // Spawn excludes stairs (per existing behavior) so zombies don't pop on stairwell.
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

// ---------------------------
// Geometry helpers
// ---------------------------

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

function pointInRegionLocal(px: number, pz: number, region: Region): boolean {
  if (region.type === "rectangle") {
    const [[x0, z0], [x1, z1]] = region.points;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minZ = Math.min(z0, z1);
    const maxZ = Math.max(z0, z1);
    return px >= minX - 1e-6 && px <= maxX + 1e-6 && pz >= minZ - 1e-6 && pz <= maxZ + 1e-6;
  }

  return pointInPolygon(px, pz, region.points);
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
