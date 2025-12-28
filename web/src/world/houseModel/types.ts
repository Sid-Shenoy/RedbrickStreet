import type { HouseConfig } from "../../types/config";

export type Surface =
  | "black"
  | "brick"
  | "grass"
  | "concrete_light"
  | "concrete_medium"
  | "concrete_dark"
  | "wood_light"
  | "wood_medium"
  | "wood_dark"
  | "tile_light"
  | "tile_medium"
  | "tile_dark"
  | "void";
export type RegionType = "polygon" | "rectangle";

export type RectPoints = [[number, number], [number, number]];
export type PolyPoints = Array<[number, number]>;

export type Region =
  | { name: string; surface: Surface; type: "rectangle"; points: RectPoints }
  | { name: string; surface: Surface; type: "polygon"; points: PolyPoints };

export interface FloorModel {
  regions: Region[];
  construction: unknown[]; // empty for now (walls/doors/windows/stairs later)
  objects: unknown[]; // empty for now
}

export interface HouseModel {
  seed: string; // for debugging / determinism tracking
  plot: FloorModel;
  firstFloor: FloorModel;
  secondFloor: FloorModel;
}

export type HouseWithModel = HouseConfig & { model: HouseModel };
