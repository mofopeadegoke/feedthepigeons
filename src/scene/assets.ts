import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const BASE = `${import.meta.env.BASE_URL}assets/scene/`;

export interface SceneAssets {
  sky: THREE.DataTexture;
  pavingDiff: THREE.Texture;
  pavingNor: THREE.Texture;
  grassDiff: THREE.Texture;
  woodDiff: THREE.Texture;
  woodNor: THREE.Texture;
}

function tiled(tex: THREE.Texture, color: boolean, anisotropy: number): THREE.Texture {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

/** A neutral 1x1 stand-in so a single failed download leaves a plainer park rather than no park. */
function placeholder(rgb: [number, number, number]): THREE.Texture {
  const data = new Uint8Array([rgb[0], rgb[1], rgb[2], 255]);
  const tex = new THREE.DataTexture(data, 1, 1);
  tex.needsUpdate = true;
  return tex;
}

export async function loadSceneAssets(renderer: THREE.WebGLRenderer): Promise<SceneAssets> {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const texLoader = new THREE.TextureLoader();
  const tex = (file: string, color: boolean, fallback: [number, number, number]) =>
    texLoader
      .loadAsync(BASE + file)
      .catch(() => placeholder(fallback))
      .then((t) => tiled(t, color, aniso));

  const sky = new HDRLoader()
    .setDataType(THREE.HalfFloatType)
    .loadAsync(BASE + 'sky_1k.hdr')
    .then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      return t;
    })
    .catch(() => {
      const t = new THREE.DataTexture(new Float32Array([0.7, 0.75, 0.8, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.needsUpdate = true;
      return t;
    });

  const [skyTex, pavingDiff, pavingNor, grassDiff, woodDiff, woodNor] = await Promise.all([
    sky,
    tex('paving_diff_1k.jpg', true, [128, 116, 100]),
    tex('paving_nor_1k.jpg', false, [128, 128, 255]),
    tex('grass_diff_1k.jpg', true, [92, 104, 58]),
    tex('wood_diff_1k.jpg', true, [120, 84, 56]),
    tex('wood_nor_1k.jpg', false, [128, 128, 255]),
  ]);

  return { sky: skyTex as THREE.DataTexture, pavingDiff, pavingNor, grassDiff, woodDiff, woodNor };
}
