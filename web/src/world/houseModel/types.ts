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

export type BrickTextureFile =
  | "brick_normal.jpg"
  | "brick_golden.jpg"
  | "brick_grey.jpg"
  | "brick_red.jpg"
  | "brick_white.jpg";

export type RectPoints = [[number, number], [number, number]];
export type PolyPoints = Array<[number, number]>;

/**
 * For regions that need extra semantic data.
 * Consumers must feature-detect (meta may be undefined).
 */
export type StairsLeadDir = "+x" | "-x" | "+z" | "-z";

export interface RegionMeta {
  /**
   * Required for name="stairs_opening".
   * Indicates the ONLY side of the opening that is NOT walled on the second floor
   * (i.e., the direction you step from the opening into the upstairs hallway/room).
   */
  stairsLeadDir?: StairsLeadDir;
}

export type Region =
  | { name: string; surface: Surface; type: "rectangle"; points: RectPoints; meta?: RegionMeta }
  | { name: string; surface: Surface; type: "polygon"; points: PolyPoints; meta?: RegionMeta };

export interface FloorModel {
  regions: Region[];
  construction: unknown[]; // empty for now (walls/doors/windows/stairs later)
  objects: unknown[]; // empty for now
}

export interface HouseModel {
  seed: string; // for debugging / determinism tracking

  // Deterministically chosen per-house exterior brick texture (never brick_dark.jpg).
  brickTexture: BrickTextureFile;

  plot: FloorModel;
  firstFloor: FloorModel;
  secondFloor: FloorModel;
}

export type HouseWithModel = HouseConfig & { model: HouseModel };
