import { Scene, UniversalCamera } from "@babylonjs/core";
import type { HouseWithModel, Region, Surface } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";

type XZ = { x: number; z: number };

type MapPoly = {
  points: XZ[];
  fill: string;
  stroke: string;
};

const MAP_METERS_W = 10;
const MAP_METERS_H = 6;

// Keep HUD compact.
const MAP_CSS_W = 200; // px
const MAP_CSS_H = 120; // px (200 * 0.6 = 120)

// Simple gameplay constants for now.
const MAX_HEALTH = 100;
const MAX_STAMINA = 100;

const SPRINT_MULT = 1.75;
const STAMINA_DRAIN_PER_S = 26; // per second while sprinting + moving
const STAMINA_REGEN_PER_S = 16; // per second while not sprinting

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): string {
  const tt = clamp01(t);
  const r = Math.round(lerp(a[0], b[0], tt));
  const g = Math.round(lerp(a[1], b[1], tt));
  const bl = Math.round(lerp(a[2], b[2], tt));
  return `rgb(${r} ${g} ${bl})`;
}

function darkenRgb(rgbCss: string, mul: number): string {
  // rgb(R G B) in our own format
  const m = rgbCss.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/);
  if (!m) return rgbCss;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(m[1]!, 10) * mul)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(m[2]!, 10) * mul)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(m[3]!, 10) * mul)));
  return `rgb(${r} ${g} ${b})`;
}

function surfaceColor(surface: Surface, regionName?: string): { fill: string; stroke: string } {
  // If you want to tweak the minimap palette later, do it here.
  switch (surface) {
    case "grass":
      return { fill: "rgb(55 132 78)", stroke: "rgba(0,0,0,0.35)" };
    case "concrete_light":
      return { fill: "rgb(154 162 170)", stroke: "rgba(0,0,0,0.35)" };
    case "concrete_medium":
      return { fill: "rgb(120 128 135)", stroke: "rgba(0,0,0,0.35)" };
    case "concrete_dark":
      return { fill: "rgb(78 84 90)", stroke: "rgba(0,0,0,0.35)" };
    case "black":
      // Plot houseregion footprint.
      return { fill: regionName === "houseregion" ? "rgb(20 24 30)" : "rgb(16 18 22)", stroke: "rgba(255,255,255,0.06)" };
    case "brick":
      return { fill: "rgb(126 70 64)", stroke: "rgba(0,0,0,0.35)" };
    case "wood_light":
      return { fill: "rgb(168 130 86)", stroke: "rgba(0,0,0,0.35)" };
    case "wood_medium":
      return { fill: "rgb(140 106 70)", stroke: "rgba(0,0,0,0.35)" };
    case "wood_dark":
      return { fill: "rgb(112 83 55)", stroke: "rgba(0,0,0,0.35)" };
    case "tile_light":
      return { fill: "rgb(170 178 190)", stroke: "rgba(0,0,0,0.35)" };
    case "tile_medium":
      return { fill: "rgb(132 142 156)", stroke: "rgba(0,0,0,0.35)" };
    case "tile_dark":
      return { fill: "rgb(92 100 110)", stroke: "rgba(0,0,0,0.35)" };
    case "void":
      return { fill: "rgba(0,0,0,0)", stroke: "rgba(0,0,0,0)" };
    default: {
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}

function rectRegionToWorldPoly(house: HouseWithModel, r: Extract<Region, { type: "rectangle" }>): XZ[] {
  const [[ax, az], [bx, bz]] = r.points;
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz);
  const maxZ = Math.max(az, bz);

  const p0 = lotLocalToWorld(house, minX, minZ);
  const p1 = lotLocalToWorld(house, maxX, minZ);
  const p2 = lotLocalToWorld(house, maxX, maxZ);
  const p3 = lotLocalToWorld(house, minX, maxZ);

  return [
    { x: p0.x, z: p0.z },
    { x: p1.x, z: p1.z },
    { x: p2.x, z: p2.z },
    { x: p3.x, z: p3.z },
  ];
}

function polyRegionToWorldPoly(house: HouseWithModel, r: Extract<Region, { type: "polygon" }>): XZ[] {
  return r.points.map(([lx, lz]) => {
    const p = lotLocalToWorld(house, lx, lz);
    return { x: p.x, z: p.z };
  });
}

function buildMapPolys(houses: HouseWithModel[]): MapPoly[] {
  const polys: MapPoly[] = [];

  // Road (global): x in [0,230], z in [30,40]
  polys.push({
    points: [
      { x: 0, z: 30 },
      { x: 230, z: 30 },
      { x: 230, z: 40 },
      { x: 0, z: 40 },
    ],
    fill: "rgb(44 49 56)",
    stroke: "rgba(255,255,255,0.06)",
  });

  // Plot surfaces for all houses (plot layer regions).
  for (const house of houses) {
    for (const r of house.model.plot.regions) {
      if (r.surface === "void") continue;

      const { fill, stroke } = surfaceColor(r.surface, r.name);

      const points =
        r.type === "rectangle"
          ? rectRegionToWorldPoly(house, r)
          : polyRegionToWorldPoly(house, r);

      polys.push({ points, fill, stroke });
    }
  }

  return polys;
}

function ensureHudStyle(): HTMLStyleElement {
  const existing = document.getElementById("rbs_hud_style") as HTMLStyleElement | null;
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = "rbs_hud_style";
  style.textContent = `
#rbsHudRoot, #rbsHudRoot * {
  font-family: "Russo One", sans-serif !important;
}

#rbsHudRoot {
  position: fixed;
  left: 14px;
  bottom: 14px;
  z-index: 10;
  pointer-events: none;
  user-select: none;
}

#rbsHudPanel {
  width: 200px;
  padding: 10px 10px 12px;
  border-radius: 16px;

  background: linear-gradient(180deg, rgba(12,14,18,0.78), rgba(8,10,14,0.62));
  border: 1px solid rgba(255,255,255,0.14);
  box-shadow:
    0 10px 28px rgba(0,0,0,0.40),
    inset 0 1px 0 rgba(255,255,255,0.06);
  backdrop-filter: blur(7px);

  /* font inherited from #rbsHudRoot */
  color: rgba(240,245,255,0.92);
}

.rbsHudTitle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 11px;
  opacity: 0.9;
}

.rbsChip {
  font-weight: 500;
  font-size: 10px;
  letter-spacing: 0.06em;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}

.rbsMapWrap {
  width: ${MAP_CSS_W}px;
  height: ${MAP_CSS_H}px;
  border-radius: 14px;
  overflow: hidden;

  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.22);
  box-shadow:
    inset 0 0 0 1px rgba(0,0,0,0.20),
    0 6px 16px rgba(0,0,0,0.35);

  position: relative;
  margin-bottom: 10px;
}

.rbsMapCanvas {
  display: block;
  width: ${MAP_CSS_W}px;
  height: ${MAP_CSS_H}px;
}

.rbsScanlines {
  position: absolute;
  inset: 0;
  border-radius: 14px;
  background:
    repeating-linear-gradient(
      to bottom,
      rgba(255,255,255,0.00) 0px,
      rgba(255,255,255,0.00) 3px,
      rgba(255,255,255,0.03) 4px
    );
  opacity: 0.35;
  mix-blend-mode: overlay;
}

.rbsBars {
  display: grid;
  gap: 8px;
}

.rbsBarRow {
  display: grid;
  grid-template-columns: 44px 1fr 54px;
  align-items: center;
  gap: 6px;
}

.rbsLabel {
  font-size: 11px;
  opacity: 0.9;
  letter-spacing: 0.04em;
}

.rbsValue {
  font-size: 12px;
  font-weight: 500;
  text-align: right;
  letter-spacing: 0.03em;
  opacity: 0.95;
}

.rbsBar {
  height: 11px;
  border-radius: 999px;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
  position: relative;
}

.rbsBarFill {
  height: 100%;
  width: 100%;
  border-radius: 999px;
  box-shadow:
    0 0 14px rgba(255,255,255,0.10),
    inset 0 1px 0 rgba(255,255,255,0.18);
}

.rbsBarGloss {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.00));
  opacity: 0.35;
}
`;
  document.head.appendChild(style);
  return style;
}

export function createHud(scene: Scene, camera: UniversalCamera, houses: HouseWithModel[]) {
  ensureHudStyle();

  const root = document.createElement("div");
  root.id = "rbsHudRoot";

  const panel = document.createElement("div");
  panel.id = "rbsHudPanel";
  root.appendChild(panel);

  const mapWrap = document.createElement("div");
  mapWrap.className = "rbsMapWrap";
  panel.appendChild(mapWrap);

  const mapCanvas = document.createElement("canvas");
  mapCanvas.className = "rbsMapCanvas";
  mapWrap.appendChild(mapCanvas);

  const scan = document.createElement("div");
  scan.className = "rbsScanlines";
  mapWrap.appendChild(scan);

  const bars = document.createElement("div");
  bars.className = "rbsBars";
  panel.appendChild(bars);

  function makeBarRow(labelText: string) {
    const row = document.createElement("div");
    row.className = "rbsBarRow";

    const label = document.createElement("div");
    label.className = "rbsLabel";
    label.textContent = labelText;

    const bar = document.createElement("div");
    bar.className = "rbsBar";

    const fill = document.createElement("div");
    fill.className = "rbsBarFill";
    bar.appendChild(fill);

    const gloss = document.createElement("div");
    gloss.className = "rbsBarGloss";
    bar.appendChild(gloss);

    const value = document.createElement("div");
    value.className = "rbsValue";
    value.textContent = "0/0";

    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(value);

    bars.appendChild(row);

    return { fill, value };
  }

  const healthUi = makeBarRow("HEALTH");
  const staminaUi = makeBarRow("SPRINT");

  document.body.appendChild(root);

  // High-DPI canvas setup.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  mapCanvas.width = Math.round(MAP_CSS_W * dpr);
  mapCanvas.height = Math.round(MAP_CSS_H * dpr);

  const ctx = mapCanvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context for HUD minimap canvas");

  const mapPolys = buildMapPolys(houses);

  let disposed = false;

  let health = MAX_HEALTH;
  let stamina = MAX_STAMINA;

  const baseSpeed = camera.speed;

  let shiftDown = false;

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
      shiftDown = true;
    }
  };
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === "ShiftLeft" || ev.code === "ShiftRight") {
      shiftDown = false;
    }
  };
  const onBlur = () => {
    shiftDown = false;
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  function setBar(fillEl: HTMLDivElement, valueEl: HTMLDivElement, value: number, max: number, colorCss: string) {
    const p = max <= 0 ? 0 : clamp01(value / max);
    fillEl.style.width = `${(p * 100).toFixed(2)}%`;
    fillEl.style.background = colorCss;
    valueEl.textContent = `${Math.round(value)}/${Math.round(max)}`;
  }

  function drawMinimap(playerX: number, playerZ: number, yaw: number) {
    const w = mapCanvas.width;
    const h = mapCanvas.height;

    // Background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgb(10 14 18)";
    ctx.fillRect(0, 0, w, h);

    // Subtle grid (pixel space)
    ctx.save();
    ctx.globalAlpha = 0.18;
    const gridStep = Math.round(18 * dpr);
    ctx.lineWidth = Math.max(1, Math.round(1 * dpr));
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (let x = 0; x <= w; x += gridStep) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += gridStep) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // World drawing: player-centered, rotated so "forward" is up.
    const scale = w / MAP_METERS_W; // px per meter (device px)
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, -scale);  // +z goes up
    ctx.rotate(yaw);
    ctx.translate(-playerX, -playerZ);

    // Keep strokes ~1px regardless of zoom.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 1 / scale;

    for (const poly of mapPolys) {
      const pts = poly.points;
      if (pts.length < 3) continue;

      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.z);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.z);
      ctx.closePath();

      ctx.fillStyle = poly.fill;
      ctx.fill();

      ctx.strokeStyle = poly.stroke;
      ctx.stroke();
    }

    ctx.restore();

    // Player arrow (pixel space, centered, always "forward"/up)
    ctx.save();
    ctx.translate(w / 2, h / 2);

    const tip = 10 * dpr;
    const wing = 7 * dpr;
    const tail = 9 * dpr;

    ctx.beginPath();
    ctx.moveTo(0, -tip);
    ctx.lineTo(wing, tail);
    ctx.lineTo(0, tail * 0.55);
    ctx.lineTo(-wing, tail);
    ctx.closePath();

    ctx.fillStyle = "rgb(255 214 102)";
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = Math.max(1, Math.round(2 * dpr));

    ctx.fill();
    ctx.stroke();

    // A tiny core dot for readability
    ctx.beginPath();
    ctx.arc(0, 0, 1.6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();

    ctx.restore();

    // Soft inner vignette
    ctx.save();
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.40)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  const obs = scene.onBeforeRenderObservable.add(() => {
    if (disposed) return;

    const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);

    // Consider the player "moving" when Babylon input is actively pushing the camera.
    const moving = camera.cameraDirection.lengthSquared() > 1e-8;

    // Sprinting is only allowed if stamina is > 3% of max.
    // Holding Shift blocks stamina regen; if Shift is held while moving, stamina continues draining
    // even below the sprint threshold (down to 0).
    const MIN_SPRINT_STAMINA = MAX_STAMINA * 0.03;
    const wantsSprint = shiftDown && moving;
    const sprinting = wantsSprint && stamina > MIN_SPRINT_STAMINA;

    // Stamina update
    if (shiftDown) {
      if (moving) {
        stamina = Math.max(0, stamina - STAMINA_DRAIN_PER_S * dt);
      }
      // No regen while Shift is held (prevents 0% <-> 1% sprint oscillation).
    } else {
      stamina = Math.min(MAX_STAMINA, stamina + STAMINA_REGEN_PER_S * dt);
    }

    // Camera speed update (Shift to sprint; only when stamina > 3%)
    camera.speed = baseSpeed * (sprinting ? SPRINT_MULT : 1.0);

    // Health color: green (full) -> red (low)
    const hpP = clamp01(health / MAX_HEALTH);
    const healthColor = lerpRgb([255, 72, 72], [57, 255, 122], hpP);

    // Stamina color: bright blue (full) -> dark blue (low), and a bit darker while sprinting.
    const spP = clamp01(stamina / MAX_STAMINA);
    let staminaColor = lerpRgb([11, 46, 102], [73, 200, 255], spP);
    if (sprinting) staminaColor = darkenRgb(staminaColor, 0.85);

    setBar(healthUi.fill, healthUi.value, health, MAX_HEALTH, healthColor);
    setBar(staminaUi.fill, staminaUi.value, stamina, MAX_STAMINA, staminaColor);

    // Minimap
    const yaw = camera.rotation.y; // UniversalCamera uses Euler rotation; yaw is rotation.y
    drawMinimap(camera.position.x, camera.position.z, yaw);
  });

  function dispose() {
    if (disposed) return;
    disposed = true;

    scene.onBeforeRenderObservable.remove(obs);

    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);

    root.remove();
  }

  scene.onDisposeObservable.add(() => dispose());

  // Public API (handy later when zombies can damage the player).
  return {
    dispose,
    setHealth: (v: number) => {
      health = Math.max(0, Math.min(MAX_HEALTH, v));
    },
    setStamina: (v: number) => {
      stamina = Math.max(0, Math.min(MAX_STAMINA, v));
    },
    getHealth: () => health,
    getStamina: () => stamina,
  };
}
