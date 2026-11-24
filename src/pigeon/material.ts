import * as THREE from 'three';
import type { QualityLevel } from '../contracts';
import { EYE_R, REST } from './rig';
import { COLOR_KEYS, type PigeonLook } from './variants';

export type PigeonUniforms = Record<string, THREE.IUniform>;

const cap = (k: string) => 'u' + k[0].toUpperCase() + k.slice(1);

export function makeUniforms(look: PigeonLook, seed: number): PigeonUniforms {
  const u: PigeonUniforms = {
    uIrid: { value: look.irid },
    uChecker: { value: look.checker },
    uPied: { value: look.pied },
    uGerald: { value: look.gerald },
    uSeed: { value: (seed % 997) * 0.137 + look.patchSeed },
  };
  for (const k of COLOR_KEYS) u[cap(k)] = { value: look.colors[k].clone() };
  return u;
}

const f = (n: number) => n.toFixed(5);

const VERT_DECL = /* glsl */ `
attribute float aPart;
attribute vec3 aMask;
attribute vec2 aUv;
varying float vPart;
varying vec3 vMask;
varying vec2 vPUv;
varying vec3 vRest;
varying vec3 vRestN;
`;

const VERT_MAIN = /* glsl */ `
vPart = aPart;
vMask = aMask;
vPUv = aUv;
vRest = position;
vRestN = normal;
`;

const FRAG_DECL = /* glsl */ `
uniform vec3 ${COLOR_KEYS.map(cap).join(', ')};
uniform float uIrid, uChecker, uPied, uGerald, uSeed;
varying float vPart;
varying vec3 vMask;
varying vec2 vPUv;
varying vec3 vRest;
varying vec3 vRestN;

float pgHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float pgNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(pgHash(i), pgHash(i + vec3(1, 0, 0)), f.x), mix(pgHash(i + vec3(0, 1, 0)), pgHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(pgHash(i + vec3(0, 0, 1)), pgHash(i + vec3(1, 0, 1)), f.x), mix(pgHash(i + vec3(0, 1, 1)), pgHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
// Overlapping roof-tile rows, jittered per feather so the pattern never reads as a grid.
float pgScales(vec2 q) {
  float row = floor(q.y);
  q.x += 0.5 * mod(row, 2.0) + (pgHash(vec3(row, 3.1, 0.0)) - 0.5) * 0.6;
  vec2 id = floor(q);
  vec2 c = fract(q) - vec2(0.5, 0.25);
  c += (vec2(pgHash(vec3(id, 1.0)), pgHash(vec3(id, 2.0))) - 0.5) * 0.25;
  return clamp(1.0 - length(c * vec2(0.9, 0.7)) * 1.4, 0.0, 1.0);
}
// World-unit bump: scale-invariant, so feathers don't get louder as the bird gets smaller on screen.
vec3 pgPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 g = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - g);
}
`;

const FRAG_MAIN = /* glsl */ `
{
  vec3 p = vRest;
  float side = p.x >= 0.0 ? 1.0 : -1.0;
  vec3 col = uBody;
  float rough = 0.8;
  float metal = 0.0;
  float neck = 0.0;
  float h = 0.0;
  float white = 0.0;
  bool plumage = true;

  if (vPart < 0.5) {
    float headM = smoothstep(0.158, 0.186, p.y + 0.3 * (p.z - 0.06));
    float backM = smoothstep(0.125, 0.152, p.y) * (1.0 - smoothstep(0.02, 0.06, p.z));
    col = mix(uBody, uShield, backM * 0.85);
    float rumpM = smoothstep(-0.045, -0.085, p.z) * smoothstep(0.08, 0.105, p.y);
    col = mix(col, uRump, rumpM);
    col = mix(col, uHead, headM);
    // The iridescent collar wraps the whole neck but stops short of the crown and the mantle.
    neck = smoothstep(0.128, 0.152, p.y + 0.2 * (p.z - 0.05))
         * (1.0 - smoothstep(0.188, 0.203, p.y + 0.12 * (p.z - 0.08)))
         * smoothstep(0.005, 0.04, p.z);
    vec3 ec = vec3(side * ${f(REST.eye.x)}, ${f(REST.eye.y)}, ${f(REST.eye.z)});
    float ring = 1.0 - smoothstep(${f(EYE_R + 0.0011)}, ${f(EYE_R + 0.0024)}, distance(p, ec));
    col = mix(col, mix(uHead, vec3(0.32, 0.30, 0.31), 0.6), ring);
    col = mix(col, uBeak, vMask.x);
    col = mix(col, uCere, vMask.y);
    rough = mix(rough, 0.38, vMask.x);
    rough = mix(rough, 0.95, vMask.y);
    neck *= 1.0 - max(vMask.x, vMask.y);
    plumage = vMask.x + vMask.y < 0.5;
    vec3 an = abs(normalize(vRestN)) + 1e-3;
    an = pow(an, vec3(4.0));
    h = (pgScales(vec2(p.y * 190.0, -p.z * 150.0)) * an.x
       + pgScales(vec2(p.x * 190.0, -p.z * 150.0)) * an.y
       + pgScales(vec2(p.x * 190.0, -p.y * 150.0)) * an.z) / (an.x + an.y + an.z);
    h = mix(h, pgNoise(p * 420.0), 0.45);
    h *= 1.0 - max(vMask.x, vMask.y);
  } else if (vPart < 1.5) {
    float u = vPUv.x;
    float v = vPUv.y;
    col = uShield;
    float flight = smoothstep(0.6, 0.68, u - 0.05 * v);
    col = mix(col, uFlight, flight);
    col = mix(col, uFlight * 0.6, smoothstep(0.88, 0.97, u));
    float lower = 1.0 - smoothstep(0.2, 0.55, v);
    // Bars slope back as they run down the folded wing, with ragged feather-tip edges.
    float rag = (pgNoise(vec3(u * 60.0, v * 8.0, 2.0)) - 0.5) * 0.018;
    float b1 = 1.0 - smoothstep(0.016, 0.027, abs(u - (0.40 - 0.07 * v + 0.02 * v * v) + rag));
    float b2 = 1.0 - smoothstep(0.016, 0.027, abs(u - (0.52 - 0.06 * v + 0.02 * v * v) + rag));
    float bars = max(b1, b2) * lower * (1.0 - flight);
    // Checker: each covert carries a dark rounded chevron toward its tip; ragged edges let neighbours merge.
    vec2 cq = vec2(u * 11.0, (v + 1.0) * 2.8);
    cq.x += 0.5 * mod(floor(cq.y), 2.0);
    vec2 cid = floor(cq);
    vec2 cf = fract(cq) - 0.5;
    float rnd = pgHash(vec3(cid, 5.0));
    float cd = length(cf * vec2(1.1, 1.5) + vec2(0.0, 0.1)) + (pgNoise(vec3(u * 70.0, v * 20.0, 3.0)) - 0.5) * 0.3;
    float check = (1.0 - smoothstep(0.2 + 0.12 * rnd, 0.3 + 0.12 * rnd, cd)) * (1.0 - smoothstep(0.36, 0.44, u));
    col = mix(col, uBar, max(bars, check * uChecker * (1.0 - flight)));
    if (uGerald > 0.5 && side > 0.0) {
      float n = pgNoise(vec3(u * 9.0, v * 3.0, 7.0));
      float pm = 1.0 - smoothstep(0.85, 1.0, length(vec2((u - 0.21) / 0.15, (v + 0.05) / 0.8)) + (n - 0.5) * 0.4);
      white = max(white, pm);
    }
    float coverts = mix(pgScales(vec2(u * 26.0, (v + 1.0) * 4.5)), pgNoise(vec3(u * 80.0, v * 14.0, 4.0)), 0.5) * 0.5;
    float quill = fract((v + 1.0) * 4.5 - u * 1.5);
    float flights = smoothstep(0.0, 0.25, quill) * (1.0 - smoothstep(0.85, 1.0, quill));
    h = mix(coverts, flights, smoothstep(0.42, 0.6, u));
    col *= mix(1.0, 0.9 + 0.1 * flights, smoothstep(0.42, 0.6, u));
  } else if (vPart < 2.5) {
    float tv = vPUv.x;
    float tu = vPUv.y;
    col = uTail;
    float band = smoothstep(0.66, 0.72, tv) * (1.0 - smoothstep(0.89, 0.94, tv));
    col = mix(col, uTailBand, band);
    col = mix(col, mix(col, vec3(0.7), 0.3), smoothstep(0.88, 0.98, abs(tu)) * (1.0 - band) * (1.0 - smoothstep(0.55, 0.65, tv)));
    float fu = fract((tu + 1.0) * 6.0);
    h = smoothstep(0.0, 0.2, fu) * (1.0 - smoothstep(0.8, 1.0, fu));
    col *= 0.92 + 0.08 * h;
  } else if (vPart < 3.5) {
    plumage = false;
    col = uLeg;
    rough = 0.55;
    float claw = step(0.5, vPUv.x) * smoothstep(0.78, 0.88, vPUv.y);
    col = mix(col, vec3(0.05, 0.045, 0.045), claw);
    h = fract(vPUv.y * (vPUv.x > 0.5 ? 9.0 : 7.0));
    h = smoothstep(0.0, 0.3, h) * (1.0 - claw);
  } else {
    plumage = false;
    vec3 ec = vec3(side * ${f(REST.eye.x)}, ${f(REST.eye.y)}, ${f(REST.eye.z)});
    vec3 ea = normalize(vec3(side * 0.95, 0.1, 0.3));
    float ca = dot(normalize(p - ec), ea);
    col = vec3(0.28, 0.26, 0.27);
    float iris = smoothstep(0.55, 0.6, ca);
    float streak = pgNoise(vec3(atan(p.y - ec.y, p.z - ec.z) * 6.0, ca * 8.0, uSeed));
    vec3 irisCol = uEye * (0.75 + 0.4 * streak) * mix(0.75, 1.0, smoothstep(0.88, 0.8, ca));
    col = mix(col, irisCol, iris);
    col = mix(col, vec3(0.008), smoothstep(0.905, 0.925, ca));
    rough = mix(0.6, 0.06, iris);
  }

  if (plumage) {
    col *= 0.93 + 0.14 * pgNoise(p * 150.0 + uSeed);
    if (uPied > 0.0 && vPart < 2.5) {
      float n = pgNoise(p * 34.0 + uSeed * 13.0) * 0.7 + pgNoise(p * 90.0 + uSeed) * 0.3;
      white = max(white, smoothstep(1.0 - uPied * 0.55, 1.04 - uPied * 0.55, n));
    }
    col = mix(col, vec3(0.82, 0.82, 0.8), white);
    neck *= 1.0 - white;
  }

#ifdef PG_DETAIL
  float fw = length(fwidth(p));
  float fade = 1.0 - smoothstep(0.0006, 0.0022, fw);
  if (fade > 0.0) {
    float hm = h * 0.00018 * fade;
    normal = pgPerturb(-vViewPosition, normal, vec2(dFdx(hm), dFdy(hm)), faceDirection);
  }
#endif

  if (neck > 0.001) {
    float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    float ph = (1.0 - nv) * 4.2 + p.y * 75.0 + side * p.x * 35.0 + pgNoise(p * 260.0) * 0.7;
    vec3 ir = mix(uIridA, uIridB, smoothstep(-0.3, 0.9, sin(ph)));
    float k = neck * uIrid;
    // Facing the camera the collar is mostly grey with a sheen; the colour blooms toward grazing angles.
    float bloom = 0.45 + 0.55 * smoothstep(0.15, 0.85, 1.0 - nv);
    col = mix(col, ir * (0.7 + 0.5 * (1.0 - nv)), k * 0.8 * bloom);
    metal = mix(metal, 0.3, k);
    rough = mix(rough, 0.4, k);
  }

  diffuseColor.rgb = col;
  roughnessFactor = rough;
  metalnessFactor = metal;
}
`;

function patch(mat: THREE.Material, uniforms: PigeonUniforms, key: string) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_MAIN}`);
  };
  // Every pigeon has its own uniforms but they all share one compiled program per quality tier.
  mat.customProgramCacheKey = () => key;
}

export function makeMaterial(uniforms: PigeonUniforms, level: QualityLevel): THREE.Material {
  let mat: THREE.MeshStandardMaterial;
  if (level === 'high') {
    mat = new THREE.MeshPhysicalMaterial({
      roughness: 0.8,
      metalness: 0,
      sheen: 0.45,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(0x9aa1ad),
    });
  } else {
    mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
  }
  if (level !== 'low') mat.defines = { PG_DETAIL: '' };
  patch(mat, uniforms, 'pigeon-' + level);
  return mat;
}

/* ------------------------------------------------------------------ contact shadow */

let blob: { geo: THREE.PlaneGeometry; tex: THREE.Texture } | null = null;

/** Soft contact shadow, shared texture and geometry; each pigeon gets its own material for opacity. */
export function makeBlob(): THREE.Mesh {
  if (!blob) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.55)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(0.2, 0.3);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -0.015);
    blob = { geo, tex };
  }
  const mat = new THREE.MeshBasicMaterial({
    map: blob.tex,
    color: 0x000000,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(blob.geo, mat);
  m.renderOrder = 1;
  m.name = 'pigeon-contact-shadow';
  return m;
}
