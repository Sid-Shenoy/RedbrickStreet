import { Scene, MeshBuilder, Mesh, StandardMaterial, Texture, Color3 } from "@babylonjs/core";

import type { HouseWithModel, BrickTextureFile } from "../world/houseModel/types";
import type { Door } from "../world/houseModel/generation/doors";

import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { applyWorldUVsWorldAxes } from "./uvs";
import { SURFACE_TEX_METERS, PLOT_Y, FIRST_FLOOR_Y, SECOND_FLOOR_Y, CEILING_Y, BOUNDARY_WALL_T, DOOR_OPENING_H } from "./constants";

type Pt = { x: number; z: number };
type Interval = { a: number; b: number };
type DoorCut = { orient: "h" | "v"; c: number; a: number; b: number };

const EPS = 1e-6;
const MIN_SEG = 1e-4;

// Place brick slightly OUTSIDE the existing boundary walls to avoid coplanar overlap.
// Existing boundary walls are centered on the footprint edges with thickness BOUNDARY_WALL_T.
// Their outward face is ~BOUNDARY_WALL_T/2 from the edge line; we push a bit further out.
// Desired apparent brick "thickness" (gap from the existing wall OUTER face to the brick shell).
const BRICK_GAP = 0.05;

// Brick plane offset from the footprint edge centerline:
// existing wall outer face is at BOUNDARY_WALL_T/2 from the edge line; add BRICK_GAP beyond that.
const BRICK_OFFSET = BOUNDARY_WALL_T * 0.5 + BRICK_GAP;

function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    a += p0.x * p1.z - p1.x * p0.z;
  }
  return a * 0.5;
}

function subtractOne(intervals: Interval[], cut: Interval): Interval[] {
  const out: Interval[] = [];
  for (const it of intervals) {
    // No overlap
    if (cut.b <= it.a + EPS || cut.a >= it.b - EPS) {
      out.push(it);
      continue;
    }

    // Left remainder
    const la = it.a;
    const lb = Math.max(it.a, cut.a);
    if (lb - la > EPS) out.push({ a: la, b: lb });

    // Right remainder
    const ra = Math.min(it.b, cut.b);
    const rb = it.b;
    if (rb - ra > EPS) out.push({ a: ra, b: rb });
  }
  return out;
}

function isDoorElement(v: unknown): v is Door {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Partial<Door>;
  if (o.kind !== "door") return false;

  const aOk = typeof o.aRegion === "number";
  const bOk = o.bRegion === null || typeof o.bRegion === "number";

  const hingeOk =
    Array.isArray(o.hinge) &&
    o.hinge.length === 2 &&
    typeof o.hinge[0] === "number" &&
    typeof o.hinge[1] === "number";

  const endOk =
    Array.isArray(o.end) &&
    o.end.length === 2 &&
    typeof o.end[0] === "number" &&
    typeof o.end[1] === "number";

  return aOk && bOk && hingeOk && endOk;
}

function exteriorDoorCutsWorld(house: HouseWithModel, construction: unknown[]): DoorCut[] {
  const cuts: DoorCut[] = [];

  for (const el of construction) {
    if (!isDoorElement(el)) continue;
    if (el.bRegion !== null) continue; // exterior doors only

    const h0 = lotLocalToWorld(house, el.hinge[0], el.hinge[1]);
    const h1 = lotLocalToWorld(house, el.end[0], el.end[1]);

    const dx = h1.x - h0.x;
    const dz = h1.z - h0.z;

    if (Math.abs(dz) <= 1e-6 && Math.abs(dx) > 1e-6) {
      const a = Math.min(h0.x, h1.x);
      const b = Math.max(h0.x, h1.x);
      cuts.push({ orient: "h", c: h0.z, a, b });
    } else if (Math.abs(dx) <= 1e-6 && Math.abs(dz) > 1e-6) {
      const a = Math.min(h0.z, h1.z);
      const b = Math.max(h0.z, h1.z);
      cuts.push({ orient: "v", c: h0.x, a, b });
    }
  }

  return cuts;
}

function buildOffsetPolygon(pts: Pt[]): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();

  const ccw = signedArea(pts) > 0;

  // Each edge i: pts[i] -> pts[i+1]
  const edgeOrient: Array<"h" | "v"> = new Array(n);
  const edgeOffC: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % n]!;
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;

    // Outward normal based on winding:
    // CCW => outward is right normal (dz, -dx)
    // CW  => outward is left  normal (-dz, dx)
    let nx = ccw ? dz : -dz;
    let nz = ccw ? -dx : dx;

    const len = Math.hypot(nx, nz);
    if (len > EPS) {
      nx /= len;
      nz /= len;
    } else {
      nx = 0;
      nz = 0;
    }

    if (Math.abs(dz) <= EPS && Math.abs(dx) > EPS) {
      // Horizontal edge => z constant, offset in z
      edgeOrient[i] = "h";
      edgeOffC[i] = p0.z + nz * BRICK_OFFSET;
    } else if (Math.abs(dx) <= EPS && Math.abs(dz) > EPS) {
      // Vertical edge => x constant, offset in x
      edgeOrient[i] = "v";
      edgeOffC[i] = p0.x + nx * BRICK_OFFSET;
    } else {
      // Shouldn't happen (orthogonal polygon invariant); treat as horizontal fallback.
      edgeOrient[i] = "h";
      edgeOffC[i] = p0.z;
    }
  }

  // Offset vertex i is intersection of:
  // prev edge offset line (i-1) and next edge offset line (i)
  const out: Pt[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const next = i;

    const prevOrient = edgeOrient[prev]!;
    const nextOrient = edgeOrient[next]!;

    if (prevOrient === "v" && nextOrient === "h") {
      out[i] = { x: edgeOffC[prev]!, z: edgeOffC[next]! };
    } else if (prevOrient === "h" && nextOrient === "v") {
      out[i] = { x: edgeOffC[next]!, z: edgeOffC[prev]! };
    } else {
      // Degenerate (collinear edges); fall back to shifting the original vertex a bit outward.
      // This should not occur given simplified orthogonal polygons.
      out[i] = { x: pts[i]!.x, z: pts[i]!.z };
    }
  }

  return out;
}

function renderWallPlane(
  scene: Scene,
  name: string,
  brickMat: StandardMaterial,
  orient: "h" | "v",
  outwardSign: number,
  fixedC: number,
  t0: number,
  t1: number,
  y0: number,
  y1: number
) {
  const h = y1 - y0;
  const span = t1 - t0;
  if (!(h > 1e-6) || !(span > MIN_SEG)) return;

  const midT = (t0 + t1) * 0.5;

  const plane = MeshBuilder.CreatePlane(
    name,
    { width: span, height: h, sideOrientation: Mesh.DOUBLESIDE },
    scene
  );

  // Default plane is in XY with normal +Z.
  if (orient === "h") {
    // Along X, fixed Z
    plane.position.x = midT;
    plane.position.z = fixedC;
    plane.position.y = y0 + h * 0.5;

    // outwardSign: +1 => +Z, -1 => -Z
    plane.rotation.y = outwardSign >= 0 ? 0 : Math.PI;

    // Brick tiling: U along world X, V along world Y
    applyWorldUVsWorldAxes(plane, SURFACE_TEX_METERS, "x", "y");
  } else {
    // Along Z, fixed X
    plane.position.x = fixedC;
    plane.position.z = midT;
    plane.position.y = y0 + h * 0.5;

    // outwardSign: +1 => +X, -1 => -X
    plane.rotation.y = outwardSign >= 0 ? Math.PI / 2 : -Math.PI / 2;

    // Brick tiling: U along world Z, V along world Y
    applyWorldUVsWorldAxes(plane, SURFACE_TEX_METERS, "z", "y");
  }

  plane.material = brickMat;
  plane.checkCollisions = false;
  plane.isPickable = false;
}

function renderDoorRevealFrame(
  scene: Scene,
  namePrefix: string,
  brickMat: StandardMaterial,
  orient: "h" | "v",
  outwardSign: number,
  edgeC: number,  // original edge line (z for "h", x for "v")
  fixedC: number, // brick shell line (offset)
  cut: DoorCut,
  y0: number,
  y1: number,
  idx: number
) {
  const h = y1 - y0;
  if (!(h > 1e-6)) return;

  // Inner reference is the OUTER FACE of the existing boundary wall (not the centerline),
  // so this frame fills only the empty gap between that face and the brick shell.
  const wallFaceC = edgeC + outwardSign * (BOUNDARY_WALL_T * 0.5);

  const gap = Math.abs(fixedC - wallFaceC);
  if (!(gap > 1e-6)) return;

  const cMid = (fixedC + wallFaceC) * 0.5;
  const yMid = (y0 + y1) * 0.5;

  const span = cut.b - cut.a;
  if (!(span > 1e-6)) return;

  if (orient === "h") {
    // Door spans along X, facade is at Z=edgeC, brick is at Z=fixedC
    // Side returns: YZ planes at x=cut.a and x=cut.b spanning Z from wallFaceC -> fixedC
    for (const xEdge of [cut.a, cut.b] as const) {
      const side = MeshBuilder.CreatePlane(
        `${namePrefix}_${idx}_side_h_${Math.round(xEdge * 1000)}`,
        { width: gap, height: h, sideOrientation: Mesh.DOUBLESIDE },
        scene
      );

      side.rotation.y = Math.PI / 2; // XY -> YZ
      side.position.x = xEdge;
      side.position.y = yMid;
      side.position.z = cMid;

      applyWorldUVsWorldAxes(side, SURFACE_TEX_METERS, "z", "y");

      side.material = brickMat;
      side.checkCollisions = false;
      side.isPickable = false;
    }

    // Bottom cap: XZ plane at y=y0 spanning X door width and Z gap depth
    const bot = MeshBuilder.CreatePlane(
      `${namePrefix}_${idx}_bot_h`,
      { width: span, height: gap, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    bot.rotation.x = Math.PI / 2; // XY -> XZ
    bot.position.x = (cut.a + cut.b) * 0.5;
    bot.position.y = y0;
    bot.position.z = cMid;

    applyWorldUVsWorldAxes(bot, SURFACE_TEX_METERS, "x", "z");

    bot.material = brickMat;
    bot.checkCollisions = false;
    bot.isPickable = false;

    // Top cap: XZ plane at y=y1 spanning X door width and Z gap depth
    const top = MeshBuilder.CreatePlane(
      `${namePrefix}_${idx}_top_h`,
      { width: span, height: gap, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    top.rotation.x = Math.PI / 2; // XY -> XZ
    top.position.x = (cut.a + cut.b) * 0.5;
    top.position.y = y1;
    top.position.z = cMid;

    applyWorldUVsWorldAxes(top, SURFACE_TEX_METERS, "x", "z");

    top.material = brickMat;
    top.checkCollisions = false;
    top.isPickable = false;

  } else {
    // Door spans along Z, facade is at X=edgeC, brick is at X=fixedC
    // Side returns: XY planes at z=cut.a and z=cut.b spanning X from wallFaceC -> fixedC
    for (const zEdge of [cut.a, cut.b] as const) {
      const side = MeshBuilder.CreatePlane(
        `${namePrefix}_${idx}_side_v_${Math.round(zEdge * 1000)}`,
        { width: gap, height: h, sideOrientation: Mesh.DOUBLESIDE },
        scene
      );

      // XY plane already; width along X
      side.position.x = cMid;
      side.position.y = yMid;
      side.position.z = zEdge;

      applyWorldUVsWorldAxes(side, SURFACE_TEX_METERS, "x", "y");

      side.material = brickMat;
      side.checkCollisions = false;
      side.isPickable = false;
    }

    // Bottom cap: XZ plane at y=y0 spanning Z door width and X gap depth
    const bot = MeshBuilder.CreatePlane(
      `${namePrefix}_${idx}_bot_v`,
      { width: span, height: gap, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    bot.rotation.x = Math.PI / 2; // XY -> XZ
    bot.rotation.y = Math.PI / 2; // width axis -> world Z
    bot.position.x = cMid;
    bot.position.y = y0;
    bot.position.z = (cut.a + cut.b) * 0.5;

    applyWorldUVsWorldAxes(bot, SURFACE_TEX_METERS, "z", "x");

    bot.material = brickMat;
    bot.checkCollisions = false;
    bot.isPickable = false;

    // Top cap: XZ plane at y=y1 spanning Z door width and X gap depth
    const top = MeshBuilder.CreatePlane(
      `${namePrefix}_${idx}_top_v`,
      { width: span, height: gap, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    top.rotation.x = Math.PI / 2; // XY -> XZ
    top.rotation.y = Math.PI / 2; // width axis -> world Z
    top.position.x = cMid;
    top.position.y = y1;
    top.position.z = (cut.a + cut.b) * 0.5;

    applyWorldUVsWorldAxes(top, SURFACE_TEX_METERS, "z", "x");

    top.material = brickMat;
    top.checkCollisions = false;
    top.isPickable = false;
  }
}

function renderEdgeBand(
  scene: Scene,
  house: HouseWithModel,
  brickMat: StandardMaterial,
  origA: Pt,
  origB: Pt,
  offA: Pt,
  offB: Pt,
  cuts: DoorCut[],
  y0: number,
  y1: number,
  namePrefix: string
) {
  const dx = origB.x - origA.x;
  const dz = origB.z - origA.z;

  const isH = Math.abs(dz) <= EPS && Math.abs(dx) > EPS;
  const isV = Math.abs(dx) <= EPS && Math.abs(dz) > EPS;
  if (!isH && !isV) return;

  const orient: "h" | "v" = isH ? "h" : "v";
  const edgeC = orient === "h" ? origA.z : origA.x;

  // Determine outward direction by comparing offset edge location to original.
  // Horizontal: outward is sign(offZ - origZ). Vertical: sign(offX - origX).
  const outwardSign = orient === "h" ? Math.sign(offA.z - origA.z) : Math.sign(offA.x - origA.x);

  // Tangent interval [tMin, tMax] from the OFFSET edge endpoints.
  const tMin = orient === "h" ? Math.min(offA.x, offB.x) : Math.min(offA.z, offB.z);
  const tMax = orient === "h" ? Math.max(offA.x, offB.x) : Math.max(offA.z, offB.z);

  // Fixed coordinate for the OFFSET face
  const fixedC = orient === "h" ? offA.z : offA.x;

  // Split vertically:
  // - For the first-floor exterior shell, DO NOT carve below the real first-floor level.
  //   This keeps brick visible "below" the doorway and avoids coplanar fighting with plot surfaces.
  // - However, the TOP of the opening must align with the interior opening which is carved from the band base (y0).
  const carveBase = y0 < FIRST_FLOOR_Y - 1e-6 ? FIRST_FLOOR_Y : y0;

  const yDoor0 = Math.min(Math.max(carveBase, y0), y1);
  const yDoor1 = Math.min(y0 + DOOR_OPENING_H, y1);

  const relevantCuts = cuts.filter((c) => c.orient === orient && Math.abs(c.c - edgeC) <= 2e-3);

  const renderSolid = (yy0: number, yy1: number) => {
    if (yy1 - yy0 <= 1e-6) return;
    renderWallPlane(
      scene,
      `${namePrefix}_solid_${house.houseNumber}_${orient}_${Math.round(edgeC * 1000)}_${Math.round(yy0 * 1000)}`,
      brickMat,
      orient,
      outwardSign === 0 ? 1 : outwardSign,
      fixedC,
      tMin,
      tMax,
      yy0,
      yy1
    );
  };

  const renderCarved = (yy0: number, yy1: number) => {
    if (yy1 - yy0 <= 1e-6) return;

    let intervals: Interval[] = [{ a: tMin, b: tMax }];

    for (const c of relevantCuts) {
      // Map cut interval into tangent coords (x for horizontal, z for vertical).
      const a = c.a;
      const b = c.b;
      intervals = subtractOne(intervals, { a, b });
      if (intervals.length === 0) break;
    }

    let k = 0;
    for (const it of intervals) {
      const a = it.a;
      const b = it.b;
      if (b - a <= MIN_SEG) continue;

      renderWallPlane(
        scene,
        `${namePrefix}_carved_${house.houseNumber}_${orient}_${Math.round(edgeC * 1000)}_${Math.round(yy0 * 1000)}_${k++}`,
        brickMat,
        orient,
        outwardSign === 0 ? 1 : outwardSign,
        fixedC,
        a,
        b,
        yy0,
        yy1
      );
    }
  };

  // Solid below door band (usually none, since yDoor0 === y0)
  if (yDoor0 > y0 + 1e-6) renderSolid(y0, yDoor0);

  // Door band (carved)
  if (yDoor1 > yDoor0 + 1e-6) {
    if (relevantCuts.length > 0) {
      renderCarved(yDoor0, yDoor1);

      // Seal the offset gap between the outer brick shell and the inner doorway edges
      // so no thin empty slivers are visible from outside.
      let di = 0;
      for (const c of relevantCuts) {
        renderDoorRevealFrame(
          scene,
          `${namePrefix}_reveal`,
          brickMat,
          orient,
          outwardSign === 0 ? 1 : outwardSign,
          edgeC,
          fixedC,
          c,
          yDoor0,
          yDoor1,
          di++
        );
      }
    } else {
      renderSolid(yDoor0, yDoor1);
    }
  }

  // Solid above door band
  if (y1 > yDoor1 + 1e-6) renderSolid(yDoor1, y1);
}

export function renderExteriorBrickPrisms(scene: Scene, houses: HouseWithModel[]) {
  const brickMats = new Map<BrickTextureFile, StandardMaterial>();

  function getHouseBrickMat(texFile: BrickTextureFile): StandardMaterial {
    const hit = brickMats.get(texFile);
    if (hit) return hit;

    const mat = new StandardMaterial(`house_brick_${texFile.replace(".jpg", "")}`, scene);
    const tex = new Texture(`/assets/textures/surfaces/${texFile}`, scene);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;

    mat.diffuseTexture = tex;

    // Keep brick fairly matte (more realistic, avoids "shiny plastic" look).
    mat.specularColor = new Color3(0.08, 0.08, 0.08);

    brickMats.set(texFile, mat);
    return mat;
  }

  for (const house of houses) {
    const brickMat = getHouseBrickMat(house.model.brickTexture);

    const hr = house.model.plot.regions.find((r) => r.name === "houseregion");
    if (!hr || hr.type !== "polygon" || hr.points.length < 3) continue;

    const orig: Pt[] = hr.points.map(([lx, lz]) => lotLocalToWorld(house, lx, lz));
    const off: Pt[] = buildOffsetPolygon(orig);

    const ffCuts = exteriorDoorCutsWorld(house, house.model.firstFloor.construction);
    const sfCuts = exteriorDoorCutsWorld(house, house.model.secondFloor.construction);

    // Two vertical bands so exterior doors can be carved per-floor if needed.
    // (Still uses the same houseregion footprint so the exterior is a true houseregion prism.)
    const yBands: Array<{ y0: number; y1: number; cuts: DoorCut[]; tag: string }> = [
      { y0: PLOT_Y, y1: SECOND_FLOOR_Y, cuts: ffCuts, tag: "ff" },
      { y0: SECOND_FLOOR_Y, y1: CEILING_Y, cuts: sfCuts, tag: "sf" },
    ];

    for (const band of yBands) {
      const y0 = band.y0;
      const y1 = band.y1;
      if (!(y1 > y0 + 1e-6)) continue;

      for (let i = 0; i < orig.length; i++) {
        const a = orig[i]!;
        const b = orig[(i + 1) % orig.length]!;
        const oa = off[i]!;
        const ob = off[(i + 1) % off.length]!;
        renderEdgeBand(scene, house, brickMat, a, b, oa, ob, band.cuts, y0, y1, `extbrick_${band.tag}`);
      }
    }
  }
}
