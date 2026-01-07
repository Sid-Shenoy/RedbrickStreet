import type { Scene } from "@babylonjs/core";
import type { WeaponConfig } from "../types/config";
import { ensureAmbience, setWeaponWheelOpen } from "../audio/ambience";

type WheelOption = {
  key: number; // 1..4
  label: string;
  weapon: WeaponConfig | null; // null => unarmed
  iconImg?: HTMLImageElement;
};

export interface WeaponUiApi {
  dispose(): void;
  getEquipped(): WeaponConfig | null;
  setEquippedByKey(key: number): void; // 1=unarmed, otherwise matches weapons.json toEquip
}

const GUNSHOT_SRC = "/assets/audio/sfx/gunshot.mp3";
const RELOAD_SRC = "/assets/audio/sfx/reload.mp3";

const HOME_REFILL_DIST_M = 3.0;

const WEAPON_WHEEL_SCALE = 1.5;
const WEAPON_WHEEL_CSS_SIZE = 360 * WEAPON_WHEEL_SCALE;
const WEAPON_WHEEL_PANEL_H = 420 * WEAPON_WHEEL_SCALE;
const WEAPON_UI_SCALE = WEAPON_WHEEL_SCALE;

type AmmoState = { clip: number; reserve: number };

function ensureWeaponUiStyle(): HTMLStyleElement {
  const existing = document.getElementById("rbs_weapon_ui_style") as HTMLStyleElement | null;
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = "rbs_weapon_ui_style";
  style.textContent = `
#rbsWeaponHand {
  position: fixed;
  right: 0;
  bottom: 0;
  height: 64vh;     /* default; overridden per-weapon via weapons.json handHeightVh */
  width: auto;
  pointer-events: none;
  user-select: none;
  z-index: 12;
}

#rbsAmmoReadout {
  position: fixed;
  right: ${14 * WEAPON_UI_SCALE}px;
  bottom: ${18 * WEAPON_UI_SCALE}px;
  z-index: 13;
  pointer-events: none;
  user-select: none;

  font-family: "Russo One", sans-serif;
  font-size: ${12 * WEAPON_UI_SCALE}px;
  line-height: 1;
  letter-spacing: 0.06em;
  text-transform: uppercase;

  color: rgba(240,245,255,0.92);
  text-shadow: 0 ${2 * WEAPON_UI_SCALE}px ${12 * WEAPON_UI_SCALE}px rgba(0,0,0,0.55);

  background: rgba(8,10,14,0.46);
  border: ${1 * WEAPON_UI_SCALE}px solid rgba(255,255,255,0.12);
  border-radius: ${12 * WEAPON_UI_SCALE}px;
  padding: ${8 * WEAPON_UI_SCALE}px ${10 * WEAPON_UI_SCALE}px;
  box-shadow: 0 ${10 * WEAPON_UI_SCALE}px ${24 * WEAPON_UI_SCALE}px rgba(0,0,0,0.32);
}

#rbsAmmoReadout.rbsEmpty {
  color: rgba(255,80,80,0.92);
  border-color: rgba(255,80,80,0.26);
}

#rbsHomeReloadNote {
  position: fixed;
  left: 50%;
  bottom: ${22 * WEAPON_UI_SCALE}px;
  transform: translateX(-50%);
  z-index: 14;
  pointer-events: none;
  user-select: none;

  font-family: "Russo One", sans-serif;
  font-size: ${12 * WEAPON_UI_SCALE}px;
  letter-spacing: 0.08em;
  text-transform: uppercase;

  color: rgba(240,245,255,0.90);
  text-shadow: 0 ${2 * WEAPON_UI_SCALE}px ${12 * WEAPON_UI_SCALE}px rgba(0,0,0,0.55);

  background: rgba(8,10,14,0.46);
  border: ${1 * WEAPON_UI_SCALE}px solid rgba(255,255,255,0.12);
  border-radius: ${12 * WEAPON_UI_SCALE}px;
  padding: ${8 * WEAPON_UI_SCALE}px ${12 * WEAPON_UI_SCALE}px;
  box-shadow: 0 ${10 * WEAPON_UI_SCALE}px ${24 * WEAPON_UI_SCALE}px rgba(0,0,0,0.28);
}

#rbsCrosshair {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  user-select: none;
  z-index: 11;
  opacity: 0.92;
}

#rbsWeaponWheelRoot {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: none;
  pointer-events: none;
}

#rbsWeaponWheelRoot.rbsOpen {
  display: block;
  pointer-events: auto;
}

#rbsWeaponWheelBackdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.45);
  backdrop-filter: blur(2px);
}

#rbsWeaponWheelPanel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: ${WEAPON_WHEEL_CSS_SIZE}px;
  height: ${WEAPON_WHEEL_PANEL_H}px;
  display: grid;
  place-items: center;
}

#rbsWeaponWheelCanvas {
  width: ${WEAPON_WHEEL_CSS_SIZE}px;
  height: ${WEAPON_WHEEL_CSS_SIZE}px;
  display: block;
  border-radius: ${999 * WEAPON_WHEEL_SCALE}px;
}

#rbsWeaponWheelHint {
  margin-top: ${10 * WEAPON_WHEEL_SCALE}px;
  font-family: "Russo One", sans-serif;
  font-size: ${12 * WEAPON_WHEEL_SCALE}px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.90);
  text-shadow: 0 2px 10px rgba(0,0,0,0.45);
}

#rbsWeaponIconWrap {
  width: ${62 * WEAPON_UI_SCALE}px;
  height: ${62 * WEAPON_UI_SCALE}px;
  border-radius: ${16 * WEAPON_UI_SCALE}px;
  display: grid;
  place-items: center;
  margin-bottom: ${10 * WEAPON_UI_SCALE}px;

  background: linear-gradient(180deg, rgba(12,14,18,0.78), rgba(8,10,14,0.62));
  border: ${1 * WEAPON_UI_SCALE}px solid rgba(255,255,255,0.14);
  box-shadow:
    0 ${10 * WEAPON_UI_SCALE}px ${28 * WEAPON_UI_SCALE}px rgba(0,0,0,0.40),
    inset 0 ${1 * WEAPON_UI_SCALE}px 0 rgba(255,255,255,0.06);
  backdrop-filter: blur(${7 * WEAPON_UI_SCALE}px);
}

#rbsWeaponIconImg {
  width: ${48 * WEAPON_UI_SCALE}px;
  height: ${48 * WEAPON_UI_SCALE}px;
  object-fit: contain; /* IMPORTANT: icons have different aspect ratios */
  pointer-events: none;
  user-select: none;

  /* light-grey outline (scaled) */
  filter:
    drop-shadow(0px 0 ${1 * WEAPON_UI_SCALE}px rgba(210,210,210,0.6))
    drop-shadow(0px 0 ${1 * WEAPON_UI_SCALE}px rgba(210,210,210,0.6))
    drop-shadow(0px 0 ${1 * WEAPON_UI_SCALE}px rgba(210,210,210,0.6))
    drop-shadow(0px 0 ${1 * WEAPON_UI_SCALE}px rgba(210,210,210,0.6));
}

#rbsWeaponIconFallback {
  width: ${48 * WEAPON_UI_SCALE}px;
  height: ${48 * WEAPON_UI_SCALE}px;
  display: grid;
  place-items: center;
  font-family: "Russo One", sans-serif;
  font-size: ${26 * WEAPON_UI_SCALE}px;
  line-height: 1;
  color: rgba(240,245,255,0.92);
  border-radius: ${12 * WEAPON_UI_SCALE}px;
  background: rgba(255,255,255,0.06);
  border: ${1 * WEAPON_UI_SCALE}px solid rgba(255,255,255,0.14);

  /* light-grey outline for the fallback glyph (scaled) */
  text-shadow:
    ${1 * WEAPON_UI_SCALE}px 0 0 rgba(210,210,210,0.6),
    ${-1 * WEAPON_UI_SCALE}px 0 0 rgba(210,210,210,0.6),
    0 ${1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6),
    0 ${-1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6),
    ${1 * WEAPON_UI_SCALE}px ${1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6),
    ${-1 * WEAPON_UI_SCALE}px ${1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6),
    ${1 * WEAPON_UI_SCALE}px ${-1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6),
    ${-1 * WEAPON_UI_SCALE}px ${-1 * WEAPON_UI_SCALE}px 0 rgba(210,210,210,0.6);
}
`;
  document.head.appendChild(style);
  return style;
}

function weaponGripSrc(w: WeaponConfig) {
  return `/assets/weapons/${w.name}/grip.png`;
}
function weaponPullSrc(w: WeaponConfig) {
  return `/assets/weapons/${w.name}/pull.png`;
}
function weaponFireSrc(w: WeaponConfig) {
  return `/assets/weapons/${w.name}/fire.png`;
}
function weaponIconSrc(w: WeaponConfig) {
  return `/assets/weapons/${w.name}/icon.png`;
}
function crosshairSrc(w: WeaponConfig) {
  return w.crosshair === "large" ? "/assets/weapons/crosshairs/large.svg" : "/assets/weapons/crosshairs/small.svg";
}

function makeGunshotPool(size: number): HTMLAudioElement[] {
  const pool: HTMLAudioElement[] = [];
  for (let i = 0; i < size; i++) {
    const a = new Audio();
    a.src = GUNSHOT_SRC;
    a.preload = "auto";

    // Best-effort: start fetching/validating the source early.
    try {
      a.load();
    } catch {
      // no-op
    }

    pool.push(a);
  }
  return pool;
}

export function createWeaponUi(scene: Scene, canvas: HTMLCanvasElement, weapons: WeaponConfig[]): WeaponUiApi {
  ensureWeaponUiStyle();
  ensureAmbience();

  // Capture "home" once: weapon UI is created after spawn, so active camera is already at home/spawn.
  const homeX = scene.activeCamera?.position.x ?? 0;
  const homeZ = scene.activeCamera?.position.z ?? 0;

  function validateWeaponAmmoFields(w: WeaponConfig) {
    if (!Number.isFinite(w.clipSize) || w.clipSize <= 0 || Math.floor(w.clipSize) !== w.clipSize) {
      throw new Error(`[RBS] weapons.json invalid clipSize for ${w.name}: ${String(w.clipSize)}`);
    }
    if (!Number.isFinite(w.capacity) || w.capacity <= 0 || Math.floor(w.capacity) !== w.capacity) {
      throw new Error(`[RBS] weapons.json invalid capacity for ${w.name}: ${String(w.capacity)}`);
    }
    if (w.capacity < w.clipSize) {
      throw new Error(`[RBS] weapons.json capacity < clipSize for ${w.name}: ${w.capacity} < ${w.clipSize}`);
    }
  }

  // Ammo state per weapon (persists across weapon switching).
  const ammoByWeaponId = new Map<number, AmmoState>();

  function ensureAmmoState(w: WeaponConfig): AmmoState {
    const s = ammoByWeaponId.get(w.id);
    if (s) return s;

    validateWeaponAmmoFields(w);
    const st: AmmoState = { clip: w.clipSize, reserve: w.capacity - w.clipSize };
    ammoByWeaponId.set(w.id, st);
    return st;
  }

  function ammoFullForWeapon(w: WeaponConfig) {
    const st = ensureAmmoState(w);
    st.clip = w.clipSize;
    st.reserve = w.capacity - w.clipSize;
  }

  function isAmmoFullForWeapon(w: WeaponConfig): boolean {
    const st = ensureAmmoState(w);
    return st.clip === w.clipSize && st.reserve === w.capacity - w.clipSize;
  }

  // Initialize ammo for all weapons immediately.
  for (const w of weapons) ensureAmmoState(w);

  // Map by equip key (2..N from weapons.json).
  const byKey = new Map<number, WeaponConfig>();
  for (const w of weapons) byKey.set(w.toEquip, w);

  // Wheel options are fixed: 1 unarmed + the 3 weapons.
  const smoke = weapons.find((w) => w.name === "SmokeShot") ?? null;
  const spray = weapons.find((w) => w.name === "SprayShot") ?? null;
  const blast = weapons.find((w) => w.name === "BlastShot") ?? null;

  const wheelOptions: WheelOption[] = [
    { key: 1, label: "Unarmed", weapon: null },
    { key: 2, label: "SmokeShot", weapon: smoke },
    { key: 3, label: "SprayShot", weapon: spray },
    { key: 4, label: "BlastShot", weapon: blast },
  ];

  function preloadImage(src: string): HTMLImageElement {
    const img = new Image();
    img.src = src;
    void img.decode?.().catch(() => {});
    return img;
  }

  // Preload ALL weapon images (hand frames + icons) up front to prevent first-use stutter.
  const weaponAssetsById = new Map<number, { grip: HTMLImageElement; pull: HTMLImageElement; fire: HTMLImageElement; icon: HTMLImageElement }>();

  for (const w of weapons) {
    weaponAssetsById.set(w.id, {
      grip: preloadImage(weaponGripSrc(w)),
      pull: preloadImage(weaponPullSrc(w)),
      fire: preloadImage(weaponFireSrc(w)),
      icon: preloadImage(weaponIconSrc(w)),
    });
  }

  // Preload both crosshairs (used by different weapons).
  const crosshairSmallImg = preloadImage("/assets/weapons/crosshairs/small.svg");
  const crosshairLargeImg = preloadImage("/assets/weapons/crosshairs/large.svg");

  // Wheel icons reuse the preloaded icon images.
  for (const opt of wheelOptions) {
    if (!opt.weapon) continue;
    const a = weaponAssetsById.get(opt.weapon.id);
    if (a) opt.iconImg = a.icon;
  }

  // --- DOM: weapon hand image (bottom-right) ---
  const handImg = document.createElement("img");
  handImg.id = "rbsWeaponHand";
  handImg.alt = "weapon";
  handImg.style.display = "none";
  document.body.appendChild(handImg);

  // --- DOM: ammo readout (bottom-right, below weapon UI) ---
  const ammoReadout = document.createElement("div");
  ammoReadout.id = "rbsAmmoReadout";
  ammoReadout.style.display = "none";
  ammoReadout.textContent = "";
  document.body.appendChild(ammoReadout);

  const homeReloadNote = document.createElement("div");
  homeReloadNote.id = "rbsHomeReloadNote";
  homeReloadNote.style.display = "none";
  homeReloadNote.textContent = "All weapons were reloaded";
  document.body.appendChild(homeReloadNote);

  function setAmmoReadoutVisible(v: boolean) {
    ammoReadout.style.display = v ? "block" : "none";
  }

  function updateAmmoReadout() {
    if (!equipped) {
      ammoReadout.textContent = "";
      ammoReadout.classList.remove("rbsEmpty");
      setAmmoReadoutVisible(false);
      return;
    }
    const st = ensureAmmoState(equipped);
    const clip = Math.max(0, Math.floor(st.clip));
    const res = Math.max(0, Math.floor(st.reserve));

    const total = clip + res;
    ammoReadout.textContent = `AMMO ${total}/${equipped.capacity} (${clip}/${equipped.clipSize})`;

    if (clip === 0 && res === 0) ammoReadout.classList.add("rbsEmpty");
    else ammoReadout.classList.remove("rbsEmpty");

    setAmmoReadoutVisible(true);
  }

  // --- DOM: crosshair (center) ---
  const crosshairImg = document.createElement("img");
  crosshairImg.id = "rbsCrosshair";
  crosshairImg.alt = "crosshair";
  crosshairImg.style.display = "none";
  // Default size; overwritten per type on equip (small=25px, large=50px).
  crosshairImg.style.width = `${25 * WEAPON_UI_SCALE}px`;
  crosshairImg.style.height = `${25 * WEAPON_UI_SCALE}px`;
  document.body.appendChild(crosshairImg);

  // --- DOM: weapon icon above HUD ---
  const iconWrap = document.createElement("div");
  iconWrap.id = "rbsWeaponIconWrap";

  const iconImg = document.createElement("img");
  iconImg.id = "rbsWeaponIconImg";
  iconImg.alt = "weapon icon";

  const iconFallback = document.createElement("div");
  iconFallback.id = "rbsWeaponIconFallback";
  iconFallback.textContent = "🚫";

  iconWrap.appendChild(iconFallback);

  // Attach above HUD if it exists, otherwise pin bottom-left.
  const hudRoot = document.getElementById("rbsHudRoot");
  if (hudRoot) {
    // Insert as first child so it's ABOVE the existing HUD panel.
    hudRoot.insertBefore(iconWrap, hudRoot.firstChild);
  } else {
    iconWrap.style.position = "fixed";
    iconWrap.style.left = `${14 * WEAPON_UI_SCALE}px`;
    iconWrap.style.bottom = `${260 * WEAPON_UI_SCALE}px`;
    iconWrap.style.zIndex = "10";
    document.body.appendChild(iconWrap);
  }

  // --- DOM: weapon wheel overlay (Tab) ---
  const wheelRoot = document.createElement("div");
  wheelRoot.id = "rbsWeaponWheelRoot";

  const wheelBackdrop = document.createElement("div");
  wheelBackdrop.id = "rbsWeaponWheelBackdrop";

  const wheelPanel = document.createElement("div");
  wheelPanel.id = "rbsWeaponWheelPanel";

  const wheelCanvas = document.createElement("canvas");
  wheelCanvas.id = "rbsWeaponWheelCanvas";

  const wheelHint = document.createElement("div");
  wheelHint.id = "rbsWeaponWheelHint";
  wheelHint.textContent = "Click a segment or press 1–4";

  wheelPanel.appendChild(wheelCanvas);
  wheelPanel.appendChild(wheelHint);

  wheelRoot.appendChild(wheelBackdrop);
  wheelRoot.appendChild(wheelPanel);
  document.body.appendChild(wheelRoot);

  // High-DPI canvas for crisp wheel.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const CSS_SIZE = WEAPON_WHEEL_CSS_SIZE;
  wheelCanvas.width = Math.round(CSS_SIZE * dpr);
  wheelCanvas.height = Math.round(CSS_SIZE * dpr);

  const ctx = wheelCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context for weapon wheel");

  let disposed = false;

  // State
  let wheelOpen = false;
  let hoveredIdx: number | null = null;

  // Equipped weapon (null => unarmed)
  let equipped: WeaponConfig | null = null;

  // Preloaded/decoded frames for the currently equipped weapon (prevents missed frames).
  let equippedFrames: { grip: HTMLImageElement; pull: HTMLImageElement; fire: HTMLImageElement } | null = null;

  // Shooting state (render-loop driven; prevents missed frames)
  let triggerDown = false;

  let shotActive = false;
  let shotPhase: 0 | 1 | 2 | 3 | 4 = 0; // 0 grip, 1 pull, 2 fire, 3 pull, 4 grip
  let phaseStartMs = 0;
  let phaseDurMs = 0;
  let nextShotAtMs = 0;
  let firedThisShot = false;

  // If the equipped clip hits 0 during a held trigger, we queue a reload to start after the shot finishes.
  let reloadQueued = false;
  let reloadInProgress = false;

  // Audio pool for rapid-fire overlap.
  const gunshotPool = makeGunshotPool(10);
  let gunshotIdx = 0;

  // Reload SFX (played once on weapon equip; used for reload too; not used for unarmed).
  const reloadSfx = new Audio(RELOAD_SRC);
  reloadSfx.preload = "auto";
  reloadSfx.volume = 0.2;

  // Weapon-hand recoil (CSS px). Triggered on each shot FIRE frame.
  const RECOIL_PX = 8;
  const RECOIL_SNAP_MS = 40; // hold max recoil briefly (jerky snap)
  const RECOIL_RETURN_MS = 80; // return back to neutral

  let recoilStartMs = 0;
  let recoilActive = false;

  // Equip transition animation (hand dips off-screen, swaps, returns).
  type EquipAnimMode = "none" | "downSwapUp" | "upOnly" | "downOnly";

  const EQUIP_DOWN_MS = 110;
  const EQUIP_UP_MS = 130;

  let equipAnimMode: EquipAnimMode = "none";
  let equipAnimStartMs = 0;
  let equipAnimOffscreenPx = 0;
  let equipAnimTarget: WeaponConfig | null = null;
  let equipAnimSwapDone = false;

  // Additional downward offset applied to the weapon-hand image (px).
  let equipExtraDownPx = 0;

  function easeInQuad(t: number) {
    return t * t;
  }

  function easeOutQuad(t: number) {
    return 1 - (1 - t) * (1 - t);
  }

  function handOffscreenPxForVh(vh: number) {
    return Math.max(200, Math.round(window.innerHeight * (vh / 100) + 120));
  }

  function completeReloadIfNeeded() {
    if (!reloadInProgress) return;
    reloadInProgress = false;

    const wpn = equipped;
    if (!wpn) return;

    const st = ensureAmmoState(wpn);
    const need = Math.max(0, wpn.clipSize - st.clip);
    const take = Math.min(need, st.reserve);

    st.clip += take;
    st.reserve -= take;

    updateAmmoReadout();
  }

  function finishEquipAnim() {
    equipAnimMode = "none";
    equipExtraDownPx = 0;
    equipAnimTarget = null;
    equipAnimSwapDone = false;

    // If the animation was a reload, actually move ammo *after* the reload completes.
    completeReloadIfNeeded();
  }

  function triggerRecoil(nowMs: number) {
    recoilStartMs = nowMs;
    recoilActive = true;
  }

  function playReload() {
    // Reset and play (ignore failures if browser blocks unexpectedly).
    try {
      reloadSfx.pause();
      reloadSfx.currentTime = 0;
      reloadSfx.volume = 0.2;
      void reloadSfx.play();
    } catch {
      // no-op
    }
  }

  function playGunshot(volume01: number) {
    const idx = gunshotIdx;
    const a = gunshotPool[idx]!;
    gunshotIdx = (idx + 1) % gunshotPool.length;

    const vol = Math.max(0, Math.min(1, volume01));

    // If this element ever fell into a "no source" state, reattach the src and reload.
    if (!a.src || a.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
      a.src = GUNSHOT_SRC;
      a.preload = "auto";
      try {
        a.load();
      } catch {
        // no-op
      }
    }

    // Reset and play.
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
      a.volume = vol;
    } catch {
      // no-op
    }

    // IMPORTANT: play() rejects asynchronously; try/catch won't catch it.
    const p = a.play();
    if (p) {
      p.catch(() => {
        // Replace this pool entry with a fresh element and try once more.
        const fresh = new Audio();
        fresh.src = GUNSHOT_SRC;
        fresh.preload = "auto";
        fresh.volume = vol;

        try {
          fresh.load();
        } catch {
          // no-op
        }

        gunshotPool[idx] = fresh;

        void fresh.play().catch(() => {
          // no-op
        });
      });
    }
  }

  function stopFiring() {
    // Hard abort: cancels any in-progress shot immediately (used for equip/blur/etc).
    triggerDown = false;
    shotActive = false;
    firedThisShot = false;
    reloadQueued = false;

    // Reset to grip if still armed.
    if (equipped) setHandFrame("grip");
  }

  function releaseTrigger() {
    // Soft release: stop continuous firing, but ALWAYS let the current shot finish
    // (so quick clicks still produce a shot every time).
    triggerDown = false;
  }

  function shotTimingMs(wpn: WeaponConfig) {
    const periodMs = 1000 / Math.max(0.001, wpn.fireRate);

    // IMPORTANT:
    // If the shot animation lasts longer than the firing period, it caps the fire rate.
    // Keep a tiny safety margin so the next shot can start on time.
    const SAFETY_MS = 2;

    // Keep animation snappy, but NEVER exceed the firing period (minus safety).
    const totalMs = Math.max(1, Math.min(150, periodMs - SAFETY_MS));

    // FIRE frame is longer than the others for visibility.
    const fireMs = Math.max(1, Math.min(totalMs - 1, totalMs * 0.4));
    const otherMs = Math.max(0.001, (totalMs - fireMs) / 4);

    return { periodMs, fireMs, otherMs };
  }

  function startShot(nowMs: number) {
    const wpn = equipped;
    if (!wpn) return;

    const st = ensureAmmoState(wpn);
    if (st.clip <= 0) return;

    // Ensure frames exist (safety)
    if (!equippedFrames) preloadFrames(wpn);

    const { periodMs, otherMs } = shotTimingMs(wpn);

    // Start on grip, then advance by time.
    phaseDurMs = otherMs;

    shotActive = true;
    shotPhase = 0;
    phaseStartMs = nowMs;
    firedThisShot = false;

    setHandFrame("grip");

    // Schedule next shot strictly by fireRate (avoid drift / unintended slowdown).
    const period = periodMs;

    // Advance the cadence clock from its prior "ideal" value, snapping forward if we fell behind.
    if (nextShotAtMs <= 0) nextShotAtMs = nowMs;
    nextShotAtMs += period;
    if (nextShotAtMs < nowMs) nextShotAtMs = nowMs + period;
  }

  function advancePhase(nowMs: number) {
    const wpn = equipped;
    if (!wpn) return;

    const { fireMs, otherMs } = shotTimingMs(wpn);

    function durForPhase(phase: 0 | 1 | 2 | 3 | 4) {
      return phase === 2 ? fireMs : otherMs;
    }

    // Time-based animation (not frame-based) to keep timing stable even if FPS fluctuates.
    let guard = 0;
    while (nowMs - phaseStartMs >= phaseDurMs && guard < 8) {
      phaseStartMs += phaseDurMs;
      guard++;

      if (shotPhase === 4) {
        // End the shot after the final grip has been displayed for its full duration.
        shotActive = false;
        return;
      }

      shotPhase = (shotPhase + 1) as 0 | 1 | 2 | 3 | 4;

      if (shotPhase === 0) setHandFrame("grip");
      else if (shotPhase === 1) setHandFrame("pull");
      else if (shotPhase === 2) {
        setHandFrame("fire");
        if (!firedThisShot) {
          firedThisShot = true;

          const st = ensureAmmoState(wpn);
          if (st.clip > 0) {
            st.clip -= 1;
            if (st.clip < 0) st.clip = 0;
            updateAmmoReadout();

            if (st.clip === 0 && st.reserve > 0) {
              reloadQueued = true;
            }
          }

          triggerRecoil(nowMs);
          playGunshot(Math.max(0, Math.min(1, wpn.shotVolume / 100)));
        }
      } else if (shotPhase === 3) setHandFrame("pull");
      else setHandFrame("grip");

      // Update duration for the *new* phase (so FIRE lasts longer).
      phaseDurMs = durForPhase(shotPhase);
    }
  }

  function setHandVisible(v: boolean) {
    handImg.style.display = v ? "block" : "none";
  }

  function setCrosshairVisible(v: boolean) {
    crosshairImg.style.display = v ? "block" : "none";
  }

  function setWeaponIconUnarmed() {
    iconImg.remove();
    iconFallback.textContent = "🚫";
    if (!iconFallback.isConnected) iconWrap.appendChild(iconFallback);
  }

  function setWeaponIconWeapon(w: WeaponConfig) {
    iconFallback.remove();
    const a = weaponAssetsById.get(w.id);
    iconImg.src = a ? a.icon.src : weaponIconSrc(w);
    if (!iconImg.isConnected) iconWrap.appendChild(iconImg);
  }

  function applyCrosshairForWeapon(w: WeaponConfig) {
    const isLarge = w.crosshair === "large";

    // Use preloaded crosshair images (both are 1:1 aspect ratio).
    crosshairImg.src = isLarge ? crosshairLargeImg.src : crosshairSmallImg.src;

    // Hard pixel sizes:
    // - small: 25x25 px
    // - large: 50x50 px
    const px = isLarge ? 50 * WEAPON_UI_SCALE : 25 * WEAPON_UI_SCALE;
    crosshairImg.style.width = `${px}px`;
    crosshairImg.style.height = `${px}px`;
  }

  function preloadFrames(w: WeaponConfig) {
    const a = weaponAssetsById.get(w.id);
    if (a) {
      equippedFrames = { grip: a.grip, pull: a.pull, fire: a.fire };
      return;
    }

    // Fallback (should not happen): load on demand.
    const grip = preloadImage(weaponGripSrc(w));
    const pull = preloadImage(weaponPullSrc(w));
    const fire = preloadImage(weaponFireSrc(w));
    equippedFrames = { grip, pull, fire };
  }

  function setHandFrame(kind: "grip" | "pull" | "fire") {
    if (!equipped || !equippedFrames) return;
    const img = equippedFrames[kind];
    // Only assign if different to reduce redundant work.
    if (handImg.src !== img.src) handImg.src = img.src;
  }

  function applyEquipImmediate(next: WeaponConfig | null) {
    const prev = equipped;
    const shouldPlayReload = !!next && (!prev || prev.id !== next.id);

    equipped = next;

    if (!equipped) {
      // Unarmed: hide hand and crosshair, show fallback icon.
      equippedFrames = null;
      setHandVisible(false);
      setCrosshairVisible(false);
      setWeaponIconUnarmed();

      setAmmoReadoutVisible(false);
      ammoReadout.textContent = "";
      ammoReadout.classList.remove("rbsEmpty");

      return;
    }

    if (shouldPlayReload) playReload();

    // Equipped weapon: preload frames and show grip, crosshair, icon.
    preloadFrames(equipped);

    handImg.style.height = `${equipped.handHeightVh}vh`;
    setHandFrame("grip");
    setHandVisible(true);

    applyCrosshairForWeapon(equipped);
    setCrosshairVisible(true);

    setWeaponIconWeapon(equipped);

    updateAmmoReadout();
  }

  function requestEquip(next: WeaponConfig | null) {
    // Any equip request immediately stops shooting + resets animation.
    stopFiring();

    // No change => no-op (prevents replaying reload/animation).
    if (equipped && next && equipped.id === next.id) return;
    if (!equipped && !next) return;

    const now = performance.now();

    // Weapon -> weapon: dip down, swap while hidden, return.
    if (equipped && next) {
      equipAnimMode = "downSwapUp";
      equipAnimStartMs = now;
      equipAnimOffscreenPx = handOffscreenPxForVh(equipped.handHeightVh);
      equipAnimTarget = next;
      equipAnimSwapDone = false;
      return;
    }

    // Unarmed -> weapon: spawn hidden, then rise with the new weapon.
    if (!equipped && next) {
      applyEquipImmediate(next);
      equipAnimMode = "upOnly";
      equipAnimStartMs = now;
      equipAnimOffscreenPx = handOffscreenPxForVh(next.handHeightVh);
      equipExtraDownPx = equipAnimOffscreenPx;

      // Force it to start hidden immediately (avoids a 1-frame pop-in before the render-loop runs).
      handImg.style.bottom = `${-48 - equipExtraDownPx}px`;

      equipAnimTarget = null;
      equipAnimSwapDone = true;
      return;
    }

    // Weapon -> unarmed: dip down, then hide.
    if (equipped && !next) {
      equipAnimMode = "downOnly";
      equipAnimStartMs = now;
      equipAnimOffscreenPx = handOffscreenPxForVh(equipped.handHeightVh);
      equipAnimTarget = null;
      equipAnimSwapDone = false;
    }
  }

  function requestReloadCurrentWeapon() {
    if (!equipped) return;
    if (wheelOpen) return;
    if (equipAnimMode !== "none") return;
    if (shotActive) return;

    const wpn = equipped;
    const st = ensureAmmoState(wpn);

    if (st.reserve <= 0) return;
    if (st.clip >= wpn.clipSize) return;

    // Keep triggerDown as-is (holding LMB should continue firing after reload).
    reloadQueued = false;
    reloadInProgress = true;

    // Reset cadence so the next shot can happen immediately after reload completes.
    nextShotAtMs = 0;

    playReload();

    const now = performance.now();

    // Use the exact same animation as weapon switching, but to the same weapon.
    equipAnimMode = "downSwapUp";
    equipAnimStartMs = now;
    equipAnimOffscreenPx = handOffscreenPxForVh(wpn.handHeightVh);
    equipAnimTarget = wpn;
    equipAnimSwapDone = false;
  }

  // Start unarmed.
  applyEquipImmediate(null);

  // Auto-refill ammo at home (within 3m in XZ) for ALL weapons.
  const homeAmmoObs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;

    const cam = scene.activeCamera;
    if (!cam) return;

    const dx = cam.position.x - homeX;
    const dz = cam.position.z - homeZ;

    const atHome = Math.hypot(dx, dz) <= HOME_REFILL_DIST_M;
    homeReloadNote.style.display = atHome ? "block" : "none";
    if (!atHome) return;

    // Only do work if any weapon is not already full.
    let needs = false;
    for (const w of weapons) {
      if (!isAmmoFullForWeapon(w)) {
        needs = true;
        break;
      }
    }
    if (!needs) return;

    // If we refill at home, cancel any pending reload transfers.
    reloadQueued = false;
    reloadInProgress = false;

    for (const w of weapons) ammoFullForWeapon(w);
    updateAmmoReadout();
  });

  // Idle hand bob + recoil (bottom-right).
  // Bob is always negative so the image stays below the screen edge.
  const handBobObs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;
    const ms = performance.now();

    // Equip transition: dip off-screen, swap while hidden, return.
    if (equipAnimMode !== "none") {
      const t = ms - equipAnimStartMs;

      if (equipAnimMode === "downSwapUp") {
        if (t < EQUIP_DOWN_MS) {
          equipExtraDownPx = equipAnimOffscreenPx * easeInQuad(t / EQUIP_DOWN_MS);
        } else {
          if (!equipAnimSwapDone) {
            applyEquipImmediate(equipAnimTarget);
            equipAnimSwapDone = true;

            // If the new weapon has a different hand height, keep it fully hidden while returning.
            if (equipped) equipAnimOffscreenPx = handOffscreenPxForVh(equipped.handHeightVh);
          }

          const u = (t - EQUIP_DOWN_MS) / EQUIP_UP_MS;
          if (u < 1) {
            equipExtraDownPx = equipAnimOffscreenPx * (1 - easeOutQuad(u));
          } else {
            finishEquipAnim();
          }
        }
      } else if (equipAnimMode === "upOnly") {
        const u = t / EQUIP_UP_MS;
        if (u < 1) {
          equipExtraDownPx = equipAnimOffscreenPx * (1 - easeOutQuad(u));
        } else {
          finishEquipAnim();
        }
      } else if (equipAnimMode === "downOnly") {
        if (t < EQUIP_DOWN_MS) {
          equipExtraDownPx = equipAnimOffscreenPx * easeInQuad(t / EQUIP_DOWN_MS);
        } else {
          if (!equipAnimSwapDone) {
            applyEquipImmediate(null);
            equipAnimSwapDone = true;
          }
          finishEquipAnim();
        }
      }
    } else {
      equipExtraDownPx = 0;
    }

    // Disable bob during equip transitions to keep the dip/return crisp.
    const bob = equipAnimMode === "none" ? 4 * Math.sin(ms / 500) : 0;
    const offset = bob - 48 - equipExtraDownPx;
    handImg.style.bottom = `${offset}px`;

    // Fade ammo while weapon is hidden / reloading / switching.
    if (equipped) {
      ammoReadout.style.opacity = equipAnimMode === "none" ? "1" : "0";
    } else {
      ammoReadout.style.opacity = "0";
    }

    // Recoil: snap right, then return to neutral.
    let recoilX = 0;
    if (recoilActive) {
      const t = ms - recoilStartMs;

      if (t <= RECOIL_SNAP_MS) {
        recoilX = RECOIL_PX;
      } else if (t <= RECOIL_SNAP_MS + RECOIL_RETURN_MS) {
        const u = (t - RECOIL_SNAP_MS) / RECOIL_RETURN_MS;
        recoilX = RECOIL_PX * (1 - Math.max(0, Math.min(1, u)));
      } else {
        recoilActive = false;
        recoilX = 0;
      }
    }

    // hand is positioned with `right: 0`; negative right shifts it to the right (offscreen) for recoil.
    handImg.style.right = `${-recoilX}px`;
  });

  function openWheel() {
    wheelOpen = true;
    hoveredIdx = null;
    wheelRoot.classList.add("rbsOpen");
    setWeaponWheelOpen(true);
    document.exitPointerLock?.();
    drawWheel();
  }

  function closeWheel() {
    wheelOpen = false;
    hoveredIdx = null;
    wheelRoot.classList.remove("rbsOpen");
    setWeaponWheelOpen(false);
  }

  function toggleWheel() {
    if (wheelOpen) closeWheel();
    else openWheel();
  }

  function angleDegFromCenter(clientX: number, clientY: number): { r: number; deg: number } {
    const rect = wheelCanvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = clientX - cx;
    const dy = clientY - cy;

    const r = Math.sqrt(dx * dx + dy * dy);

    // 0deg = right, 90deg = down, 180 = left, 270 = up (because y grows downward).
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 360;

    return { r, deg };
  }

  function hoveredSegmentIndex(clientX: number, clientY: number): number | null {
    const { r, deg } = angleDegFromCenter(clientX, clientY);

    const outerR = (CSS_SIZE / 2) * 0.92;
    const innerR = (CSS_SIZE / 2) * 0.34;

    if (r < innerR || r > outerR) return null;

    // Quadrants:
    // Up (225..315) -> idx 0 (Unarmed)
    // Right (315..360, 0..45) -> idx 1 (SmokeShot)
    // Down (45..135) -> idx 2 (SprayShot)
    // Left (135..225) -> idx 3 (BlastShot)
    if (deg >= 225 && deg < 315) return 0;
    if (deg >= 315 || deg < 45) return 1;
    if (deg >= 45 && deg < 135) return 2;
    if (deg >= 135 && deg < 225) return 3;

    return null;
  }

  function drawWheel() {
    const w = wheelCanvas.width;
    const h = wheelCanvas.height;

    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;

    const outerR = (w / 2) * 0.92;
    const innerR = (w / 2) * 0.34;

    // Base background circle.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(8,10,14,0.78)";
    ctx.fill();
    ctx.restore();

    // Segment definitions: centers at 270, 0, 90, 180 degrees (clockwise).
    const centers = [270, 0, 90, 180];

    for (let i = 0; i < 4; i++) {
      const centerDeg = centers[i]!;
      const startDeg = centerDeg - 45;
      const endDeg = centerDeg + 45;

      let start = (startDeg * Math.PI) / 180;
      let end = (endDeg * Math.PI) / 180;
      if (end < start) end += Math.PI * 2;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, start, end, false);
      ctx.closePath();

      const isHover = hoveredIdx === i;

      ctx.fillStyle = isHover ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.05)";
      ctx.fill();

      ctx.strokeStyle = isHover ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.14)";
      ctx.lineWidth = Math.max(1, Math.round(2 * WEAPON_WHEEL_SCALE * dpr));
      ctx.stroke();
      ctx.restore();

      // Icon first, then text below it (weapon name + key). Text is smaller to avoid overlaps.
      const mid = (centerDeg * Math.PI) / 180;
      const ux = Math.cos(mid);
      const uy = Math.sin(mid);

      const opt = wheelOptions[i]!;
      const labelText = `${opt.weapon ? opt.weapon.name : "Unarmed"} (${opt.key})`;

      // Anchor point for this quadrant label stack.
      const labelR = innerR + (outerR - innerR) * 0.60;
      const xTighten = Math.abs(ux) > Math.abs(uy) ? 0.91 : 1.0;
      const ax = cx + ux * labelR * xTighten;
      const ay = cy + uy * labelR;

      // Put the icon above the anchor, then put text below the icon.
      const maxSize = 44 * WEAPON_WHEEL_SCALE * dpr;
      const iconCx = ax;
      const iconCy = ay - 10 * WEAPON_WHEEL_SCALE * dpr;

      // Default text position if there is no icon.
      let textY = ay + 12 * WEAPON_WHEEL_SCALE * dpr;

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(240,245,255,0.92)";

      // Icon (if weapon has one)
      if (opt.weapon && opt.iconImg && opt.iconImg.complete) {
        const iw = opt.iconImg.naturalWidth || maxSize;
        const ih = opt.iconImg.naturalHeight || maxSize;

        const s = Math.min(maxSize / iw, maxSize / ih);
        const dw = iw * s;
        const dh = ih * s;

        // 1px light-grey outline (match #rbsWeaponIconImg CSS drop-shadow).
        const blurPx = Math.max(1, Math.round(1 * WEAPON_WHEEL_SCALE * dpr));

        // Draw once with filter to generate the outline, then draw again with no filter for crispness.
        ctx.filter =
          `drop-shadow(0px 0 ${blurPx}px rgba(210,210,210,0.6)) ` +
          `drop-shadow(0px 0 ${blurPx}px rgba(210,210,210,0.6)) ` +
          `drop-shadow(0px 0 ${blurPx}px rgba(210,210,210,0.6)) ` +
          `drop-shadow(0px 0 ${blurPx}px rgba(210,210,210,0.6))`;

        ctx.drawImage(opt.iconImg, iconCx - dw / 2, iconCy - dh / 2, dw, dh);

        ctx.filter = "none";

        // Actual icon on top.
        ctx.drawImage(opt.iconImg, iconCx - dw / 2, iconCy - dh / 2, dw, dh);

        // Text sits below the drawn icon with a small gap.
        textY = iconCy + dh / 2 + 10 * WEAPON_WHEEL_SCALE * dpr;
      }

      // Smaller label to prevent overlaps.
      ctx.font = `${Math.round(11 * WEAPON_WHEEL_SCALE * dpr)}px "Russo One", sans-serif`;
      ctx.fillText(labelText, ax, textY);

      ctx.restore();
    }

    // Center hole
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(1, Math.round(2 * WEAPON_WHEEL_SCALE * dpr));
    ctx.stroke();
    ctx.restore();
  }

  function beginFiring() {
    if (!equipped) return;
    if (wheelOpen) return;
    if (equipAnimMode !== "none") return;
    if (triggerDown) return;

    const st = ensureAmmoState(equipped);

    triggerDown = true;

    // If clip is empty, force reload (same animation as switching, same weapon).
    if (st.clip <= 0) {
      if (st.reserve > 0) {
        requestReloadCurrentWeapon();
      } else {
        // No ammo at all: do nothing (require re-press later).
        triggerDown = false;
      }
      return;
    }

    // Immediate first shot (no waiting for a timeout).
    startShot(performance.now());
  }

  // Render-loop driver for firing animation + cadence.
  const fireObs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;
    if (!equipped) return;
    if (wheelOpen) return;
    if (equipAnimMode !== "none") return;

    // If we finished a shot and the clip is empty (but reserve exists), reload before trying to fire again.
    if (!shotActive && reloadQueued) {
      requestReloadCurrentWeapon();
      return;
    }

    const now = performance.now();

    // ALWAYS advance an in-progress shot, even if the trigger was released.
    // This guarantees quick clicks still reach the FIRE phase every time.
    if (shotActive) {
      advancePhase(now);
      return;
    }

    // Only start new shots while the trigger is held.
    if (!triggerDown) return;

    const st = ensureAmmoState(equipped);
    if (st.clip <= 0) {
      if (st.reserve > 0) requestReloadCurrentWeapon();
      else triggerDown = false;
      return;
    }

    if (nextShotAtMs <= 0 || now >= nextShotAtMs) startShot(now);
  });

  // --- Input handlers ---

  const onKeyDown = (ev: KeyboardEvent) => {
    if (disposed) return;

    // Tab toggles wheel.
    if (ev.code === "Tab" && !ev.repeat) {
      ev.preventDefault();
      toggleWheel();
      return;
    }

    // Number keys equip regardless of wheel visibility.
    // Digit1..Digit9 + Numpad1..Numpad9
    let n: number | null = null;

    if (ev.code.startsWith("Digit")) n = parseInt(ev.code.slice(5), 10);
    else if (ev.code.startsWith("Numpad")) n = parseInt(ev.code.slice(6), 10);

    if (!n || Number.isNaN(n)) return;
    if (n < 1 || n > 9) return;

    // 1 is always unarmed.
    if (n === 1) {
      requestEquip(null);
      if (wheelOpen) closeWheel();
      return;
    }

    const wpn = byKey.get(n) ?? null;
    if (wpn) {
      requestEquip(wpn);
      if (wheelOpen) closeWheel();
    }
  };

  let firingPointerId: number | null = null;

  const onPointerDown = (ev: PointerEvent) => {
    if (disposed) return;
    if (ev.button !== 0) return; // primary button only
    if (wheelOpen) return;

    // Deduplicate / ignore extra pointers.
    if (firingPointerId !== null) return;
    firingPointerId = ev.pointerId;

    beginFiring();
  };

  const onPointerUp = (ev: PointerEvent) => {
    if (disposed) return;
    if (ev.button !== 0) return;
    if (firingPointerId === null) return;
    if (ev.pointerId !== firingPointerId) return;

    firingPointerId = null;
    releaseTrigger();
  };

  const onPointerCancel = (ev: PointerEvent) => {
    if (disposed) return;
    if (firingPointerId === null) return;
    if (ev.pointerId !== firingPointerId) return;

    firingPointerId = null;
    releaseTrigger();
  };

  const onBlur = () => {
    firingPointerId = null;
    stopFiring();
    closeWheel();
  };

  const onWheelMove = (ev: PointerEvent) => {
    if (!wheelOpen) return;

    const idx = hoveredSegmentIndex(ev.clientX, ev.clientY);
    if (idx !== hoveredIdx) {
      hoveredIdx = idx;
      drawWheel();
    }
  };

  const onWheelClick = (ev: MouseEvent) => {
    if (!wheelOpen) return;

    const idx = hoveredSegmentIndex(ev.clientX, ev.clientY);
    if (idx === null) {
      // Click outside ring closes wheel (no change).
      closeWheel();
      return;
    }

    const opt = wheelOptions[idx]!;
    requestEquip(opt.weapon);
    closeWheel();

    // Don't steal focus. Let player click canvas to re-lock pointer.
    ev.preventDefault();
  };

  // Close wheel if clicking on backdrop (but keep click-to-select on the wheel itself).
  const onBackdropClick = (ev: MouseEvent) => {
    if (!wheelOpen) return;
    closeWheel();
    ev.preventDefault();
  };

  wheelBackdrop.addEventListener("mousedown", onBackdropClick);
  wheelCanvas.addEventListener("pointermove", onWheelMove);
  wheelCanvas.addEventListener("mousedown", onWheelClick);

  window.addEventListener("keydown", onKeyDown);

  // Capture pointer events at the document level so firing works reliably
  // during pointer lock and while other keys are held.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);

  window.addEventListener("blur", onBlur);

  // Redraw if icons finish loading.
  for (const opt of wheelOptions) {
    if (!opt.iconImg) continue;
    opt.iconImg.onload = () => {
      if (wheelOpen) drawWheel();
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;

    setWeaponWheelOpen(false);
    stopFiring();

    scene.onBeforeRenderObservable.remove(fireObs);
    scene.onBeforeRenderObservable.remove(handBobObs);
    scene.onBeforeRenderObservable.remove(homeAmmoObs);

    wheelBackdrop.removeEventListener("mousedown", onBackdropClick);
    wheelCanvas.removeEventListener("pointermove", onWheelMove);
    wheelCanvas.removeEventListener("mousedown", onWheelClick);

    window.removeEventListener("keydown", onKeyDown);

    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);

    window.removeEventListener("blur", onBlur);

    handImg.remove();
    ammoReadout.remove();
    homeReloadNote.remove();
    crosshairImg.remove();
    wheelRoot.remove();

    // Remove icon only if it's still attached where we put it.
    iconWrap.remove();
  }

  scene.onDisposeObservable.add(() => dispose());

  return {
    dispose,
    getEquipped: () => equipped,
    setEquippedByKey: (key: number) => {
      if (key === 1) {
        requestEquip(null);
        closeWheel();
        return;
      }
      const wpn = byKey.get(key) ?? null;
      if (wpn) {
        requestEquip(wpn);
        closeWheel();
      }
    },
  };
}
