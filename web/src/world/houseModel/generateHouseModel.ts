// web/src/world/houseModel/generateHouseModel.ts
import type { HouseConfig } from "../../types/config";
import type { HouseModel } from "./types";

import { makeHouseGenContext } from "./generation/context";
import { generatePlotModel } from "./generation/plot";
import { generateFirstFloorModel } from "./generation/firstFloor";
import { generateSecondFloorModel } from "./generation/secondFloor";
import { generateDoors } from "./generation/doors";

export function generateHouseModel(house: HouseConfig, streetSeed: string): HouseModel {
  const ctx = makeHouseGenContext(house, streetSeed);

  const plot = generatePlotModel(house, ctx);
  const firstFloor = generateFirstFloorModel(house, ctx, plot);
  const secondFloor = generateSecondFloorModel(house, ctx, plot, firstFloor);

  const { firstFloorDoors, secondFloorDoors } = generateDoors(house, ctx, plot, firstFloor, secondFloor);

  return {
    seed: ctx.seed,
    brickTexture: ctx.brickTexture,
    plot: { ...plot, construction: [] }, // required: plot stays empty
    firstFloor: { ...firstFloor, construction: firstFloorDoors },
    secondFloor: { ...secondFloor, construction: secondFloorDoors },
  };
}
