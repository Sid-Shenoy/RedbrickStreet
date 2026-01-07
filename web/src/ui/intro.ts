import type { Scene } from "@babylonjs/core";

const START_CONVO_SRC = "/assets/audio/dialogue/conversations/start.mp3";

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
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow: auto;

  border-radius: 18px;
  padding: 22px 22px 18px;

  background: rgba(10,12,16,0.88);
  border: 1px solid rgba(255,255,255,0.14);
  box-shadow: 0 18px 60px rgba(0,0,0,0.55);
  backdrop-filter: blur(8px);

  color: rgba(240,245,255,0.92);
  font-family: "Russo One", sans-serif;
}

#rbsIntroTitle {
  margin: 0;
  font-size: 30px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

#rbsIntroSub {
  margin-top: 6px;
  font-size: 13px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.78);
}

#rbsIntroLead {
  margin-top: 14px;
  font-size: 15px;
  line-height: 1.5;
  color: rgba(240,245,255,0.88);
}

#rbsIntroGrid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 16px;
}

@media (max-width: 720px) {
  #rbsIntroGrid { grid-template-columns: 1fr; }
}

#rbsIntroBlock {
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 14px;
  padding: 14px 14px 12px;
}

#rbsIntroH {
  margin: 0 0 10px 0;
  font-size: 13px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.84);
}

#rbsIntroList {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
  line-height: 1.55;
  color: rgba(240,245,255,0.88);
}

#rbsIntroList li { margin: 6px 0; }

.rbsKey {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  margin-right: 8px;

  background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,255,255,0.14);

  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(240,245,255,0.92);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
}

#rbsIntroFooter {
  margin-top: 14px;
  display: flex;
  justify-content: center;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;

  border-top: 1px solid rgba(255,255,255,0.10);
  padding-top: 12px;
}

#rbsIntroStartBtn {
  appearance: none;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: rgba(240,245,255,0.92);
  border-radius: 14px;
  padding: 10px 14px;
  cursor: pointer;

  font-family: "Russo One", sans-serif;
  font-size: 13px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06);
}

#rbsIntroStartBtn:hover {
  background: rgba(255,255,255,0.14);
}

#rbsIntroStartBtn:active {
  transform: translateY(1px);
}

#rbsIntroStartBtn:focus {
  outline: 2px solid rgba(240,245,255,0.35);
  outline-offset: 2px;
}

#rbsIntroStartBtn .rbsKey {
  margin-right: 0;
  margin-left: 8px;
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

  // Preload the start-of-game radio conversation (playable via user gesture).
  const startConvo = new Audio(START_CONVO_SRC);
  startConvo.preload = "auto";
  try {
    startConvo.load();
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
  storyH.textContent = "Tonight’s situation";

  const storyList = document.createElement("ul");
  storyList.id = "rbsIntroList";

  const storyLines = [
    "You are Officer Steve, first on scene and last one still moving.",
    "You start outside your house. It is your safe point on Redbrick Street.",
    "Zombies have flooded the road and poured into the yards.",
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

  scene.onDisposeObservable.add(() => dispose());

  return {
    waitForStart: async () => {
      await startPromise;
      dispose();
    },
    dispose,
  };
}
