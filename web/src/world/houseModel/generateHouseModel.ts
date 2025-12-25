import type { HouseConfig } from "../../types/config";
import type { HouseModel } from "./types";

import { makeHouseGenContext } from "./generation/context";
import { generatePlotModel } from "./generation/plot";
import { generateFirstFloorModel } from "./generation/firstFloor";
import { generateSecondFloorModel } from "./generation/secondFloor";

/**
 * House generation pipeline:
 * Input: HouseConfig
 * Step 1) Plot
 * Step 2) First floor
 * Step 3) Second floor
 * Output: HouseModel
 */
export function generateHouseModel(house: HouseConfig, streetSeed: string): HouseModel {
  const ctx = makeHouseGenContext(house, streetSeed);

  const plot = generatePlotModel(house, ctx);
  const firstFloor = generateFirstFloorModel(house, ctx, plot);
  const secondFloor = generateSecondFloorModel(house, ctx, plot, firstFloor);

  return {
    seed: ctx.seed,
    plot,
    firstFloor,
    secondFloor,
  };
}
