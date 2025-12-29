import { Scene, Ray, Vector3, AbstractMesh } from "@babylonjs/core";

export function isFloorMesh(m: AbstractMesh): boolean {
  if (m.name === "road") return true;
  const md = m.metadata as { rbs?: { kind?: string } } | undefined;
  return md?.rbs?.kind === "floor";
}

export function pickFloorY(scene: Scene, x: number, z: number, originY: number, maxDist: number): number | null {
  const ray = new Ray(new Vector3(x, originY, z), new Vector3(0, -1, 0), maxDist);
  const hit = scene.pickWithRay(ray, isFloorMesh);
  if (!hit?.hit || !hit.pickedPoint) return null;
  return hit.pickedPoint.y;
}
