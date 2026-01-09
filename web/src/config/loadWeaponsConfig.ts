import { loadJson } from "./loadJson";
import type { WeaponConfig } from "../types/config";

export interface WeaponsConfig {
  weapons: WeaponConfig[];
}

export async function loadWeaponsConfig(): Promise<WeaponsConfig> {
  const weapons = await loadJson<WeaponConfig[]>("config/weapons.json");
  return { weapons };
}
