// web/src/world/houseModel/generation/plot.ts
import type { HouseConfig } from "../../../types/config";
import type { FloorModel, Region, PolyPoints } from "../types";
import type { HouseGenContext } from "./context";

const Z_SIDEWALK0 = 25.0;
const Z_SIDEWALK1 = 26.5;
const Z_CURB0 = 29.8;
const Z_CURB1 = 30.0;

// New: fixed right-edge padding (meters). Houses/driveways/walkways must NOT use this band.
const PAD_RIGHT_X = 2.0;

const EPS = 1e-6;

function q(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function rectPoints(ax: number, az: number, bx: number, bz: number): [[number, number], [number, number]] {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const z0 = Math.min(az, bz);
  const z1 = Math.max(az, bz);
  return [
    [q(x0), q(z0)],
    [q(x1), q(z1)],
  ];
}

function simplifyOrthPoly(points: PolyPoints): PolyPoints {
  // Removes consecutive duplicates and redundant collinear vertices.
  const pts: PolyPoints = [];
  for (const p of points) {
    const last = pts.length > 0 ? pts[pts.length - 1]! : null;
    if (!last || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) {
      pts.push([q(p[0]), q(p[1])]);
    }
  }

  // If last equals first, drop last (shouldn't happen, but safe).
  if (pts.length >= 2) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS) {
      pts.pop();
    }
  }

  const isCollinear = (p0: [number, number], p1: [number, number], p2: [number, number]) => {
    const sameX = Math.abs(p0[0] - p1[0]) <= EPS && Math.abs(p1[0] - p2[0]) <= EPS;
    const sameZ = Math.abs(p0[1] - p1[1]) <= EPS && Math.abs(p1[1] - p2[1]) <= EPS;
    return sameX || sameZ;
  };

  let changed = true;
  while (changed && pts.length >= 4) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const pPrev = pts[(i - 1 + pts.length) % pts.length]!;
      const p = pts[i]!;
      const pNext = pts[(i + 1) % pts.length]!;
      if (isCollinear(pPrev, p, pNext)) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }

  return pts;
}

function polyAreaAbs(points: PolyPoints): number {
  // Shoelace formula (absolute area).
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i]!;
    const [x1, z1] = points[(i + 1) % points.length]!;
    s += x0 * z1 - x1 * z0;
  }
  return Math.abs(s) * 0.5;
}

function minZ(points: PolyPoints): number {
  let mz = Infinity;
  for (const [, z] of points) mz = Math.min(mz, z);
  return mz === Infinity ? 0 : mz;
}

function maxZ(points: PolyPoints): number {
  let mz = -Infinity;
  for (const [, z] of points) mz = Math.max(mz, z);
  return mz === -Infinity ? 0 : mz;
}

function assertHousePolyAxisAligned(points: PolyPoints, houseNumber: number) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const dx = Math.abs(a[0] - b[0]);
    const dz = Math.abs(a[1] - b[1]);
    const axisAligned = (dx <= EPS && dz > EPS) || (dz <= EPS && dx > EPS);
    if (!axisAligned) {
      throw new Error(
        `plot: House ${houseNumber} houseregion has non-axis-aligned edge from (${a[0]},${a[1]}) to (${b[0]},${b[1]})`
      );
    }
  }
}

function assertHousePolyMinExteriorEdge(points: PolyPoints, houseNumber: number, minLen: number) {
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); // orthogonal => manhattan == euclidean
    if (len + EPS < minLen) {
      throw new Error(
        `plot: House ${houseNumber} houseregion has exterior edge length ${q(len, 3)}m < ${minLen}m`
      );
    }
  }
}

type DrivewaySide = "left" | "right";

function buildHouseFootprint(
  house: HouseConfig,
  ctx: HouseGenContext,
  opts: { drivewaySide: DrivewaySide; drivewayWidth: number; zFront: number; minArea: number; buildXsize: number }
): { points: PolyPoints; core: { x0: number; x1: number; z0: number; z1: number } } {
  const hn = house.houseNumber;
  const xsize = opts.buildXsize;

  const zFront = opts.zFront;

  // Driveway-side alignment (hard requirement):
  // Make the houseregion flush to the driveway-side lot boundary so the driveway front edge endpoints align.
  let sideDrive = 0.0;

  let sideOpp = q(ctx.rng.float(0.6, 1.8), 3);

  // Compute x placement
  let x0: number;
  let x1: number;
  if (opts.drivewaySide === "left") {
    x0 = sideDrive;
    x1 = xsize - sideOpp;
  } else {
    x0 = sideOpp;
    x1 = xsize - sideDrive;
  }

  // Guarantee minimum core width (>=8.0)
  const minCoreW = 8.0;
  if (x1 - x0 < minCoreW) {
    // Reduce opposite-side clearance first (prefer keeping driveway-side tight).
    const need = minCoreW - (x1 - x0);
    sideOpp = Math.max(0, sideOpp - need);
    if (opts.drivewaySide === "left") x1 = xsize - sideOpp;
    else x0 = sideOpp;

    if (x1 - x0 < minCoreW - EPS) {
      throw new Error(
        `plot: House ${hn} cannot satisfy coreWidth>=${minCoreW} with buildXsize=${xsize} (got coreWidth=${q(
          x1 - x0,
          3
        )})`
      );
    }
  }

  // Front-setback constraint implies zFront in [20.5,23.0].
  // Choose a core depth within [14.0, maxDepth] and bump it if needed for minArea.
  const minCoreD = 14.0;
  const maxCoreD = zFront - 6.0; // guarantees minZ >= 6.0 (unless extension makes it deeper)
  if (maxCoreD + EPS < minCoreD) {
    throw new Error(
      `plot: House ${hn} cannot satisfy coreDepth>=${minCoreD} with zFront=${q(zFront, 3)} (maxCoreD=${q(
        maxCoreD,
        3
      )})`
    );
  }

  let coreDepth = q(ctx.rng.float(14.5, 17.5), 3);
  coreDepth = clamp(coreDepth, minCoreD, maxCoreD);

  const coreWidth = x1 - x0;

  // Enforce minimum area by increasing depth if possible (preferred), otherwise by widening to lot edges.
  const requiredDepth = opts.minArea / coreWidth;
  if (requiredDepth > coreDepth + EPS) {
    const bumped = clamp(requiredDepth, minCoreD, maxCoreD);
    coreDepth = q(bumped, 3);
  }

  // After bumping, if still short, widen (reduce both clearances) deterministically.
  if (coreWidth * coreDepth + EPS < opts.minArea) {
    // Prefer widening toward the opposite side (keep driveway alignment).
    const deficit = opts.minArea - coreWidth * coreDepth;
    const needW = deficit / coreDepth;

    if (opts.drivewaySide === "left") {
      // Reduce sideOpp first, then sideDrive.
      const takeOpp = Math.min(sideOpp, needW);
      sideOpp -= takeOpp;
      const remain = needW - takeOpp;
      const takeDrive = Math.min(sideDrive, remain);
      sideDrive -= takeDrive;

      x0 = sideDrive;
      x1 = xsize - sideOpp;
    } else {
      const takeOpp = Math.min(sideOpp, needW);
      sideOpp -= takeOpp;
      const remain = needW - takeOpp;
      const takeDrive = Math.min(sideDrive, remain);
      sideDrive -= takeDrive;

      x0 = sideOpp;
      x1 = xsize - sideDrive;
    }

    if ((x1 - x0) * coreDepth + EPS < opts.minArea) {
      throw new Error(
        `plot: House ${hn} cannot satisfy houseregion area>=${opts.minArea} with buildXsize=${xsize} (best area=${q(
          (x1 - x0) * coreDepth,
          3
        )})`
      );
    }
  }

  const coreZ1 = zFront;
  const coreZ0 = q(coreZ1 - coreDepth, 3);

  // Decide variation type deterministically.
  const r = ctx.rng.next();
  const preferExt = r >= 0.45 && r < 0.72;
  const preferNotch = r >= 0.72;

  // Build polygon (clockwise): front-left -> front-right -> rear-right -> ... -> rear-left
  // If extension/notch, add one rectangular rear modification only.
  const edgeMin = 1.25;

  const baseRect = (): PolyPoints => [
    [q(x0), q(coreZ1)],
    [q(x1), q(coreZ1)],
    [q(x1), q(coreZ0)],
    [q(x0), q(coreZ0)],
  ];

  const tryExtension = (): PolyPoints | null => {
    // Extension depth must fit without violating minZ>=6.0.
    const maxExtDepth = coreZ0 - 6.0;
    if (maxExtDepth + EPS < 2.0) return null;

    let extDepth = q(ctx.rng.float(2.0, 5.0), 3);
    extDepth = clamp(extDepth, 2.0, maxExtDepth);

    const maxExtW = Math.max(3.0, Math.min(coreWidth, 6.8));
    let extWidth = q(ctx.rng.float(3.0, maxExtW), 3);
    extWidth = clamp(extWidth, 3.0, coreWidth);

    // Choose whether to touch an edge for realism. If not touching, keep rear-edge segments >= 1.25m.
    const touchEdge = ctx.rng.bool(0.35);

    let extX0: number;
    if (touchEdge) {
      // Often bump-out is on the opposite side of the driveway.
      const bumpOpp = ctx.rng.bool(0.6);
      if (opts.drivewaySide === "left") {
        extX0 = bumpOpp ? x1 - extWidth : x0;
      } else {
        extX0 = bumpOpp ? x0 : x1 - extWidth;
      }
    } else {
      const minX = x0 + edgeMin;
      const maxX = x1 - extWidth - edgeMin;
      if (maxX + EPS < minX) {
        // Not enough room to keep both side segments >= 1.25; fall back to edge-touching.
        extX0 = ctx.rng.bool(0.5) ? x0 : x1 - extWidth;
      } else {
        extX0 = ctx.rng.float(minX, maxX);
      }
    }

    extX0 = q(clamp(extX0, x0, x1 - extWidth), 3);
    const extX1 = q(extX0 + extWidth, 3);
    const extZ0 = q(coreZ0 - extDepth, 3);

    // Enforce exterior edge length >= 1.25 wherever applicable on the rear edge segments.
    const leftSeg = extX0 - x0;
    const rightSeg = x1 - extX1;
    if (leftSeg > EPS && leftSeg + EPS < edgeMin) return null;
    if (rightSeg > EPS && rightSeg + EPS < edgeMin) return null;

    // Ensure extension adds modest area (core still "majority" by feel); if too big, reduce.
    const extArea = extWidth * extDepth;
    const coreArea = (x1 - x0) * (coreZ1 - coreZ0);
    if (extArea > coreArea * 0.45) {
      // Deterministic clamp: shrink width first.
      const targetArea = coreArea * 0.35;
      const shrinkW = clamp(targetArea / extDepth, 3.0, extWidth);
      const newW = q(shrinkW, 3);
      const newX1 = q(extX0 + newW, 3);
      if (newX1 + EPS < x1 + EPS) {
        // Re-check rear segments after shrink.
        const ls = extX0 - x0;
        const rs = x1 - newX1;
        if (ls > EPS && ls + EPS < edgeMin) return null;
        if (rs > EPS && rs + EPS < edgeMin) return null;
      }
    }

    const pts: PolyPoints = [
      [q(x0), q(coreZ1)],
      [q(x1), q(coreZ1)],
      [q(x1), q(coreZ0)],
      [extX1, q(coreZ0)],
      [extX1, extZ0],
      [extX0, extZ0],
      [extX0, q(coreZ0)],
      [q(x0), q(coreZ0)],
    ];

    return simplifyOrthPoly(pts);
  };

  const tryNotch = (): PolyPoints | null => {
    // Notch depth must not reach too close to front; keep at least ~4m of depth ahead of notch.
    const maxNotchDepth = Math.min(4.0, (coreZ1 - coreZ0) - 4.0);
    if (maxNotchDepth + EPS < 1.8) return null;

    let notchDepth = q(ctx.rng.float(1.8, maxNotchDepth), 3);
    notchDepth = clamp(notchDepth, 1.8, maxNotchDepth);

    // Keep notch away from side edges so rear exterior edge segments >= 1.25m.
    const usableW = coreWidth - 2 * edgeMin;
    if (usableW + EPS < 3.0) return null;

    const maxNotchW = Math.min(usableW, 6.2);
    let notchWidth = q(ctx.rng.float(3.0, maxNotchW), 3);
    notchWidth = clamp(notchWidth, 3.0, usableW);

    const minX = x0 + edgeMin;
    const maxX = x1 - edgeMin - notchWidth;
    if (maxX + EPS < minX) return null;

    const notchX0 = q(ctx.rng.float(minX, maxX), 3);
    const notchX1 = q(notchX0 + notchWidth, 3);
    const notchZ1 = q(coreZ0 + notchDepth, 3);

    // Area must remain >= minArea.
    const areaAfter = (x1 - x0) * (coreZ1 - coreZ0) - notchWidth * notchDepth;
    if (areaAfter + EPS < opts.minArea) return null;

    const pts: PolyPoints = [
      [q(x0), q(coreZ1)],
      [q(x1), q(coreZ1)],
      [q(x1), q(coreZ0)],
      [notchX1, q(coreZ0)],
      [notchX1, notchZ1],
      [notchX0, notchZ1],
      [notchX0, q(coreZ0)],
      [q(x0), q(coreZ0)],
    ];

    return simplifyOrthPoly(pts);
  };

  let housePts: PolyPoints = baseRect();

  if (preferExt) {
    const ext = tryExtension();
    if (ext) housePts = ext;
    else if (preferNotch) {
      const notch = tryNotch();
      if (notch) housePts = notch;
    }
  } else if (preferNotch) {
    const notch = tryNotch();
    if (notch) housePts = notch;
    else {
      const ext = tryExtension();
      if (ext) housePts = ext;
    }
  }

  housePts = simplifyOrthPoly(housePts);

  // Sanity checks: zFront must match frontZ(houseregion).
  const fz = maxZ(housePts);
  if (Math.abs(fz - zFront) > 1e-3) {
    throw new Error(`plot: House ${hn} houseregion frontZ mismatch (got ${q(fz, 3)}, expected ${q(zFront, 3)})`);
  }

  // Ensure bounds (against buildXsize).
  for (const [x, z] of housePts) {
    if (x < -EPS || x > xsize + EPS || z < -EPS || z > 30 + EPS) {
      throw new Error(`plot: House ${hn} houseregion point out of bounds: (${q(x, 3)},${q(z, 3)})`);
    }
  }

  // Ensure rear-most edge constraint (minZ >= 6.0)
  const zMin = minZ(housePts);
  if (zMin + EPS < 6.0) {
    throw new Error(`plot: House ${hn} houseregion minZ=${q(zMin, 3)} < 6.0`);
  }

  // Ensure min area constraint.
  const a = polyAreaAbs(housePts);
  if (a + EPS < opts.minArea) {
    throw new Error(`plot: House ${hn} houseregion area=${q(a, 3)} < minArea=${opts.minArea}`);
  }

  // Ensure orthogonal edges and min exterior edge length.
  assertHousePolyAxisAligned(housePts, hn);
  assertHousePolyMinExteriorEdge(housePts, hn, 1.25);

  return {
    points: housePts,
    core: { x0: q(x0), x1: q(x1), z0: q(coreZ0), z1: q(coreZ1) },
  };
}

function buildBackyardRegion(
  house: HouseConfig,
  xsize: number,
  zFront: number,
  housePoly: PolyPoints,
  surface: Region["surface"]
): Region {
  const hn = house.houseNumber;

  // Determine if house touches both side boundaries (within tolerance).
  const xs = housePoly.map((p) => p[0]);
  const hxMin = Math.min(...xs);
  const hxMax = Math.max(...xs);
  const touchesLeft = Math.abs(hxMin - 0) <= 1e-3;
  const touchesRight = Math.abs(hxMax - xsize) <= 1e-3;

  const zBack = minZ(housePoly);

  // If house spans the full width, backyard is simply the rear rectangle up to the back-most house edge.
  if (touchesLeft && touchesRight) {
    return {
      name: "backyard",
      surface,
      type: "rectangle",
      points: rectPoints(0, 0, xsize, zBack),
    };
  }

  // Otherwise, backyard is a single orthogonal polygon:
  // outer rectangle [0..xsize]x[0..zFront] with a front-connected indentation following the house boundary.
  // House polygon is clockwise starting at front-left; we expect points[0] is front-left and points[1] is front-right.
  const hp = housePoly;

  // Identify the two front-edge endpoints at zFront: minX and maxX on the front boundary.
  // (Since rear modifications are only at the back edge, the front boundary is a single segment.)
  const frontPts = hp.filter((p) => Math.abs(p[1] - zFront) <= 1e-3);
  if (frontPts.length < 2) {
    throw new Error(`plot: House ${hn} expected houseregion to touch zFront=${q(zFront, 3)} with >=2 vertices`);
  }
  let xFront0 = Infinity;
  let xFront1 = -Infinity;
  for (const [x] of frontPts) {
    xFront0 = Math.min(xFront0, x);
    xFront1 = Math.max(xFront1, x);
  }
  xFront0 = q(xFront0, 3);
  xFront1 = q(xFront1, 3);

  // Build backyard boundary path in CCW order for simplicity:
  // (0,0) -> (xsize,0) -> (xsize,zFront) -> (xFront1,zFront) -> follow house boundary around back to (xFront0,zFront)
  // -> (0,zFront) -> implicit close.
  //
  // To follow the house boundary around the back without using the front edge,
  // traverse house points from the front-right vertex until reaching the front-left vertex.
  const findIndex = (x: number, z: number) => {
    for (let i = 0; i < hp.length; i++) {
      const p = hp[i]!;
      if (Math.abs(p[0] - x) <= 1e-3 && Math.abs(p[1] - z) <= 1e-3) return i;
    }
    return -1;
  };

  // Prefer using exact existing vertices on zFront.
  const idxFR = findIndex(xFront1, zFront);
  const idxFL = findIndex(xFront0, zFront);
  if (idxFR === -1 || idxFL === -1) {
    throw new Error(`plot: House ${hn} could not locate front corners on houseregion boundary`);
  }

  const path: PolyPoints = [];

  // Outer rectangle (rear + right)
  path.push([0, 0]);
  path.push([xsize, 0]);
  path.push([xsize, zFront]);
  path.push([xFront1, zFront]);

  // Walk house boundary from FR to FL *excluding* the front edge.
  // HousePoly is orthogonal and simple; this produces a valid indentation.
  // Move forward through indices: idxFR -> idxFR+1 -> ... -> idxFL (wrapping), stopping at idxFL.
  let i = idxFR;
  for (let step = 0; step < hp.length + 2; step++) {
    const next = (i + 1) % hp.length;
    const p = hp[next]!;
    path.push([p[0], p[1]]);
    i = next;
    if (i === idxFL) break;
  }

  // Finish outer top-left
  path.push([0, zFront]);

  const simp = simplifyOrthPoly(path);

  // Ensure bounds
  for (const [x, z] of simp) {
    if (x < -EPS || x > xsize + EPS || z < -EPS || z > zFront + EPS) {
      throw new Error(`plot: House ${hn} backyard point out of bounds: (${q(x, 3)},${q(z, 3)})`);
    }
  }

  // If simplification degenerates into a rectangle, represent as rectangle.
  if (simp.length === 4) {
    const xs2 = simp.map((p) => p[0]);
    const zs2 = simp.map((p) => p[1]);
    const minx = Math.min(...xs2);
    const maxx = Math.max(...xs2);
    const minz = Math.min(...zs2);
    const maxz = Math.max(...zs2);
    if (Math.abs(minx - 0) <= 1e-3 && Math.abs(maxx - xsize) <= 1e-3) {
      return { name: "backyard", surface, type: "rectangle", points: rectPoints(0, minz, xsize, maxz) };
    }
  }

  return {
    name: "backyard",
    surface,
    type: "polygon",
    points: simp,
  };
}

/**
 * Plot generation:
 * - Partitions full lot [0..xsize]x[0..30] into required regions.
 * - Produces `houseregion` polygon footprint used by indoor floors.
 */
export function generatePlotModel(house: HouseConfig, ctx: HouseGenContext): FloorModel {
  const hn = house.houseNumber;

  // Stage precondition checks (fail fast; may omit stage prefix)
  if (ctx.zsize !== 30) {
    throw new Error(`House ${hn} has zsize=${ctx.zsize}, expected 30`);
  }

  // Lot-local plot width (includes right padding).
  const lotXsize = q(ctx.xsize, 3);

  // Effective buildable width used for all pre-existing regions that must NOT move or resize.
  const buildXsize = q(ctx.xsize - PAD_RIGHT_X, 3);
  if (buildXsize + EPS < 12.0) {
    throw new Error(`House ${hn} has xsize=${lotXsize}, expected xsize>=${q(12.0 + PAD_RIGHT_X, 3)} (buildXsize>=12.0)`);
  }

  const occ = house.occupantCount;
  if (occ < 1 || occ > 5) {
    throw new Error(`House ${hn} has occupantCount=${occ}, expected within [1,5]`);
  }

  // Bedroom-derived minimum footprint area requirement.
  const minBedrooms = Math.ceil(occ / 2);
  const minArea = minBedrooms === 3 ? 135.0 : 120.0;

  // Deterministic driveway side.
  const drivewaySide: DrivewaySide = ctx.rng.bool(0.5) ? "left" : "right";

  // Deterministic driveway & walkway widths.
  const drivewayWidth = q(ctx.rng.float(3.0, 3.8), 3);
  const walkwayWidth = q(ctx.rng.float(1.1, 1.8), 3);

  // IMPORTANT: computed against buildXsize so driveway/walkway/houseregion coordinates remain unchanged.
  const remainingFrontLawnWidth = buildXsize - drivewayWidth - walkwayWidth;
  if (remainingFrontLawnWidth + EPS < 0.9) {
    throw new Error(
      `plot: House ${hn} cannot satisfy remainingFrontLawnWidth>=0.9 (buildXsize=${buildXsize}, drivewayWidth=${drivewayWidth}, walkwayWidth=${walkwayWidth})`
    );
  }

  // Front setback: frontGap = 25.0 - zFront must be within [2.0, 4.5].
  // Bias larger households (3 bedrooms) to smaller gaps (deeper footprints).
  const frontGapMax = minBedrooms === 3 ? 3.4 : 4.5;
  const frontGap = q(ctx.rng.float(2.0, frontGapMax), 3);
  const zFront = q(Z_SIDEWALK0 - frontGap, 3);

  if (frontGap + EPS < 2.0 || frontGap - EPS > 4.5) {
    throw new Error(`plot: House ${hn} frontGap=${q(frontGap, 3)} out of range [2.0,4.5]`);
  }
  if (zFront + EPS < 0 || zFront - EPS > Z_SIDEWALK0) {
    throw new Error(`plot: House ${hn} zFront=${q(zFront, 3)} invalid`);
  }

  // Driveway and walkway placement per requirements (against buildXsize only).
  const dx0 = drivewaySide === "left" ? 0.0 : q(buildXsize - drivewayWidth, 3);
  const dx1 = drivewaySide === "left" ? q(drivewayWidth, 3) : buildXsize;

  const wx0 = drivewaySide === "left" ? q(drivewayWidth, 3) : q(buildXsize - drivewayWidth - walkwayWidth, 3);
  const wx1 = drivewaySide === "left" ? q(drivewayWidth + walkwayWidth, 3) : q(buildXsize - drivewayWidth, 3);

  // Disjoint intervals (may share boundary).
  const overlap = Math.min(dx1, wx1) - Math.max(dx0, wx0);
  if (overlap > 1e-3) {
    throw new Error(`plot: House ${hn} driveway and walkway x-intervals overlap (overlap=${q(overlap, 3)}m)`);
  }

  // Build houseregion footprint polygon (must be polygon even if rectangle) against buildXsize.
  const houseFoot = buildHouseFootprint(house, ctx, { drivewaySide, drivewayWidth, zFront, minArea, buildXsize });

  // Ensure driveway and walkway contact the front boundary (normative connectivity feasibility).
  const houseFrontX0 = Math.min(...houseFoot.points.filter((p) => Math.abs(p[1] - zFront) <= 1e-3).map((p) => p[0]));
  const houseFrontX1 = Math.max(...houseFoot.points.filter((p) => Math.abs(p[1] - zFront) <= 1e-3).map((p) => p[0]));

  const drivewayInterface = Math.max(0, Math.min(dx1, houseFrontX1) - Math.max(dx0, houseFrontX0));
  const expectedDrivewayInterface = q(dx1 - dx0, 3);
  if (Math.abs(drivewayInterface - expectedDrivewayInterface) > 1e-3) {
    throw new Error(
      `plot: House ${hn} driveway must be flush to houseregion along the full driveway width. Got interfaceLen=${q(
        drivewayInterface,
        3
      )}m, expected ${expectedDrivewayInterface}m (driveway=[${dx0},${dx1}], houseFront=[${q(houseFrontX0, 3)},${q(
        houseFrontX1,
        3
      )}])`
    );
  }

  const walkwayInterface = Math.max(0, Math.min(wx1, houseFrontX1) - Math.max(wx0, houseFrontX0));
  if (walkwayInterface + EPS < 1.0) {
    throw new Error(
      `plot: House ${hn} walkway interface to houseregion is ${q(walkwayInterface, 3)}m < 1.0m (walkway=[${wx0},${wx1}], houseFront=[${q(
        houseFrontX0,
        3
      )},${q(houseFrontX1, 3)}])`
    );
  }

  // Regions.
  const regions: Region[] = [];

  // 1) houseregion (polygon)
  regions.push({
    name: "houseregion",
    surface: "black",
    type: "polygon",
    points: houseFoot.points,
  });

  // 2) driveway_near (rectangle)
  regions.push({
    name: "driveway_near",
    surface: "concrete_dark",
    type: "rectangle",
    points: rectPoints(dx0, zFront, dx1, Z_SIDEWALK0),
  });

  // 3) driveway_far (rectangle)
  regions.push({
    name: "driveway_far",
    surface: "concrete_dark",
    type: "rectangle",
    points: rectPoints(dx0, Z_SIDEWALK1, dx1, Z_CURB0),
  });

  // 4) walkway (rectangle)
  regions.push({
    name: "walkway",
    surface: "concrete_medium",
    type: "rectangle",
    points: rectPoints(wx0, zFront, wx1, Z_SIDEWALK0),
  });

  // 5) sidewalk (fixed rectangle; covers full lot width including padding)
  regions.push({
    name: "sidewalk",
    surface: "concrete_light",
    type: "rectangle",
    points: rectPoints(0, Z_SIDEWALK0, lotXsize, Z_SIDEWALK1),
  });

  // 6) curb (fixed rectangle; covers full lot width including padding)
  regions.push({
    name: "curb",
    surface: "concrete_light",
    type: "rectangle",
    points: rectPoints(0, Z_CURB0, lotXsize, Z_CURB1),
  });

  // 7) frontlawn_near (single connected rectangle on the opposite side of driveway+walkway; within buildXsize)
  if (drivewaySide === "left") {
    regions.push({
      name: "frontlawn_near",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(wx1, zFront, buildXsize, Z_SIDEWALK0),
    });
  } else {
    regions.push({
      name: "frontlawn_near",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(0, zFront, wx0, Z_SIDEWALK0),
    });
  }

  // 8) frontlawn_far (single connected rectangle on the opposite side of driveway; within buildXsize)
  if (drivewaySide === "left") {
    regions.push({
      name: "frontlawn_far",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(dx1, Z_SIDEWALK1, buildXsize, Z_CURB0),
    });
  } else {
    regions.push({
      name: "frontlawn_far",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(0, Z_SIDEWALK1, dx0, Z_CURB0),
    });
  }

  // 9) backyard (connected polygon/rectangle; no holes) within buildXsize
  regions.push(buildBackyardRegion(house, buildXsize, zFront, houseFoot.points, "grass"));

  // NEW: right-edge padding fill (grass only; sidewalk/curb already cover their z-bands)
  // This creates a guaranteed 2.0m clear band at higher-x for detached houses.
  if (lotXsize - buildXsize > EPS) {
    regions.push({
      name: "sideyard",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(buildXsize, 0, lotXsize, zFront),
    });
    regions.push({
      name: "sideyard",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(buildXsize, zFront, lotXsize, Z_SIDEWALK0),
    });
    regions.push({
      name: "sideyard",
      surface: "grass",
      type: "rectangle",
      points: rectPoints(buildXsize, Z_SIDEWALK1, lotXsize, Z_CURB0),
    });
  }

  // Final sanity: enforce required regions + sideyard contract.
  const requiredOnce = [
    "backyard",
    "houseregion",
    "frontlawn_near",
    "frontlawn_far",
    "driveway_near",
    "driveway_far",
    "sidewalk",
    "curb",
    "walkway",
  ] as const;

  const counts = new Map<string, number>();
  for (const r of regions) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);

  for (const name of requiredOnce) {
    const c = counts.get(name) ?? 0;
    if (c !== 1) {
      throw new Error(`plot: House ${hn} expected exactly 1 region named '${name}', got ${c}`);
    }
  }

  const sideyardCount = counts.get("sideyard") ?? 0;
  if (sideyardCount !== 3) {
    throw new Error(`plot: House ${hn} expected exactly 3 'sideyard' regions, got ${sideyardCount}`);
  }

  for (const r of regions.filter((x) => x.name === "sideyard")) {
    if (r.surface !== "grass" || r.type !== "rectangle") {
      throw new Error(`plot: House ${hn} sideyard must be grass rectangle`);
    }
  }

  // Total regions should now be 12 (9 required + 3 sideyard).
  if (regions.length !== 12) {
    throw new Error(`plot: House ${hn} produced ${regions.length} regions, expected 12`);
  }

  return {
    regions,
    construction: [],
    objects: [],
  };
}
