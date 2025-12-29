import { Scene, MeshBuilder, Mesh, StandardMaterial } from "@babylonjs/core";
import type { HouseWithModel } from "../world/houseModel/types";
import { lotLocalToWorld } from "../world/houseModel/lotTransform";
import { PLOT_Y, SURFACE_TEX_METERS } from "./constants";
import { applyWorldUVsXY } from "./uvs";

export function renderCurbFaces(scene: Scene, houses: HouseWithModel[], mats: Record<string, StandardMaterial>) {
  // Plot is raised to PLOT_Y, but the road remains at y=0.0.
  // Add a thin vertical face along the lot front edge so the curb doesn't look like it's floating.
  const faceH = PLOT_Y;
  if (faceH <= 0) return;

  for (const house of houses) {
    const xsize = house.bounds.xsize;

    // Front edge in lot-local coordinates is always localZ=30.
    const p0 = lotLocalToWorld(house, 0, 30);
    const p1 = lotLocalToWorld(house, xsize, 30);

    const minX = Math.min(p0.x, p1.x);
    const maxX = Math.max(p0.x, p1.x);
    const width = Math.max(0.001, maxX - minX);

    const frontZ = p0.z; // same as p1.z

    // A single vertical face at the lot front edge (no thickness, avoids top-face UV mismatch).
    const face = MeshBuilder.CreatePlane(
      `curb_face_${house.houseNumber}`,
      { width, height: faceH, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );

    face.position.x = minX + width / 2;
    face.position.y = faceH / 2;
    face.position.z = frontZ;

    // World-scaled UVs (0.5m tiles) using X/Y for vertical surfaces.
    applyWorldUVsXY(face, SURFACE_TEX_METERS);

    face.material = mats.concrete_light;
    face.checkCollisions = false; // visual only
  }
}
