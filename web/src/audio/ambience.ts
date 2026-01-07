type TrackKey = "outdoor" | "weapon-wheel";

const OUTDOOR_SRC = "/assets/audio/ambience/outdoor.mp3";
const WEAPON_WHEEL_SRC = "/assets/audio/ambience/weapon-wheel.mp3";

const TRACK_URL: Record<TrackKey, string> = {
  outdoor: OUTDOOR_SRC,
  "weapon-wheel": WEAPON_WHEEL_SRC,
};

const FADE_S = 0.22;
const MASTER_VOL = 0.5;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

let started = false;
let desired: TrackKey = "outdoor";

const buffers = new Map<TrackKey, Promise<AudioBuffer>>();

type Playing = {
  key: TrackKey;
  src: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number; // ctx.currentTime when the source started
  startOffset: number; // seconds offset used in src.start(...)
  duration: number; // buffer.duration
};

let current: Playing | null = null;

// Remember where each track was when we last switched away,
// so toggling the wheel doesn’t constantly restart from 0.
const savedOffset = new Map<TrackKey, number>();

function getAudioContext(): AudioContext {
  if (ctx) return ctx;

  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
  if (!AC) throw new Error("Web Audio API not supported in this browser");

  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = MASTER_VOL;
  master.connect(ctx.destination);

  return ctx;
}

function loadBuffer(key: TrackKey): Promise<AudioBuffer> {
  const existing = buffers.get(key);
  if (existing) return existing;

  const p = (async () => {
    const ac = getAudioContext();
    const url = TRACK_URL[key];

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ambience track: ${url} (${res.status})`);

    const arr = await res.arrayBuffer();
    return await ac.decodeAudioData(arr);
  })();

  buffers.set(key, p);
  return p;
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function storeCurrentOffset(p: Playing) {
  const ac = getAudioContext();
  const elapsed = ac.currentTime - p.startedAt;
  const pos = (elapsed + p.startOffset) % Math.max(0.001, p.duration);
  savedOffset.set(p.key, pos);
}

async function playTrack(key: TrackKey) {
  const ac = getAudioContext();
  if (!master) return;
  if (!started) return;

  if (current?.key === key) return;

  let buf: AudioBuffer;
  try {
    buf = await loadBuffer(key);
  } catch (err) {
    console.warn("[ambience] could not load track:", key, err);
    return;
  }

  // Fade out previous (and save its position).
  const now = ac.currentTime;
  if (current) {
    storeCurrentOffset(current);
    try {
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueAtTime(current.gain.gain.value, now);
      current.gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      current.src.stop(now + FADE_S + 0.05);
    } catch {
      // ignore
    }
  }

  // Start new with remembered offset (keeps switching feeling continuous).
  const offset = savedOffset.get(key) ?? 0;

  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.connect(master);

  const src = ac.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  // Explicit loop boundaries for clean looping.
  src.loopStart = 0;
  src.loopEnd = buf.duration;
  src.connect(gain);

  // Start immediately at the chosen offset.
  const startOffset = ((offset % buf.duration) + buf.duration) % buf.duration;
  src.start(now, startOffset);

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + FADE_S);

  current = {
    key,
    src,
    gain,
    startedAt: now,
    startOffset,
    duration: buf.duration,
  };
}

async function resumeAndStart() {
  const ac = getAudioContext();

  try {
    if (ac.state !== "running") await ac.resume();
  } catch {
    // ignore
  }

  started = ac.state === "running";
  if (!started) return;

  // Apply the current desired mode.
  void playTrack(desired);
}

let hooked = false;
function hookAutostartOnce() {
  if (hooked) return;
  hooked = true;

  const onFirstGesture = () => {
    window.removeEventListener("pointerdown", onFirstGesture, true);
    window.removeEventListener("keydown", onFirstGesture, true);
    window.removeEventListener("touchstart", onFirstGesture, true);
    void resumeAndStart();
  };

  // Capture = true so we get the earliest possible user gesture.
  window.addEventListener("pointerdown", onFirstGesture, true);
  window.addEventListener("keydown", onFirstGesture, true);
  window.addEventListener("touchstart", onFirstGesture, true);
}

/**
 * Call this once during startup (safe to call multiple times).
 * It prepares the audio system and ensures ambience begins after the first user gesture.
 */
export function ensureAmbience() {
  try {
    getAudioContext();
    hookAutostartOnce();

    // Optional warmup: begin fetching both tracks early to prevent first switch hitch.
    void loadBuffer("outdoor").catch(() => {});
    void loadBuffer("weapon-wheel").catch(() => {});
  } catch (err) {
    console.warn("[ambience] disabled:", err);
  }
}

/**
 * Weapon wheel visibility drives ambience mode.
 * - open => weapon-wheel.mp3
 * - closed => outdoor.mp3
 */
export function setWeaponWheelOpen(isOpen: boolean) {
  desired = isOpen ? "weapon-wheel" : "outdoor";
  if (!started) return;
  void playTrack(desired);
}
