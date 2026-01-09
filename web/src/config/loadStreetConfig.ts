import { loadJson } from "./loadJson";
import type { HouseConfig } from "../types/config";

export interface StreetConfig {
  houses: HouseConfig[];
}

export async function loadStreetConfig(): Promise<StreetConfig> {
  const houses = await loadJson<HouseConfig[]>("config/houses.json");
  return { houses };
}
