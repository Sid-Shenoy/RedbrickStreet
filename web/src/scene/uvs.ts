import { Mesh, VertexBuffer } from "@babylonjs/core";

/**
 * Make surface textures repeat in real-world meters.
 * Uses world-space XZ to generate UVs, so all regions share consistent texture scale and alignment.
 */
export function applyWorldUVs(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wz = pos[i + 2]! + mesh.position.z;
    uvs[j] = wx / metersPerTile;
    uvs[j + 1] = wz / metersPerTile;
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/**
 * World-space UVs for vertical meshes: uses world X/Y so textures tile in meters.
 */
export function applyWorldUVsXY(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wy = pos[i + 1]! + mesh.position.y;
    uvs[j] = wx / metersPerTile;
    uvs[j + 1] = wy / metersPerTile;
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/**
 * World-space UVs for axis-aligned boxes (no rotation):
 * - Vertical faces tile in meters using (X,Y) or (Z,Y) depending on face normal.
 * - Top/bottom faces tile using (X,Z).
 */
export function applyWorldBoxUVs(mesh: Mesh, metersPerTile: number) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!pos || !nrm) return;

  const uvs = new Array((pos.length / 3) * 2);

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const wx = pos[i]! + mesh.position.x;
    const wy = pos[i + 1]! + mesh.position.y;
    const wz = pos[i + 2]! + mesh.position.z;

    const nx = nrm[i]!;
    const ny = nrm[i + 1]!;
    const nz = nrm[i + 2]!;

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    // Decide which face we're on by dominant normal axis.
    if (ax >= ay && ax >= az) {
      // ±X face => YZ plane: tile along Z and Y
      uvs[j] = wz / metersPerTile;
      uvs[j + 1] = wy / metersPerTile;
    } else if (az >= ax && az >= ay) {
      // ±Z face => XY plane: tile along X and Y
      uvs[j] = wx / metersPerTile;
      uvs[j + 1] = wy / metersPerTile;
    } else {
      // ±Y face (top/bottom) => XZ plane: tile along X and Z
      uvs[j] = wx / metersPerTile;
      uvs[j + 1] = wz / metersPerTile;
    }
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}

/**
 * World-space UVs for meshes that may be rotated:
 * - Computes world vertex positions using the mesh world matrix.
 * - Projects onto chosen world axes for (u,v).
 */
export function applyWorldUVsWorldAxes(
  mesh: Mesh,
  metersPerTile: number,
  uAxis: "x" | "y" | "z",
  vAxis: "x" | "y" | "z"
) {
  const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!pos) return;

  mesh.computeWorldMatrix(true);
  const m = mesh.getWorldMatrix().m;

  const uvs = new Array((pos.length / 3) * 2);

  function pickAxis(wx: number, wy: number, wz: number, axis: "x" | "y" | "z") {
    if (axis === "x") return wx;
    if (axis === "y") return wy;
    return wz;
  }

  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    const lx = pos[i]!;
    const ly = pos[i + 1]!;
    const lz = pos[i + 2]!;

    // Babylon matrix layout (same as Vector3.TransformCoordinates):
    const wx = lx * m[0] + ly * m[4] + lz * m[8] + m[12];
    const wy = lx * m[1] + ly * m[5] + lz * m[9] + m[13];
    const wz = lx * m[2] + ly * m[6] + lz * m[10] + m[14];

    uvs[j] = pickAxis(wx, wy, wz, uAxis) / metersPerTile;
    uvs[j + 1] = pickAxis(wx, wy, wz, vAxis) / metersPerTile;
  }

  mesh.setVerticesData(VertexBuffer.UVKind, uvs);
}
