import type { HouseConfig } from "../../types/config";
import type { HouseWithModel } from "./types";
import { generateHouseModel } from "./generateHouseModel";

export function attachHouseModel(house: HouseConfig, streetSeed: string): HouseWithModel {
  return {
    ...house,
    model: generateHouseModel(house, streetSeed),
  };
}
