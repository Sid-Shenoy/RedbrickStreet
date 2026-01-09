import type { Scene } from "@babylonjs/core";

export interface SuccessOverlayApi {
  trigger(): void;
  dispose(): void;
  isActive(): boolean;
}

function ensureSuccessStyle(): HTMLStyleElement {
  const existing = document.getElementById("rbs_success_style") as HTMLStyleElement | null;
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = "rbs_success_style";
  style.textContent = `
#rbsSuccessRoot {
  position: fixed;
  inset: 0;
  z-index: 9999;

  /* IMPORTANT: block all gameplay clicks/keys once visible */
  pointer-events: auto;
  user-select: none;
}

#rbsSuccessFade {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0);
  opacity: 0;
  transition: opacity 2.4s ease;
}

#rbsSuccessGif {
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

#rbsSuccessGif img {
  display: block;
  width: min(640px, 92vw);
  height: auto;
}

#rbsSuccessCaption {
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

export function createSuccessOverlay(scene: Scene): SuccessOverlayApi {
  ensureSuccessStyle();

  const root = document.createElement("div");
  root.id = "rbsSuccessRoot";
  root.style.display = "none";

  const fade = document.createElement("div");
  fade.id = "rbsSuccessFade";
  root.appendChild(fade);

  const gifWrap = document.createElement("div");
  gifWrap.id = "rbsSuccessGif";

  const img = document.createElement("img");
  img.src = "assets//success-text.gif";
  img.alt = "SUCCESS";
  gifWrap.appendChild(img);

  const caption = document.createElement("div");
  caption.id = "rbsSuccessCaption";
  caption.textContent = "Officer Smith cleared Redbrick Street.";
  gifWrap.appendChild(caption);

  root.appendChild(gifWrap);

  document.body.appendChild(root);

  let active = false;
  let disposed = false;

  // Preload audio; play only on trigger.
  const audio = new Audio("assets//audio/sfx/success.mp3");
  audio.preload = "auto";
  audio.volume = 1.0;

  // Hard input block: capture-phase listeners that prevent the weapon UI from seeing clicks/keys.
  let inputBlocked = false;

  function forceReleaseInputs() {
    // If the player wins while holding the trigger (mouse down),
    // the weapon UI may never receive the corresponding "up" event once we start blocking input.
    // Emit synthetic release events once so any held-to-fire loops can shut down cleanly.
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    const targets: EventTarget[] = [window, document];
    if (canvas) targets.push(canvas);

    for (const t of targets) {
      try {
        if (typeof PointerEvent !== "undefined") {
          t.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
          t.dispatchEvent(
            new PointerEvent("pointercancel", { bubbles: true, cancelable: true, button: 0, buttons: 0 })
          );
        }
      } catch {
        // ignore
      }

      try {
        t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
      } catch {
        // ignore
      }
    }

    try {
      window.dispatchEvent(new Event("blur"));
    } catch {
      // ignore
    }
  }

  const blockEvent = (ev: Event) => {
    // Prevent any gameplay input after success.
    ev.preventDefault();
    ev.stopPropagation();
    // Stop other listeners on the same target too (important if weapon UI listens on window).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ev as any).stopImmediatePropagation?.();
    return false;
  };

  function installInputBlockers() {
    if (inputBlocked) return;
    inputBlocked = true;

    // Mouse / pointer
    window.addEventListener("pointerdown", blockEvent, true);
    window.addEventListener("pointerup", blockEvent, true);
    window.addEventListener("mousedown", blockEvent, true);
    window.addEventListener("mouseup", blockEvent, true);
    window.addEventListener("click", blockEvent, true);

    // Keys (prevents Tab weapon wheel, 1-4 switching, etc.)
    window.addEventListener("keydown", blockEvent, true);
    window.addEventListener("keyup", blockEvent, true);

    // Wheel (some browsers require passive:false to prevent default)
    window.addEventListener("wheel", blockEvent, { capture: true, passive: false });
  }

  function removeInputBlockers() {
    if (!inputBlocked) return;
    inputBlocked = false;

    window.removeEventListener("pointerdown", blockEvent, true);
    window.removeEventListener("pointerup", blockEvent, true);
    window.removeEventListener("mousedown", blockEvent, true);
    window.removeEventListener("mouseup", blockEvent, true);
    window.removeEventListener("click", blockEvent, true);

    window.removeEventListener("keydown", blockEvent, true);
    window.removeEventListener("keyup", blockEvent, true);

    window.removeEventListener("wheel", blockEvent, true);
  }

  function trigger() {
    if (disposed) return;
    if (active) return;
    active = true;

    // Drop pointer lock so the cursor can reappear / no more FPS-look.
    document.exitPointerLock?.();

    // Ensure any held inputs (e.g. holding the trigger) are released in gameplay systems
    // BEFORE we start blocking events.
    forceReleaseInputs();

    // Block all gameplay input immediately.
    installInputBlockers();

    root.style.display = "block";

    // Start at 0 opacity, then transition to 1 on the next frame.
    fade.style.opacity = "0";
    gifWrap.style.opacity = "0";

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

    removeInputBlockers();

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
