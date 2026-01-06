import type { Scene } from "@babylonjs/core";
import type { WeaponConfig } from "../types/config";

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
  width: 360px;
  height: 420px;
  display: grid;
  place-items: center;
}

#rbsWeaponWheelCanvas {
  width: 360px;
  height: 360px;
  display: block;
  border-radius: 999px;
}

#rbsWeaponWheelHint {
  margin-top: 10px;
  font-family: "Russo One", sans-serif;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.90);
  text-shadow: 0 2px 10px rgba(0,0,0,0.45);
}

#rbsWeaponIconWrap {
  width: 62px;
  height: 62px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  margin-bottom: 10px;

  background: linear-gradient(180deg, rgba(12,14,18,0.78), rgba(8,10,14,0.62));
  border: 1px solid rgba(255,255,255,0.14);
  box-shadow:
    0 10px 28px rgba(0,0,0,0.40),
    inset 0 1px 0 rgba(255,255,255,0.06);
  backdrop-filter: blur(7px);
}

#rbsWeaponIconImg {
  width: 48px;
  height: 48px;
  object-fit: contain; /* IMPORTANT: icons have different aspect ratios */
  pointer-events: none;
  user-select: none;
}

#rbsWeaponIconFallback {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  font-family: "Russo One", sans-serif;
  font-size: 26px;
  line-height: 1;
  color: rgba(240,245,255,0.92);
  border-radius: 12px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.14);
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
  return w.crosshair === "large"
    ? "/assets/weapons/crosshairs/large.svg"
    : "/assets/weapons/crosshairs/small.svg";
}

function makeGunshotPool(size: number): HTMLAudioElement[] {
  const pool: HTMLAudioElement[] = [];
  for (let i = 0; i < size; i++) {
    const a = new Audio(GUNSHOT_SRC);
    a.preload = "auto";
    pool.push(a);
  }
  return pool;
}

export function createWeaponUi(scene: Scene, canvas: HTMLCanvasElement, weapons: WeaponConfig[]): WeaponUiApi {
  ensureWeaponUiStyle();

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
  const weaponAssetsById = new Map<
    number,
    { grip: HTMLImageElement; pull: HTMLImageElement; fire: HTMLImageElement; icon: HTMLImageElement }
  >();

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

  // --- DOM: crosshair (center) ---
  const crosshairImg = document.createElement("img");
  crosshairImg.id = "rbsCrosshair";
  crosshairImg.alt = "crosshair";
  crosshairImg.style.display = "none";
  // Default size; overwritten per type on equip (small=25px, large=50px).
  crosshairImg.style.width = "25px";
  crosshairImg.style.height = "25px";
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
    iconWrap.style.left = "14px";
    iconWrap.style.bottom = "260px";
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
  const CSS_SIZE = 360;
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

  // Audio pool for rapid-fire overlap.
  const gunshotPool = makeGunshotPool(10);
  let gunshotIdx = 0;

  function playGunshot(volume01: number) {
    const a = gunshotPool[gunshotIdx]!;
    gunshotIdx = (gunshotIdx + 1) % gunshotPool.length;

    // Reset and play (ignore failures if browser blocks unexpectedly).
    try {
      a.pause();
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, volume01));
      void a.play();
    } catch {
      // no-op
    }
  }

  function stopFiring() {
    triggerDown = false;
    shotActive = false;
    firedThisShot = false;

    // Reset to grip if still armed.
    if (equipped) setHandFrame("grip");
  }

  function startShot(nowMs: number) {
    const wpn = equipped;
    if (!wpn) return;

    // Ensure frames exist (safety)
    if (!equippedFrames) preloadFrames(wpn);

    const periodMs = 1000 / Math.max(0.001, wpn.fireRate);

    // 4 transitions across the period; enforce a minimum phase duration so each frame appears.
    phaseDurMs = Math.max(1000 / 60, periodMs / 4);

    shotActive = true;
    shotPhase = 0;
    phaseStartMs = nowMs;
    firedThisShot = false;

    setHandFrame("grip");

    // Schedule next shot by fireRate.
    nextShotAtMs = nowMs + periodMs;
  }

  function advancePhase(nowMs: number) {
    const wpn = equipped;
    if (!wpn) return;

    // Advance at most ONE phase per render tick (prevents skipping frames).
    if (nowMs - phaseStartMs < phaseDurMs) return;

    phaseStartMs = nowMs;

    if (shotPhase === 4) {
      // End the shot after grip has been displayed for at least one phase.
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
        playGunshot(Math.max(0, Math.min(1, wpn.shotVolume / 100)));
      }
    } else if (shotPhase === 3) setHandFrame("pull");
    else setHandFrame("grip");
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
    const px = isLarge ? 50 : 25;
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

  function equipWeapon(next: WeaponConfig | null) {
    // Any equip action immediately stops shooting + resets animation.
    stopFiring();

    equipped = next;

    if (!equipped) {
      // Unarmed: hide hand and crosshair, show fallback icon.
      equippedFrames = null;
      setHandVisible(false);
      setCrosshairVisible(false);
      setWeaponIconUnarmed();
      return;
    }

    // Equipped weapon: preload frames and show grip, crosshair, icon.
    preloadFrames(equipped);

    handImg.style.height = `${equipped.handHeightVh}vh`;
    setHandFrame("grip");
    setHandVisible(true);

    applyCrosshairForWeapon(equipped);
    setCrosshairVisible(true);

    setWeaponIconWeapon(equipped);
  }

  // Start unarmed.
  equipWeapon(null);

  // Idle hand bob (bottom-right). Always negative offset so the image stays below the screen edge.
  const handBobObs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;
    const ms = performance.now();
    const offset = (4 * Math.sin(ms / 500)) - 48;
    handImg.style.bottom = `${offset}px`;
  });

  function openWheel() {
    wheelOpen = true;
    hoveredIdx = null;
    wheelRoot.classList.add("rbsOpen");
    document.exitPointerLock?.();
    drawWheel();
  }

  function closeWheel() {
    wheelOpen = false;
    hoveredIdx = null;
    wheelRoot.classList.remove("rbsOpen");
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
      ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
      ctx.stroke();
      ctx.restore();

      // Label + icon.
      const mid = (centerDeg * Math.PI) / 180;
      const labelR = innerR + (outerR - innerR) * 0.62;
      const lx = cx + Math.cos(mid) * labelR;
      const ly = cy + Math.sin(mid) * labelR;

      const opt = wheelOptions[i]!;
      const keyText = `${opt.key}`;
      const labelText = opt.weapon ? opt.weapon.name : "Unarmed";

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(240,245,255,0.92)";
      ctx.font = `${Math.round(13 * dpr)}px "Russo One", sans-serif`;

      // Key number (slightly above)
      ctx.fillText(keyText, lx, ly - 18 * dpr);

      // Weapon name (below)
      ctx.font = `${Math.round(14 * dpr)}px "Russo One", sans-serif`;
      ctx.fillText(labelText, lx, ly + 16 * dpr);

      // Icon (if weapon has one)
      if (opt.weapon && opt.iconImg && opt.iconImg.complete) {
        const iconR = innerR + (outerR - innerR) * 0.40;
        const ix = cx + Math.cos(mid) * iconR;
        const iy = cy + Math.sin(mid) * iconR;

        const maxSize = 44 * dpr;
        const iw = opt.iconImg.naturalWidth || maxSize;
        const ih = opt.iconImg.naturalHeight || maxSize;

        const s = Math.min(maxSize / iw, maxSize / ih);
        const dw = iw * s;
        const dh = ih * s;

        ctx.drawImage(opt.iconImg, ix - dw / 2, iy - dh / 2, dw, dh);
      }

      ctx.restore();
    }

    // Center hole
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
    ctx.stroke();
    ctx.restore();
  }

  function beginFiring() {
    if (!equipped) return;
    if (wheelOpen) return;
    if (triggerDown) return;

    triggerDown = true;

    // Immediate first shot (no waiting for a timeout).
    startShot(performance.now());
  }

  // Render-loop driver for firing animation + cadence.
  const fireObs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;
    if (!triggerDown) return;
    if (!equipped) return;
    if (wheelOpen) return;

    const now = performance.now();

    if (!shotActive) {
      // Start next shot only when cadence allows.
      if (now >= nextShotAtMs) startShot(now);
      return;
    }

    advancePhase(now);
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
      equipWeapon(null);
      if (wheelOpen) closeWheel();
      return;
    }

    const wpn = byKey.get(n) ?? null;
    if (wpn) {
      equipWeapon(wpn);
      if (wheelOpen) closeWheel();
    }
  };

  const onMouseDown = (ev: MouseEvent) => {
    if (disposed) return;
    if (ev.button !== 0) return; // left click only
    if (wheelOpen) return;
    beginFiring();
  };

  const onMouseUp = (ev: MouseEvent) => {
    if (disposed) return;
    if (ev.button !== 0) return;
    stopFiring();
  };

  const onBlur = () => {
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
    equipWeapon(opt.weapon);
    closeWheel();

    // Don’t steal focus. Let player click canvas to re-lock pointer.
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
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
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

    stopFiring();
    scene.onBeforeRenderObservable.remove(fireObs);
    scene.onBeforeRenderObservable.remove(handBobObs);

    wheelBackdrop.removeEventListener("mousedown", onBackdropClick);
    wheelCanvas.removeEventListener("pointermove", onWheelMove);
    wheelCanvas.removeEventListener("mousedown", onWheelClick);

    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("blur", onBlur);

    handImg.remove();
    crosshairImg.remove();
    wheelRoot.remove();

    // Remove icon only if it’s still attached where we put it.
    iconWrap.remove();
  }

  scene.onDisposeObservable.add(() => dispose());

  return {
    dispose,
    getEquipped: () => equipped,
    setEquippedByKey: (key: number) => {
      if (key === 1) {
        equipWeapon(null);
        closeWheel();
        return;
      }
      const wpn = byKey.get(key) ?? null;
      if (wpn) {
        equipWeapon(wpn);
        closeWheel();
      }
    },
  };
}
