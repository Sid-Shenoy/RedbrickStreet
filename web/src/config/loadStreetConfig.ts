import { loadJson } from "./loadJson";
import type { CharacterConfig, HouseConfig } from "../types/config";

export interface StreetConfig {
  characters: CharacterConfig[];
  houses: HouseConfig[];
}

export async function loadStreetConfig(): Promise<StreetConfig> {
  const [characters, houses] = await Promise.all([
    loadJson<CharacterConfig[]>("/config/characters.json"),
    loadJson<HouseConfig[]>("/config/houses.json"),
  ]);
  return { characters, houses };
}
