import * as THREE from 'three';
import type { SceneAssets } from './assets';

/** World rectangle covered by the path mask. Beyond it everything is lawn, lost in haze anyway. */
const MASK = { minX: -40, maxX: 40, minZ: -70, maxZ: 20, px: 1024 };
const PAVING_TILE = 2.6;
const GRASS_TILE = 3.2;

function toPx(x: number, z: number): [number, number] {
  return [
    ((x - MASK.minX) / (MASK.maxX - MASK.minX)) * MASK.px,
    ((z - MASK.minZ) / (MASK.maxZ - MASK.minZ)) * MASK.px,
  ];
}

const metresToPx = MASK.px / (MASK.maxX - MASK.minX);

/** Centre line of the promenade in front of the bench; bowing away at the sides adds depth. */
export function promenadeCentreZ(x: number): number {
  return -1.15 - 0.012 * x * x;
}
export const PROMENADE_HALF_WIDTH = 2.15;

function buildPathMask(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK.px;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, MASK.px, MASK.px);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';

  g.beginPath();
  for (let x = MASK.minX; x <= MASK.maxX; x += 1) {
    const [px, pz] = toPx(x, promenadeCentreZ(x) - PROMENADE_HALF_WIDTH);
    if (x === MASK.minX) g.moveTo(px, pz);
    else g.lineTo(px, pz);
  }
  for (let x = MASK.maxX; x >= MASK.minX; x -= 1) {
    const [px, pz] = toPx(x, promenadeCentreZ(x) + PROMENADE_HALF_WIDTH);
    g.lineTo(px, pz);
  }
  g.closePath();
  g.fill();

  // The pad under the bench: benches sit on paving, not on mud.
  const [ax, az] = toPx(-1.6, 0.4);
  const [bx, bz] = toPx(1.6, 3.2);
  g.fillRect(ax, az, bx - ax, bz - az);

  // A narrower path receding toward the trees gives the eye a leading line past the flock.
  g.lineWidth = 2.3 * metresToPx;
  g.beginPath();
  const s = toPx(0.6, -2.5);
  const c = toPx(2.4, -16);
  const e = toPx(-3.5, -48);
  g.moveTo(s[0], s[1]);
  g.quadraticCurveTo(c[0], c[1], e[0], e[1]);
  g.stroke();

  g.filter = 'blur(1px)';
  g.drawImage(canvas, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  // Canvas rows are drawn with minZ at the top; sample them in that order.
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export function createGround(assets: SceneAssets): THREE.Mesh {
  const size = 240;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // UVs in world metres so the paving's normal map lines up with its colour sampling.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / PAVING_TILE, -pos.getZ(i) / PAVING_TILE);
  }

  const mask = buildPathMask();
  const mat = new THREE.MeshStandardMaterial({
    map: assets.pavingDiff,
    normalMap: assets.pavingNor,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.92,
    metalness: 0,
  });

  const uniforms = {
    uGrass: { value: assets.grassDiff },
    uMask: { value: mask },
    uMaskRect: { value: new THREE.Vector4(MASK.minX, MASK.minZ, MASK.maxX - MASK.minX, MASK.maxZ - MASK.minZ) },
    uGrassTile: { value: GRASS_TILE },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGroundWorld;
        uniform sampler2D uGrass;
        uniform sampler2D uMask;
        uniform vec4 uMaskRect;
        uniform float uGrassTile;
        float pathBlend = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec2 gxz = vGroundWorld.xz;
        vec4 pave = texture2D(map, vMapUv);
        // Two scales of the same texture break up the obvious 1k tiling at a distance.
        vec3 grassA = texture2D(uGrass, gxz / uGrassTile).rgb;
        vec3 grassB = texture2D(uGrass, gxz / (uGrassTile * 4.7) + 0.37).rgb;
        vec3 grass = mix(grassA, grassB, 0.35);
        float macro = texture2D(uGrass, gxz / 41.0).g;
        grass *= vec3(0.8, 0.96, 0.62) * (0.82 + 0.4 * macro);

        vec2 mUv = (gxz - uMaskRect.xy) / uMaskRect.zw;
        float m = texture2D(uMask, mUv).r;
        // Height-blend against the paving's own value so the lawn creeps in through the joints.
        float paveLum = dot(pave.rgb, vec3(0.333));
        float edgeNoise = texture2D(uGrass, gxz / 1.3).g - 0.5;
        pathBlend = smoothstep(0.38, 0.62, m + (paveLum - 0.3) * 0.45 + edgeNoise * 0.35);

        // Pull the paving toward a quiet warm grey so grey birds, not slab joints, hold the eye.
        vec3 paveGrey = vec3(paveLum) * vec3(1.04, 1.0, 0.93);
        vec3 paveCol = mix(paveGrey, pave.rgb, 0.35);
        paveCol = mix(vec3(0.2, 0.19, 0.17), paveCol, 0.55) * (0.92 + 0.18 * macro);
        diffuseColor.rgb *= mix(grass, paveCol, pathBlend);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.97, roughnessFactor, pathBlend);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mix(nonPerturbedNormal, normal, pathBlend));`,
      );
  };
  mat.customProgramCacheKey = () => 'park-ground-v1';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/** CPU-side copy of the path mask test, for placing grass tufts off the paving. */
export function isOnPath(x: number, z: number): boolean {
  if (Math.abs(z - promenadeCentreZ(x)) < PROMENADE_HALF_WIDTH + 0.15) return true;
  if (x > -1.7 && x < 1.7 && z > 0.3 && z < 3.3) return true;
  // Must stay in step with the curve drawn in buildPathMask, or tufts sprout on the paving.
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const px = (1 - t) * (1 - t) * 0.6 + 2 * (1 - t) * t * 2.4 + t * t * -3.5;
    const pz = (1 - t) * (1 - t) * -2.5 + 2 * (1 - t) * t * -16 + t * t * -48;
    if ((x - px) ** 2 + (z - pz) ** 2 < 1.35 * 1.35) return true;
  }
  return false;
}
