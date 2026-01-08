import type { Scene } from "@babylonjs/core";

export interface WastedOverlayApi {
  trigger(): void;
  dispose(): void;
  isActive(): boolean;
}

function ensureWastedStyle(): HTMLStyleElement {
  const existing = document.getElementById("rbs_wasted_style") as HTMLStyleElement | null;
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = "rbs_wasted_style";
  style.textContent = `
#rbsWastedRoot {
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  user-select: none;
}

#rbsWastedFade {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0);
  opacity: 0;
  transition: opacity 2.4s ease;
}

#rbsWastedGif {
  position: absolute;
  left: 50%;
  top: 46%;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 2.4s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  image-rendering: auto;
}

#rbsWastedGif img {
  display: block;
  width: min(640px, 92vw);
  height: auto;
}

#rbsWastedCaption {
  width: min(760px, 92vw);
  text-align: center;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  font-size: clamp(16px, 2.2vw, 22px);
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.75);
}
`;
  document.head.appendChild(style);
  return style;
}

export function createWastedOverlay(scene: Scene): WastedOverlayApi {
  ensureWastedStyle();

  const root = document.createElement("div");
  root.id = "rbsWastedRoot";
  root.style.display = "none";

  const fade = document.createElement("div");
  fade.id = "rbsWastedFade";
  root.appendChild(fade);

  const gifWrap = document.createElement("div");
  gifWrap.id = "rbsWastedGif";

  const img = document.createElement("img");
  img.src = "/assets/wasted-text.gif";
  img.alt = "WASTED";
  gifWrap.appendChild(img);

  const caption = document.createElement("div");
  caption.id = "rbsWastedCaption";
  caption.textContent = "Officer Steve was killed by a zombie.";
  gifWrap.appendChild(caption);

  root.appendChild(gifWrap);

  document.body.appendChild(root);

  let active = false;
  let disposed = false;

  // Preload audio; play only on trigger.
  const audio = new Audio("/assets/audio/sfx/wasted.mp3");
  audio.preload = "auto";
  audio.volume = 1.0;

  function trigger() {
    if (disposed) return;
    if (active) return;
    active = true;

    root.style.display = "block";

    // Start at 0 opacity, then transition to 1 on the next frame.
    fade.style.opacity = "0";
    gifWrap.style.opacity = "0";

    // Ensure transitions kick in.
    requestAnimationFrame(() => {
      fade.style.opacity = "1";
      gifWrap.style.opacity = "1";
    });

    // Play sound once (ignore autoplay errors silently).
    void audio.play().catch(() => {});
  }

  function dispose() {
    if (disposed) return;
    disposed = true;

    audio.pause();
    audio.currentTime = 0;

    root.remove();
  }

  scene.onDisposeObservable.add(() => dispose());

  return {
    trigger,
    dispose,
    isActive: () => active,
  };
}
