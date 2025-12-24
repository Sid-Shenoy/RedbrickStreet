export type Gender = "M" | "F";
export type AccentLanguage = "Canadian" | "SouthAsian" | "Chinese" | "African" | "MiddleEastern";

export interface SocialMedia {
  handle: string;
  bio: string;
  followers: number;
  following: number;
}

export interface FamilyInfo {
  spouse: number; // -1 if none
  children: number[];
}

export interface CharacterConfig {
  id: number;
  firstName: string;
  lastName: string;
  gender: Gender;
  accentLanguage: AccentLanguage;
  age: number;
  career: string;
  religion: string;
  family: FamilyInfo;
  personalityTraits: [string, string, string];
  interests: [string, string, string];
  about: [string, string, string, string, string];
  socialMedia: SocialMedia;
}

export interface HouseBounds {
  x: number;
  z: number;
  xsize: number;
  zsize: number; // should be 30
}

export interface HouseConfig {
  houseNumber: number; // 0..29
  surname?: string;     // undefined for house 7 (player home)
  occupants: number[];  // includes player id=0 only in house 7
  bounds: HouseBounds;
}
