import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region } from "../types";
import type { HouseGenContext } from "./context";

const EPS = 1e-4;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function approx(a: number, b: number, eps = EPS) {
  return Math.abs(a - b) <= eps;
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function rect(name: string, surface: Region["surface"], x0: number, z0: number, x1: number, z1: number): Region {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minZ = Math.min(z0, z1);
  const maxZ = Math.max(z0, z1);
  return { name, surface, type: "rectangle", points: [[minX, minZ], [maxX, maxZ]] };
}

function poly(name: string, surface: Region["surface"], pts: Array<[number, number]>): Region {
  // Close if needed
  if (pts.length >= 3) {
    const [fx, fz] = pts[0]!;
    const [lx, lz] = pts[pts.length - 1]!;
    if (!approx(fx, lx) || !approx(fz, lz)) pts = [...pts, [fx, fz]];
  }
  return { name, surface, type: "polygon", points: pts };
}

function getRegion(plot: FloorModel, name: string): Region {
  const r = plot.regions.find((x) => x.name === name);
  if (!r) throw new Error(`Plot is missing required region '${name}'`);
  return r;
}

function rectBounds(r: Extract<Region, { type: "rectangle" }>) {
  const [[x0, z0], [x1, z1]] = r.points;
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) };
}

function polyPoints(r: Extract<Region, { type: "polygon" }>) {
  return r.points;
}

function minOf<T>(arr: readonly T[], f: (t: T) => number): number {
  let m = Infinity;
  for (const a of arr) m = Math.min(m, f(a));
  return m;
}
function maxOf<T>(arr: readonly T[], f: (t: T) => number): number {
  let m = -Infinity;
  for (const a of arr) m = Math.max(m, f(a));
  return m;
}

type DriveSide = "left" | "right";

export function generateFirstFloorModel(house: HouseConfig, ctx: HouseGenContext, plot: FloorModel): FloorModel {
  const { rng, xsize } = ctx;

  const rHouse = getRegion(plot, "houseregion");
  const rDrive = getRegion(plot, "neardriveway");
  const rWalk = getRegion(plot, "walkway");

  assert(rHouse.type === "polygon", "Plot 'houseregion' must be a polygon");
  assert(rDrive.type === "rectangle", "Plot 'neardriveway' must be a rectangle");
  assert(rWalk.type === "rectangle", "Plot 'walkway' must be a rectangle");

  const drive = rectBounds(rDrive);
  const walk = rectBounds(rWalk);

  // Determine driveway side by where the driveway rectangle sits in lot-local X.
  const drivewaySide: DriveSide = drive.x0 <= 0.25 ? "left" : "right";

  // Parse houseregion footprint characteristics (main back/front, bump front, optional rear extension)
  const hp = polyPoints(rHouse);

  const zBackExt = minOf(hp, ([, z]) => z);
  const zFrontBump = maxOf(hp, ([, z]) => z);

  // Main back/front (where polygon touches the full-width sides x==0 or x==xsize)
  const edgeSidePts = hp.filter(([x]) => approx(x, 0) || approx(x, xsize));
  assert(edgeSidePts.length >= 2, `House ${house.houseNumber}: houseregion polygon lacks side-edge anchors`);

  const zBackMain = minOf(edgeSidePts, ([, z]) => z);
  const zFrontMain = maxOf(edgeSidePts, ([, z]) => z);

  assert(zFrontMain > zBackMain + 8.0, `House ${house.houseNumber}: houseregion main depth too small`);
  assert(zFrontBump >= zFrontMain, `House ${house.houseNumber}: houseregion bump front < main front`);

  // Rear extension notch (if any): points at zBackExt define notch x-range
  const hasRearExt = zBackExt < zBackMain - 0.2;
  let notchX0 = 0;
  let notchX1 = 0;
  if (hasRearExt) {
    const extPts = hp.filter(([, z]) => approx(z, zBackExt));
    if (extPts.length >= 2) {
      notchX0 = minOf(extPts, ([x]) => x);
      notchX1 = maxOf(extPts, ([x]) => x);
    }
  }

  // Front bump rectangle x-span depends on driveway side; use houseregion points at zFrontBump.
  const bumpPts = hp.filter(([, z]) => approx(z, zFrontBump));
  assert(bumpPts.length >= 2, `House ${house.houseNumber}: could not infer bump x-span`);

  let bumpX0 = 0;
  let bumpX1 = 0;

  if (drivewaySide === "left") {
    // driveway inner edge is drive.x1; bump goes from that to the max x at the bump front
    bumpX0 = drive.x1;
    bumpX1 = maxOf(bumpPts, ([x]) => x);
  } else {
    // driveway inner edge is drive.x0; bump goes from the min x at the bump front to drive.x0
    bumpX1 = drive.x0;
    bumpX0 = minOf(bumpPts, ([x]) => x);
  }

  bumpX0 = clamp(bumpX0, 0, xsize);
  bumpX1 = clamp(bumpX1, 0, xsize);
  if (bumpX1 < bumpX0) [bumpX0, bumpX1] = [bumpX1, bumpX0];

  // --- Choose a realistic, deterministic first-floor layout.

  // Garage width: typically a bit wider than driveway; constrained by lot.
  const drivewayW = drive.x1 - drive.x0;
  const garageW = clamp(drivewayW + rng.float(0.6, 1.4), 3.2, Math.min(xsize * 0.58, xsize - 4.6));

  const xGarage0 = drivewaySide === "left" ? 0 : xsize - garageW;
  const xGarage1 = drivewaySide === "left" ? garageW : xsize;

  // Remaining “main interior” slab (everything not in garage strip)
  const xB0 = drivewaySide === "left" ? xGarage1 : 0;
  const xB1 = drivewaySide === "left" ? xsize : xGarage0;
  const interiorW = xB1 - xB0;
  assert(interiorW >= 4.2, `House ${house.houseNumber}: insufficient interior width after garage`);

  // Split interior slab into a near-garage “core block” and a far-side “public block”
  const blockW = clamp(rng.float(4.0, 5.6), 3.6, Math.min(6.0, interiorW - 3.2));
  const xBlock0 = drivewaySide === "left" ? xB0 : xB1 - blockW;
  const xBlock1 = drivewaySide === "left" ? xB0 + blockW : xB1;

  const xFar0 = drivewaySide === "left" ? xBlock1 : xB0;
  const xFar1 = drivewaySide === "left" ? xB1 : xBlock0;
  assert(xFar1 - xFar0 >= 3.0, `House ${house.houseNumber}: insufficient public-space width`);

  // Within the core block, reserve a narrow hallway strip adjacent to the garage side.
  const hallW = clamp(rng.float(1.2, 1.6), 1.1, Math.min(1.8, blockW - 1.8));
  const xHall0 = drivewaySide === "left" ? xBlock0 : xBlock1 - hallW;
  const xHall1 = drivewaySide === "left" ? xBlock0 + hallW : xBlock1;

  // Core remainder (stairs + powder room + landing)
  const xCore0 = drivewaySide === "left" ? xHall1 : xBlock0;
  const xCore1 = drivewaySide === "left" ? xBlock1 : xHall0;
  assert(xCore1 - xCore0 >= 1.6, `House ${house.houseNumber}: core remainder too narrow`);

  // Z splits: kitchen (rear), dining (mid), living (front)
  const totalDepth = zFrontMain - zBackMain;

  let kitchenDepth = clamp(rng.float(4.8, 6.4), 4.2, Math.max(4.2, totalDepth - 7.6));
  let zKitchenSplit = zBackMain + kitchenDepth;

  let diningDepth = clamp(rng.float(3.0, 4.2), 2.6, Math.max(2.6, totalDepth - kitchenDepth - 4.2));
  let zDiningSplit = zKitchenSplit + diningDepth;

  // Ensure living has at least ~4m depth (typical)
  const minLivingDepth = 4.0;
  if (zFrontMain - zDiningSplit < minLivingDepth) {
    zDiningSplit = zFrontMain - minLivingDepth;
  }
  if (zDiningSplit <= zKitchenSplit + 2.2) {
    // force at least some dining depth
    zDiningSplit = zKitchenSplit + 2.6;
  }
  assert(zDiningSplit < zFrontMain - 0.8, `House ${house.houseNumber}: invalid z splits`);

  // Garage depth and service partition behind it
  const garageDepth = clamp(rng.float(6.0, 7.5), 5.5, Math.max(5.5, totalDepth - 2.0));
  let zGarageBack = zFrontMain - garageDepth;
  zGarageBack = clamp(zGarageBack, zBackMain + 2.2, zFrontMain - 4.8);

  // Mudroom depth (front of service zone) and the remaining service zone (laundry/utility)
  const mudDepth = clamp(rng.float(2.0, 2.8), 1.8, Math.max(1.8, zGarageBack - (zBackMain + 1.6)));
  const zMudBack = clamp(zGarageBack - mudDepth, zBackMain + 1.2, zGarageBack - 1.0);

  // Core block: stairs + half bath + hallway landing
  const bathDepth = clamp(rng.float(1.8, 2.4), 1.6, 2.8);
  const zBathBack = zFrontMain - bathDepth;

  let stairLen = clamp(rng.float(3.1, 3.7), 2.8, 4.0);
  const zStairBack = zDiningSplit; // start stairs at the living/dining boundary (typical)
  let zStairFront = zStairBack + stairLen;

  // Ensure space remains for a landing zone between stairs and bath
  const minLanding = 0.7;
  if (zStairFront > zBathBack - minLanding) {
    zStairFront = zBathBack - minLanding;
    stairLen = zStairFront - zStairBack;
  }
  assert(stairLen >= 2.6, `House ${house.houseNumber}: stairs too short after adjustments`);

  const zLandingBack = zStairFront;
  const zLandingFront = zBathBack;

  // --- Optional rooms (2–3)
  // Always: mudroom + (laundry OR utility). Sometimes: pantry OR office as the third.
  const includeLaundry = rng.bool(0.65);
  const includeUtility = !includeLaundry;
  const includePantry = rng.bool(house.occupants.length >= 3 ? 0.55 : 0.35);
  const includeOffice = !includePantry && rng.bool(0.45); // only one of pantry/office as 3rd optional

  // Pantry (if selected): small closet-like room at a dining corner adjacent to kitchen
  let pantry: Region | null = null;
  if (includePantry) {
    const pantryW = clamp(rng.float(1.6, 2.4), 1.4, Math.min(2.8, blockW));
    const pantryD = clamp(rng.float(1.2, 1.8), 1.0, Math.max(1.0, (zDiningSplit - zKitchenSplit) - 0.2));

    const px0 = drivewaySide === "left" ? xBlock0 : xBlock1 - pantryW;
    const px1 = drivewaySide === "left" ? xBlock0 + pantryW : xBlock1;
    const pz0 = zKitchenSplit;
    const pz1 = Math.min(zKitchenSplit + pantryD, zDiningSplit - 0.1);

    if (pz1 - pz0 >= 0.8) {
      pantry = rect("pantry", "tile", px0, pz0, px1, pz1);
    }
  }

  // --- Bump band (front protrusion): foyer + (office OR living bay)
  // The foyer must align to the walkway and meet the main interior at zFrontMain.
  let xFoyer0 = 0;
  let xFoyer1 = 0;

  if (drivewaySide === "left") {
    // anchor foyer at the driveway-adjacent side of bump, but allow it to cover porch-in-front-of-garage too
    xFoyer0 = bumpX0;
    const target = walk.x1 + rng.float(0.2, 0.7);
    xFoyer1 = clamp(target, xFoyer0 + 1.0, bumpX1);
  } else {
    xFoyer1 = bumpX1;
    const target = walk.x0 - rng.float(0.2, 0.7);
    xFoyer0 = clamp(target, bumpX0, xFoyer1 - 1.0);
  }

  // keep foyer “reasonable”
  if (xFoyer1 - xFoyer0 > 2.9) {
    if (drivewaySide === "left") xFoyer1 = xFoyer0 + 2.9;
    else xFoyer0 = xFoyer1 - 2.9;
  }

  // remaining bump band area becomes either office OR living bay; ensure no gaps
  let bumpRem0 = drivewaySide === "left" ? xFoyer1 : bumpX0;
  let bumpRem1 = drivewaySide === "left" ? bumpX1 : xFoyer0;

  if (bumpRem1 < bumpRem0) [bumpRem0, bumpRem1] = [bumpRem1, bumpRem0];

  // If remainder is too small, just let foyer take the whole bump span
  if (bumpRem1 - bumpRem0 < 0.6) {
    xFoyer0 = bumpX0;
    xFoyer1 = bumpX1;
    bumpRem0 = bumpRem1 = 0;
  }

  const foyerRegion = rect("foyer", "tile", xFoyer0, zFrontMain, xFoyer1, zFrontBump);

  let office: Region | null = null;
  let livingBay: { x0: number; x1: number } | null = null;

  if (bumpRem1 - bumpRem0 >= 0.8) {
    if (includeOffice) {
      office = rect("office", "wood", bumpRem0, zFrontMain, bumpRem1, zFrontBump);
    } else {
      livingBay = { x0: bumpRem0, x1: bumpRem1 };
    }
  }

  // --- Required rooms + service rooms (all within houseregion)
  const regions: Region[] = [];

  // GARAGE strip partition
  const garage = rect("garage", "concrete_dark", xGarage0, zGarageBack, xGarage1, zFrontMain);

  // service zone behind garage: mudroom + (laundry or utility)
  const mudroom = rect("mudroom", "tile", xGarage0, zMudBack, xGarage1, zGarageBack);

  // Laundry/utility base (zBackMain..zMudBack), possibly with rear extension overlap
  let serviceBase: Region = rect(includeLaundry ? "laundry" : "utility", "tile", xGarage0, zBackMain, xGarage1, zMudBack);

  // KITCHEN base (interior slab) + possible rear extension overlap on interior side
  let kitchenBase: Region = rect("kitchen", "tile", xB0, zBackMain, xB1, zKitchenSplit);

  // Rear extension handling:
  // Split the rear extension band across:
  // - the interior slab (kitchen), and/or
  // - the garage/service strip (laundry/utility),
  // depending on where the notch actually sits.
  if (hasRearExt && notchX1 - notchX0 >= 0.8) {
    const extZ0 = zBackExt;
    const extZ1 = zBackMain;

    // Portion under interior slab -> kitchen
    const kx0 = clamp(Math.max(notchX0, xB0), xB0, xB1);
    const kx1 = clamp(Math.min(notchX1, xB1), xB0, xB1);
    if (kx1 - kx0 >= 0.4) {
      // kitchen becomes a polygon: base rect + rear “tongue”
      kitchenBase = poly("kitchen", "tile", [
        [xB0, zBackMain],
        [kx0, zBackMain],
        [kx0, extZ0],
        [kx1, extZ0],
        [kx1, zBackMain],
        [xB1, zBackMain],
        [xB1, zKitchenSplit],
        [xB0, zKitchenSplit],
      ]);
    }

    // Portion under garage strip -> service room (laundry/utility)
    const sx0 = clamp(Math.max(notchX0, xGarage0), xGarage0, xGarage1);
    const sx1 = clamp(Math.min(notchX1, xGarage1), xGarage0, xGarage1);
    if (sx1 - sx0 >= 0.4) {
      serviceBase = poly(serviceBase.name, "tile", [
        [xGarage0, zBackMain],
        [sx0, zBackMain],
        [sx0, extZ0],
        [sx1, extZ0],
        [sx1, zBackMain],
        [xGarage1, zBackMain],
        [xGarage1, zMudBack],
        [xGarage0, zMudBack],
      ]);
    }
  }

  // DINING: full interior slab in dining band, possibly with a pantry cutout at the lower corner.
  let diningRegion: Region;
  if (!pantry) {
    diningRegion = rect("dining", "wood", xB0, zKitchenSplit, xB1, zDiningSplit);
  } else {
    const pb = rectBounds(pantry as Extract<Region, { type: "rectangle" }>);
    if (drivewaySide === "left") {
      // pantry occupies lower-left corner of dining band
      diningRegion = poly("dining", "wood", [
        [xB0, pb.z1],
        [xB0, zDiningSplit],
        [xB1, zDiningSplit],
        [xB1, zKitchenSplit],
        [pb.x1, zKitchenSplit],
        [pb.x1, pb.z1],
      ]);
    } else {
      // pantry occupies lower-right corner of dining band
      diningRegion = poly("dining", "wood", [
        [xB0, zKitchenSplit],
        [xB0, zDiningSplit],
        [xB1, zDiningSplit],
        [xB1, pb.z1],
        [pb.x0, pb.z1],
        [pb.x0, zKitchenSplit],
      ]);
    }
  }

  // LIVING: far-side block only (keeps layout clean), plus optional bay bump (if office not used).
  let livingRegion: Region = rect("livingroom", "wood", xFar0, zDiningSplit, xFar1, zFrontMain);

  if (livingBay) {
    // Add bay only if it actually overlaps the far-side block (keeps it connected)
    const bx0 = clamp(livingBay.x0, xFar0, xFar1);
    const bx1 = clamp(livingBay.x1, xFar0, xFar1);
    if (bx1 - bx0 >= 0.6 && zFrontBump > zFrontMain + 0.4) {
      if (drivewaySide === "left") {
        livingRegion = poly("livingroom", "wood", [
          [xFar0, zDiningSplit],
          [xFar1, zDiningSplit],
          [xFar1, zFrontMain],
          [bx1, zFrontMain],
          [bx1, zFrontBump],
          [bx0, zFrontBump],
          [bx0, zFrontMain],
          [xFar0, zFrontMain],
        ]);
      } else {
        livingRegion = poly("livingroom", "wood", [
          [xFar0, zDiningSplit],
          [xFar1, zDiningSplit],
          [xFar1, zFrontMain],
          [xFar0, zFrontMain],
          [bx0, zFrontMain],
          [bx0, zFrontBump],
          [bx1, zFrontBump],
          [bx1, zFrontMain],
        ]);
      }
    }
  }

  // HALLWAY: in the core block within the living band (corridor strip + landing area).
  const hallwayRegion = poly("hallway", "wood", [
    // corridor strip (full living band height)
    [xHall0, zDiningSplit],
    [xHall1, zDiningSplit],
    [xHall1, zLandingBack],
    // landing uses full core remainder width
    [xCore1, zLandingBack],
    [xCore1, zLandingFront],
    [xHall1, zLandingFront],
    [xHall1, zFrontMain],
    [xHall0, zFrontMain],
  ]);

  // STAIRS: bottom of the core remainder, sitting on the living/dining boundary
  const stairsRegion = rect("stairs", "wood", xCore0, zStairBack, xCore1, zStairFront);

  // POWDER ROOM: top of the core remainder near entry
  const bathRegion = rect("bathroom_small", "tile", xCore0, zBathBack, xCore1, zFrontMain);

  // --- Add regions (order not important, but keep readable)
  regions.push(
    // bump band
    foyerRegion,
    ...(office ? [office] : []),

    // garage + service
    garage,
    mudroom,
    serviceBase,

    // public spaces
    kitchenBase,
    ...(pantry ? [pantry] : []),
    diningRegion,
    livingRegion,

    // circulation + core
    hallwayRegion,
    stairsRegion,
    bathRegion
  );

  // Optional count enforcement:
  // - We always have mudroom + (laundry OR utility) => 2 optional.
  // - Pantry OR office adds a third optional (at most one of them is included).
  // The required optional names set is already enforced by construction.

  // Final sanity: ensure required names exist exactly once.
  const required = ["foyer", "garage", "livingroom", "kitchen", "dining", "bathroom_small", "stairs", "hallway"] as const;
  for (const n of required) {
    const c = regions.filter((r) => r.name === n).length;
    if (c !== 1) throw new Error(`House ${house.houseNumber}: expected exactly 1 region named '${n}', got ${c}`);
  }

  return { regions, construction: [], objects: [] };
}
