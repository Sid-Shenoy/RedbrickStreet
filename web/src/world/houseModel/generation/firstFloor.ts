import type { HouseConfig } from "../../../types/config";
import type { FloorModel } from "../types";
import type { HouseGenContext } from "./context";

// This is a stub
export function generateFirstFloorModel(_house: HouseConfig, _ctx: HouseGenContext, _plot: FloorModel): FloorModel {
  return { regions: [], construction: [], objects: [] };
}
