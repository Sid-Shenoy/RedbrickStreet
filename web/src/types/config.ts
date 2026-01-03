export interface HouseBounds {
  x: number;
  z: number;
  xsize: number;
  zsize: number; // must be 30
}

export interface HouseConfig {
  houseNumber: number; // 0..29
  occupantCount: number; // original residents pre-takeover (1..5); house 7 must be 1
  bounds: HouseBounds;
}
