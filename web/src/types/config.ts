export interface HouseBounds {
  x: number;
  z: number;
  xsize: number;
  zsize: number; // must be 30
}

export interface HouseConfig {
  houseNumber: number; // 0..29
  occupantCount: number; // original residents pre-takeover (1..5); house 7 must be 1
  bounds: HouseBounds;
}

export interface WeaponConfig {
  id: number;          // 0..N unique
  name: string;        // "SmokeShot" | "SprayShot" | "BlastShot" (folder name under /assets/weapons)
  toEquip: number;     // number key to equip (1 reserved for unarmed)
  fireRate: number;    // shots per second > 0
  shotVolume: number;  // 0..100
  damage: number;      // per-shot damage (not used yet, but loaded)
  crosshair: "small" | "large";
  handHeightVh: number; // viewport-height for the bottom-right weapon image (e.g. 64 or 80)
  clipSize: number;    // shots per magazine > 0 (integer in config)
  capacity: number;    // max ammo player can hold for this weapon >= clipSize (integer in config)
}

