import type { HouseConfig } from "../../../types/config";
import type { FloorModel } from "../types";
import type { HouseGenContext } from "./context";

export function generateSecondFloorModel(
  _house: HouseConfig,
  _ctx: HouseGenContext,
  _plot: FloorModel,
  _firstFloor: FloorModel
): FloorModel {
  return { regions: [], construction: [], objects: [] };
}
