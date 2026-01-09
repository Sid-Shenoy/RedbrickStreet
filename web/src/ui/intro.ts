import type { Scene } from "@babylonjs/core";

const START_CONVO_SRC = "assets//audio/dialogue/conversations/start.mp3";
const ADVICE_CONVO_SRC = "assets//audio/dialogue/conversations/advice.mp3";

export interface IntroUiApi {
  waitForStart(): Promise<void>;
  dispose(): void;
}

function ensureIntroStyle(): HTMLStyleElement {
  const existing = document.getElementById("rbs_intro_style") as HTMLStyleElement | null;
  if (existing) return existing;

  const style = document.createElement("style");
  style.id = "rbs_intro_style";
  style.textContent = `
#rbsIntroRoot {
  position: fixed;
  inset: 0;
  z-index: 60;
  pointer-events: auto;
  display: grid;
  place-items: center;
}

#rbsIntroBackdrop {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.62);
}

#rbsIntroPanel {
  position: relative;
  width: min(1230px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: auto;

  border-radius: 27px;
  padding: 33px 33px 27px;

  background: rgba(10,12,16,0.88);
  border: 1.5px solid rgba(255,255,255,0.14);
  box-shadow: 0 27px 90px rgba(0,0,0,0.55);
  backdrop-filter: blur(12px);

  color: rgba(240,245,255,0.92);
  font-family: "Russo One", sans-serif;
}

#rbsIntroTitle {
  margin: 0;
  font-size: 45px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

#rbsIntroSub {
  margin-top: 9px;
  font-size: 19.5px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.78);
}

#rbsIntroLead {
  margin-top: 21px;
  font-size: 22.5px;
  line-height: 1.5;
  color: rgba(240,245,255,0.88);
}

#rbsIntroGrid {
  margin-top: 21px;
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 24px;
}

@media (max-width: 1080px) {
  #rbsIntroGrid { grid-template-columns: 1fr; }
}

#rbsIntroBlock {
  background: rgba(255,255,255,0.05);
  border: 1.5px solid rgba(255,255,255,0.10);
  border-radius: 21px;
  padding: 21px 21px 18px;
}

#rbsIntroH {
  margin: 0 0 15px 0;
  font-size: 19.5px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.84);
}

#rbsIntroList {
  margin: 0;
  padding-left: 27px;
  font-size: 21px;
  line-height: 1.55;
  color: rgba(240,245,255,0.88);
}

#rbsIntroList li { margin: 9px 0; }

.rbsKey {
  display: inline-block;
  padding: 3px 12px;
  border-radius: 15px;
  margin-right: 12px;

  background: rgba(0,0,0,0.35);
  border: 1.5px solid rgba(255,255,255,0.14);

  font-size: 18px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.92);
  box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.06);
}

/* Readability: increase tracking ONLY for the story + controls text (inside the grid blocks). */
#rbsIntroGrid #rbsIntroH {
  letter-spacing: 0.14em;
}

#rbsIntroGrid #rbsIntroList {
  letter-spacing: 0.06em;
}

#rbsIntroGrid .rbsKey {
  letter-spacing: 0.12em;
}

#rbsIntroFooter {
  margin-top: 21px;
  display: flex;
  justify-content: center;
  gap: 15px;
  align-items: center;
  flex-wrap: wrap;

  border-top: 1.5px solid rgba(255,255,255,0.10);
  padding-top: 18px;
}

#rbsIntroStartBtn {
  appearance: none;
  border: 1.5px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: rgba(240,245,255,0.92);
  border-radius: 21px;
  padding: 15px 21px;
  cursor: pointer;

  font-family: "Russo One", sans-serif;
  font-size: 19.5px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  box-shadow: 0 15px 45px rgba(0,0,0,0.35), inset 0 1.5px 0 rgba(255,255,255,0.06);
}

#rbsIntroStartBtn:hover {
  background: rgba(255,255,255,0.14);
}

#rbsIntroStartBtn:active {
  transform: translateY(1px);
}

#rbsIntroStartBtn:focus {
  outline: 3px solid rgba(240,245,255,0.35);
  outline-offset: 3px;
}

#rbsIntroStartBtn .rbsKey {
  margin-right: 0;
  margin-left: 12px;
}
`;
  document.head.appendChild(style);
  return style;
}

function keyLabel(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = "rbsKey";
  s.textContent = text;
  return s;
}

export function createIntroOverlay(scene: Scene): IntroUiApi {
  ensureIntroStyle();

  // Preload the radio conversations.
  // (Start convo is playable via the user gesture; follow-up should be allowed once audio playback is unlocked.)
  const startConvo = new Audio(START_CONVO_SRC);
  startConvo.preload = "auto";
  try {
    startConvo.load();
  } catch {
    // no-op
  }

  const adviceConvo = new Audio(ADVICE_CONVO_SRC);
  adviceConvo.preload = "auto";
  try {
    adviceConvo.load();
  } catch {
    // no-op
  }

  const root = document.createElement("div");
  root.id = "rbsIntroRoot";

  const backdrop = document.createElement("div");
  backdrop.id = "rbsIntroBackdrop";

  const panel = document.createElement("div");
  panel.id = "rbsIntroPanel";

  const title = document.createElement("h1");
  title.id = "rbsIntroTitle";
  title.textContent = "Redbrick Street";

  const sub = document.createElement("div");
  sub.id = "rbsIntroSub";
  sub.textContent = "Briefing: The quarantine";

  const lead = document.createElement("div");
  lead.id = "rbsIntroLead";
  lead.textContent =
    "The street is sealed, backup is unavailable, and the zombies didn't exactly RSVP. Good thing you brought a steady hand.";

  const grid = document.createElement("div");
  grid.id = "rbsIntroGrid";

  const storyBlock = document.createElement("div");
  storyBlock.id = "rbsIntroBlock";

  const storyH = document.createElement("div");
  storyH.id = "rbsIntroH";
  storyH.textContent = "Tonight's situation";

  const storyList = document.createElement("ul");
  storyList.id = "rbsIntroList";

  const storyLines = [
    "You are Officer Steve, first on scene and last one still moving.",
    "You start outside your house. It is your safe point on Redbrick Street.",
    "Zombies have flooded the street and are pouring into the yards.",
    "They cannot climb stairs, so upstairs buys you time when things get ugly.",
    "Clear the street of zombies. No shortcuts, no evac.",
    "Return to your house to reload all weapons when ammo runs dry.",
  ];

  for (const line of storyLines) {
    const li = document.createElement("li");
    li.textContent = line;
    storyList.appendChild(li);
  }

  storyBlock.appendChild(storyH);
  storyBlock.appendChild(storyList);

  const controlsBlock = document.createElement("div");
  controlsBlock.id = "rbsIntroBlock";

  const controlsH = document.createElement("div");
  controlsH.id = "rbsIntroH";
  controlsH.textContent = "Controls";

  const controlsList = document.createElement("ul");
  controlsList.id = "rbsIntroList";

  function addControl(keys: string, action: string) {
    const li = document.createElement("li");
    li.appendChild(keyLabel(keys));
    li.appendChild(document.createTextNode(action));
    controlsList.appendChild(li);
  }

  addControl("Mouse", "Look around");
  addControl("W/A/S/D", "Move");
  addControl("Shift", "Sprint");
  addControl("Space", "Jump (after you start)");
  addControl("Tab", "Weapon wheel");
  addControl("1/2/3/4", "Select weapon slot");
  addControl("Click", "Fire");

  controlsBlock.appendChild(controlsH);
  controlsBlock.appendChild(controlsList);

  grid.appendChild(storyBlock);
  grid.appendChild(controlsBlock);

  const footer = document.createElement("div");
  footer.id = "rbsIntroFooter";

  const startBtn = document.createElement("button");
  startBtn.id = "rbsIntroStartBtn";
  startBtn.type = "button";
  startBtn.appendChild(document.createTextNode("Start mission"));
  startBtn.appendChild(keyLabel("Space"));

  let started = false;
  let adviceTimeout: number | null = null;

  function triggerStart() {
    if (disposed) return;
    if (started) return;
    started = true;

    // Play immediately on the user gesture to avoid autoplay blocking.
    try {
      startConvo.currentTime = 0;
    } catch {
      // no-op
    }
    void startConvo.play().catch(() => {
      // no-op (browser may still block in edge cases)
    });

    // Start convo is 32s long. After it ends, wait a random 8..16s, then play advice.mp3.
    const delayAfterEndS = 8 + Math.random() * 8; // 8..16
    if (adviceTimeout !== null) {
      window.clearTimeout(adviceTimeout);
      adviceTimeout = null;
    }
    adviceTimeout = window.setTimeout(() => {
      adviceTimeout = null;

      try {
        adviceConvo.currentTime = 0;
      } catch {
        // no-op
      }
      void adviceConvo.play().catch(() => {
        // no-op
      });
    }, Math.round((32 + delayAfterEndS) * 1000));

    resolveStart?.();
  }

  const onStartClick = (ev: MouseEvent) => {
    if (disposed) return;
    ev.preventDefault();
    triggerStart();
  };

  startBtn.addEventListener("click", onStartClick);

  footer.appendChild(startBtn);

  panel.appendChild(title);
  panel.appendChild(sub);
  panel.appendChild(lead);
  panel.appendChild(grid);
  panel.appendChild(footer);

  root.appendChild(backdrop);
  root.appendChild(panel);
  document.body.appendChild(root);

  let disposed = false;

  let resolveStart: (() => void) | null = null;
  const startPromise = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });

  const onKeyDown = (ev: KeyboardEvent) => {
    if (disposed) return;
    if (ev.code !== "Space" || ev.repeat) return;
    ev.preventDefault();
    triggerStart();
  };

  window.addEventListener("keydown", onKeyDown);

  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("keydown", onKeyDown);
    startBtn.removeEventListener("click", onStartClick);
    root.remove();
  }

  scene.onDisposeObservable.add(() => {
    if (adviceTimeout !== null) {
      window.clearTimeout(adviceTimeout);
      adviceTimeout = null;
    }

    try {
      startConvo.pause();
    } catch {
      // no-op
    }

    try {
      adviceConvo.pause();
    } catch {
      // no-op
    }

    dispose();
  });

  return {
    waitForStart: async () => {
      await startPromise;
      dispose();
    },
    dispose,
  };
}
