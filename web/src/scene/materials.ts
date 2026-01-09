import { Scene, StandardMaterial, Texture, Color3 } from "@babylonjs/core";

export function makeMat(scene: Scene, name: string, color: Color3, doubleSided = false): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.backFaceCulling = !doubleSided; // doubleSided => render both sides
  return m;
}

export function makeTexMat(scene: Scene, name: string, url: string, doubleSided = false): StandardMaterial {
  const m = new StandardMaterial(name, scene);

  const tex = new Texture(url, scene);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;

  m.diffuseTexture = tex;
  m.diffuseColor = new Color3(1, 1, 1); // do not tint textures
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  m.backFaceCulling = !doubleSided;

  return m;
}

export function surfaceMaterial(scene: Scene, opts?: { doubleSided?: boolean }): Record<string, StandardMaterial> {
  const doubleSided = opts?.doubleSided ?? false;
  const suf = doubleSided ? "_2s" : "";

  return {
    black: makeTexMat(scene, `mat_black${suf}`, "assets//textures/surfaces/black.jpg", doubleSided),
    brick: makeTexMat(scene, `mat_brick${suf}`, "assets//textures/surfaces/brick_normal.jpg", doubleSided),
    grass: makeTexMat(scene, `mat_grass${suf}`, "assets//textures/surfaces/grass.jpg", doubleSided),
    concrete_light: makeTexMat(scene, `mat_conc_light${suf}`, "assets//textures/surfaces/concrete_light.jpg", doubleSided),
    concrete_medium: makeTexMat(scene, `mat_conc_med${suf}`, "assets//textures/surfaces/concrete_medium.jpg", doubleSided),
    concrete_dark: makeTexMat(scene, `mat_conc_dark${suf}`, "assets//textures/surfaces/concrete_dark.jpg", doubleSided),
    wood_light: makeTexMat(scene, `mat_wood_light${suf}`, "assets//textures/surfaces/wood_light.jpg", doubleSided),
    wood_medium: makeTexMat(scene, `mat_wood_medium${suf}`, "assets//textures/surfaces/wood_medium.jpg", doubleSided),
    wood_dark: makeTexMat(scene, `mat_wood_dark${suf}`, "assets//textures/surfaces/wood_dark.jpg", doubleSided),
    tile_light: makeTexMat(scene, `mat_tile_light${suf}`, "assets//textures/surfaces/tile_light.jpg", doubleSided),
    tile_medium: makeTexMat(scene, `mat_tile_medium${suf}`, "assets//textures/surfaces/tile_medium.jpg", doubleSided),
    tile_dark: makeTexMat(scene, `mat_tile_dark${suf}`, "assets//textures/surfaces/tile_dark.jpg", doubleSided),

    // Not part of the Region surface enum, but still render with a real texture.
    road: makeTexMat(scene, `mat_road${suf}`, "assets//textures/surfaces/concrete_dark.jpg", doubleSided),

    // White indoor wall
    wall: makeTexMat(scene, `mat_wall${suf}`, "assets//textures/surfaces/wall.jpg", doubleSided),
  };
}
