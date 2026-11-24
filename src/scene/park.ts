import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { mulberry32 } from '../core/random';
import type { SceneAssets } from './assets';
import { isOnPath, promenadeCentreZ, PROMENADE_HALF_WIDTH } from './ground';

/** Shared with index.ts so breadAnchor / benchSpot stay on the seat if the bench changes. */
export const BENCH = { seatY: 0.45, frontZ: 1.6, backZ: 2.06, halfLength: 0.86 };

const noise = new SimplexNoise({ random: mulberry32(7) });

/* ------------------------------------------------------------------ bench */

const castIron = () =>
  new THREE.MeshStandardMaterial({ color: 0x1f2622, roughness: 0.48, metalness: 0.55 });

function benchEnd(x: number): THREE.BufferGeometry {
  const P = (z: number, y: number) => new THREE.Vector3(x, y, z);
  const frontAndArm = new THREE.CatmullRomCurve3([
    P(1.58, 0.0),
    P(1.66, 0.22),
    P(1.66, 0.44),
    P(1.57, 0.58),
    P(1.6, 0.665),
    P(1.72, 0.675),
    P(1.95, 0.66),
    P(2.14, 0.66),
    P(2.22, 0.74),
    P(2.27, 0.9),
  ]);
  const rearLeg = new THREE.CatmullRomCurve3([P(2.24, 0.0), P(2.15, 0.22), P(2.12, 0.44), P(2.16, 0.56)]);
  const parts: THREE.BufferGeometry[] = [
    new THREE.TubeGeometry(frontAndArm, 64, 0.021, 10, false),
    new THREE.TubeGeometry(rearLeg, 24, 0.022, 10, false),
  ];
  const rail = new THREE.BoxGeometry(0.035, 0.04, BENCH.backZ - BENCH.frontZ + 0.04);
  rail.translate(x, BENCH.seatY - 0.055, (BENCH.frontZ + BENCH.backZ) / 2);
  parts.push(rail);
  // Little scroll at the front of the arm, the detail that makes it read as a park bench.
  const scroll = new THREE.TorusGeometry(0.03, 0.012, 8, 20);
  scroll.rotateY(Math.PI / 2);
  scroll.translate(x, 0.635, 1.585);
  parts.push(scroll);
  for (const foot of [1.58, 2.24]) {
    const f = new THREE.CylinderGeometry(0.03, 0.036, 0.025, 12);
    f.translate(x, 0.0125, foot);
    parts.push(f);
  }
  return mergeGeometries(parts, false)!;
}

function createBench(assets: SceneAssets): THREE.Group {
  const group = new THREE.Group();
  group.name = 'bench';

  const woodDiff = assets.woodDiff.clone();
  woodDiff.repeat.set(1, 1);
  const wood = new THREE.MeshStandardMaterial({
    map: woodDiff,
    normalMap: assets.woodNor,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.72,
  });
  // The texture's red stain is too loud for a park bench; keep only its grain over weathered teak.
  wood.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `vec3 grainSample = texture2D(map, vMapUv).rgb;
       float grain = dot(grainSample, vec3(0.3, 0.55, 0.15));
       diffuseColor.rgb *= vec3(0.36, 0.29, 0.22) * (0.45 + 2.6 * grain);`,
    );
  };
  wood.customProgramCacheKey = () => 'park-bench-wood-v1';

  const slatDepth = 0.092;
  const gap = 0.03;
  const slatCount = 4;
  const len = BENCH.halfLength * 2 + 0.18;
  const slats: THREE.BufferGeometry[] = [];
  for (let i = 0; i < slatCount; i++) {
    const g = new RoundedBoxGeometry(len, 0.034, slatDepth, 2, 0.01);
    const z = BENCH.frontZ + slatDepth / 2 + i * (slatDepth + gap);
    g.translate(0, BENCH.seatY - 0.017, z);
    shiftUv(g, i * 0.23, i * 0.11);
    slats.push(g);
  }
  // Backrest, tilted back like a real bench; mostly unseen but it shades the seat.
  for (let i = 0; i < 3; i++) {
    const g = new RoundedBoxGeometry(len, 0.03, 0.085, 2, 0.01);
    g.rotateX(Math.PI / 2 - 0.26);
    g.translate(0, 0.58 + i * 0.11, 2.2 + i * 0.03);
    shiftUv(g, 0.5 + i * 0.17, 0.3);
    slats.push(g);
  }
  const slatMesh = new THREE.Mesh(mergeGeometries(slats, false)!, wood);
  slatMesh.castShadow = true;
  slatMesh.receiveShadow = true;
  group.add(slatMesh);

  const iron = new THREE.Mesh(
    mergeGeometries([benchEnd(-BENCH.halfLength), benchEnd(BENCH.halfLength)], false)!,
    castIron(),
  );
  iron.castShadow = true;
  iron.receiveShadow = true;
  group.add(iron);
  return group;
}

function shiftUv(g: THREE.BufferGeometry, du: number, dv: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.6 + du, uv.getY(i) * 0.12 + dv);
}

/* ------------------------------------------------------------------ foliage blobs */

interface BlobOptions {
  radius: number;
  detail: number;
  lumpiness: number;
  base: THREE.Color;
  /** Vertical extent of the whole cluster, for the top-lit / dark-underneath gradient. */
  yRange: [number, number];
  centre: THREE.Vector3;
  seed: number;
}

/** A lumpy sphere with baked colour: lighter on top and outside, darker within, like a canopy. */
function foliageBlob(pos: THREE.Vector3, scale: THREE.Vector3, o: BlobOptions): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(o.radius, o.detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    const w = v.clone().multiply(scale).add(pos);
    const big = noise.noise3d(w.x * 0.9 + o.seed, w.y * 0.9, w.z * 0.9);
    const small = noise.noise3d(w.x * 3.1, w.y * 3.1 + o.seed, w.z * 3.1);
    const d = 1 + o.lumpiness * (0.65 * big + 0.35 * small);
    v.copy(n).multiplyScalar(o.radius * d).multiply(scale).add(pos);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();

  const colors = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  const toCentre = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const h = THREE.MathUtils.clamp((v.y - o.yRange[0]) / (o.yRange[1] - o.yRange[0]), 0, 1);
    toCentre.copy(v).sub(o.centre);
    const outward = THREE.MathUtils.clamp(toCentre.length() / (o.radius * 2.2), 0, 1);
    const speckle = noise.noise3d(v.x * 6, v.y * 6, v.z * 6) * 0.08;
    const k = 0.42 + 0.48 * h * 0.6 + 0.4 * outward * 0.6 + speckle;
    c.copy(o.base).multiplyScalar(k);
    c.offsetHSL(0.012 * h - 0.006, 0, 0.0);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function createTreeGeometries(seed: number, height: number): { trunk: THREE.BufferGeometry; canopy: THREE.BufferGeometry } {
  const rng = mulberry32(seed);
  const trunkH = height * 0.48;
  const lean = new THREE.Vector3((rng() - 0.5) * 0.25, 1, (rng() - 0.5) * 0.25).normalize();

  const trunkParts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.11 * (height / 7), 0.2 * (height / 7), trunkH + 0.6, 12, 8);
  trunk.translate(0, (trunkH + 0.6) / 2, 0);
  bendAlong(trunk, lean, rng() * 10);
  trunkParts.push(trunk);
  // A couple of limbs into the canopy so the crown doesn't float on a stick.
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    const l = height * (0.22 + rng() * 0.12);
    const limb = new THREE.CylinderGeometry(0.03 * (height / 7), 0.08 * (height / 7), l, 8, 3);
    limb.translate(0, l / 2, 0);
    limb.rotateZ(0.7 + rng() * 0.25);
    limb.rotateY(a);
    limb.translate(lean.x * trunkH, trunkH * 0.92, lean.z * trunkH);
    trunkParts.push(limb);
  }
  const trunkGeo = mergeGeometries(trunkParts.map((t) => t.toNonIndexed()), false)!;
  trunkGeo.deleteAttribute('uv');

  const crownCentre = new THREE.Vector3(lean.x * trunkH, trunkH + height * 0.27, lean.z * trunkH);
  const crownR = height * 0.3;
  const base = new THREE.Color().setHSL(0.24 + rng() * 0.05, 0.42 + rng() * 0.1, 0.27 + rng() * 0.05);
  const blobs: THREE.BufferGeometry[] = [];
  const blobCount = 7 + Math.floor(rng() * 4);
  for (let i = 0; i < blobCount; i++) {
    const dir = new THREE.Vector3(rng() - 0.5, (rng() - 0.35) * 0.8, rng() - 0.5).normalize();
    const pos = crownCentre.clone().addScaledVector(dir, crownR * (0.45 + rng() * 0.35));
    const r = crownR * (0.48 + rng() * 0.22);
    blobs.push(
      foliageBlob(pos, new THREE.Vector3(1, 0.82, 1), {
        radius: r,
        detail: 3,
        lumpiness: 0.28,
        base,
        yRange: [crownCentre.y - crownR, crownCentre.y + crownR],
        centre: crownCentre,
        seed: seed + i,
      }),
    );
  }
  return { trunk: trunkGeo, canopy: mergeGeometries(blobs, false)! };
}

function bendAlong(g: THREE.BufferGeometry, lean: THREE.Vector3, phase: number) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const wobble = noise.noise(y * 0.6 + phase, phase) * 0.06;
    p.setXYZ(i, p.getX(i) + lean.x * y + wobble, y, p.getZ(i) + lean.z * y + wobble * 0.5);
  }
  g.computeVertexNormals();
}

function createTrees(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';
  const bark = new THREE.MeshStandardMaterial({ color: 0x6b6056, roughness: 0.95 });
  const leaves = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, color: 0xffffff });

  const variants = [11, 23, 37, 51, 68].map((s, i) => createTreeGeometries(s, 7 + i * 0.6));

  // Hand-placed so the composition frames the path; the receding path stays clear.
  const spots: [number, number, number][] = [
    [-6.2, -2.0, 1.05],
    [6.8, -5.2, 0.95],
    [-8.5, -9.5, 1.15],
    [-4.6, -14.0, 1.0],
    [5.2, -13.0, 1.1],
    [9.5, -10.5, 1.2],
    [-12.5, -15.5, 1.25],
    [-1.8, -22.0, 1.1],
    [6.8, -21.0, 1.3],
    [-9.0, -24.0, 1.2],
    [13.0, -18.0, 1.15],
    [2.4, -30.0, 1.4],
    [-5.5, -33.0, 1.3],
    [10.5, -29.0, 1.35],
    [-15.0, -28.0, 1.3],
    [-11.0, 1.5, 1.1],
    [11.0, 0.0, 1.05],
    [17.0, -9.0, 1.2],
    [-18.0, -8.0, 1.2],
  ];
  // A loose far tree line whose crowns sit at the top of the frame and melt into the haze.
  const far = mulberry32(123);
  for (let i = 0; i < 26; i++) {
    const x = -42 + i * 3.3 + (far() - 0.5) * 2.5;
    const z = -38 - far() * 22;
    if (Math.abs(x - (-3.5 + (z + 48) * -0.1)) < 3) continue;
    spots.push([x, z, 1.25 + far() * 0.45]);
  }
  const rng = mulberry32(99);
  spots.forEach(([x, z, s], i) => {
    const v = variants[i % variants.length];
    const trunk = new THREE.Mesh(v.trunk, bark);
    const canopy = new THREE.Mesh(v.canopy, leaves);
    const tree = new THREE.Group();
    tree.add(trunk, canopy);
    tree.position.set(x, 0, z);
    tree.rotation.y = rng() * Math.PI * 2;
    tree.scale.setScalar(s);
    trunk.castShadow = canopy.castShadow = true;
    trunk.receiveShadow = canopy.receiveShadow = true;
    group.add(tree);
  });
  return group;
}

function createHedges(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hedges';
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const base = new THREE.Color().setHSL(0.27, 0.4, 0.22);
  const rows: [number, number, number][] = [
    [-15, -1.2, -10.8],
    [4.4, 15, -10.2],
    [-15, -10, 3.6],
  ];
  rows.forEach(([x0, x1, z], r) => {
    const blobs: THREE.BufferGeometry[] = [];
    const hr = mulberry32(17 + r);
    for (let x = x0; x <= x1; x += 0.38) {
      const zz = z + noise.noise(x * 0.3, r) * 0.08 + (hr() - 0.5) * 0.2;
      const rad = 0.46 + hr() * 0.14;
      const pos = new THREE.Vector3(x + (hr() - 0.5) * 0.15, 0.42 + hr() * 0.12, zz);
      blobs.push(
        foliageBlob(pos, new THREE.Vector3(1.15, 1.0, 0.95), {
          radius: rad,
          detail: 3,
          lumpiness: 0.32,
          base,
          yRange: [0, 1.1],
          centre: new THREE.Vector3(x, 0.45, zz),
          seed: x * 3.3 + r,
        }),
      );
    }
    const mesh = new THREE.Mesh(mergeGeometries(blobs, false)!, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
}

function createLampPost(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lamp';
  const paint = castIron();
  const pole = new THREE.LatheGeometry(
    [
      new THREE.Vector2(0.0, 0),
      new THREE.Vector2(0.14, 0),
      new THREE.Vector2(0.14, 0.06),
      new THREE.Vector2(0.1, 0.12),
      new THREE.Vector2(0.09, 0.45),
      new THREE.Vector2(0.065, 0.55),
      new THREE.Vector2(0.05, 0.62),
      new THREE.Vector2(0.045, 3.1),
      new THREE.Vector2(0.07, 3.16),
      new THREE.Vector2(0.07, 3.2),
      new THREE.Vector2(0.0, 3.2),
    ],
    20,
  );
  const lantern = new THREE.CylinderGeometry(0.17, 0.11, 0.38, 6, 1);
  lantern.translate(0, 3.39, 0);
  const cap = new THREE.ConeGeometry(0.24, 0.18, 6);
  cap.translate(0, 3.67, 0);
  const finial = new THREE.SphereGeometry(0.035, 10, 8);
  finial.translate(0, 3.78, 0);
  const iron = new THREE.Mesh(
    mergeGeometries([pole, cap, finial].map((g) => g.toNonIndexed()), false)!,
    paint,
  );
  const glass = new THREE.Mesh(
    lantern,
    new THREE.MeshStandardMaterial({ color: 0xe8e2cf, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.75 }),
  );
  iron.castShadow = glass.castShadow = true;
  group.add(iron, glass);
  group.position.set(4.3, 0, promenadeCentreZ(4.3) - PROMENADE_HALF_WIDTH - 0.6);
  return group;
}

/* ------------------------------------------------------------------ grass tufts */

export interface GrassField {
  mesh: THREE.InstancedMesh;
  /** Max tufts; the quality level shows a prefix of the (shuffled) instances. */
  capacity: number;
  time: { value: number };
  wind: { value: number };
}

function tuftGeometry(): THREE.BufferGeometry {
  const rng = mulberry32(5);
  const blades: THREE.BufferGeometry[] = [];
  for (let b = 0; b < 7; b++) {
    const h = 0.07 + rng() * 0.09;
    const w = 0.011 + rng() * 0.006;
    const segs = 3;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const bend = (rng() - 0.3) * 0.05;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const ww = w * (1 - t * 0.92);
      const zb = bend * t * t;
      pos.push(-ww, h * t, zb, ww, h * t, zb);
      const shade = 0.35 + 0.65 * t;
      col.push(shade, shade, shade, shade, shade, shade);
    }
    for (let s = 0; s < segs; s++) {
      const a = s * 2;
      // Both windings so FrontSide works with the up-facing normals on either face.
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.rotateY(rng() * Math.PI * 2);
    g.translate((rng() - 0.5) * 0.06, 0, (rng() - 0.5) * 0.06);
    blades.push(g);
  }
  const merged = mergeGeometries(blades, false)!;
  // Normals point up so blades are lit like the lawn they stand in, not like paper cards.
  const n = new Float32Array(merged.attributes.position.count * 3);
  for (let i = 0; i < n.length; i += 3) n[i + 1] = 1;
  merged.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return merged;
}

function createGrass(): GrassField {
  const capacity = 9000;
  const geo = tuftGeometry();
  const time = { value: 0 };
  const wind = { value: 1 };
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = wind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 tuftOrigin = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
        float sway = sin(uTime * 1.3 + tuftOrigin.x * 0.7 + tuftOrigin.z * 0.4) * 0.5
                   + sin(uTime * 2.7 + tuftOrigin.x * 1.9) * 0.2;
        transformed.x += sway * uWind * 0.03 * position.y / 0.16;`,
      );
  };
  mat.customProgramCacheKey = () => 'park-grass-v1';

  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = 'grass';
  const rng = mulberry32(31);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const tint = new THREE.Color();
  let placed = 0;
  let guard = 0;
  while (placed < capacity && guard++ < capacity * 20) {
    // Bias toward the foreground and the lawn edges where they're actually seen at size.
    const x = (rng() - 0.5) * 22;
    const z = 3.5 - Math.pow(rng(), 1.6) * 18;
    if (isOnPath(x, z)) continue;
    const nearEdge = isOnPath(x, z - 0.6) || isOnPath(x, z + 0.6) || isOnPath(x + 0.6, z) || isOnPath(x - 0.6, z);
    if (!nearEdge && rng() < 0.45) continue;
    p.set(x, 0, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng() * Math.PI * 2);
    const k = 0.55 + rng() * 0.5 + (nearEdge ? 0.15 : 0);
    s.set(k, k * (0.8 + rng() * 0.5), k);
    m.compose(p, q, s);
    mesh.setMatrixAt(placed, m);
    tint.setHSL(0.23 + rng() * 0.05, 0.42 + rng() * 0.15, 0.2 + rng() * 0.08);
    mesh.setColorAt(placed, tint);
    placed++;
  }
  mesh.count = placed;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return { mesh, capacity: placed, time, wind };
}

/* ------------------------------------------------------------------ sky */

export function createSkyDome(sky: THREE.Texture, hazeColor: THREE.Color): THREE.Mesh {
  const geo = new THREE.SphereGeometry(400, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: true,
    uniforms: {
      uSky: { value: sky },
      uHaze: { value: hazeColor },
      uExposure: { value: 0.62 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      uniform sampler2D uSky;
      uniform vec3 uHaze;
      uniform float uExposure;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
        vec3 c = texture2D(uSky, uv).rgb * uExposure;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // Same haze the fog uses, so tree lines dissolve into sky instead of cutting against it.
        float haze = 1.0 - smoothstep(-0.02, 0.32, d.y);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, haze * 0.92);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

/* ------------------------------------------------------------------ assembly */

export interface Park {
  root: THREE.Group;
  grass: GrassField;
}

export function createPark(assets: SceneAssets): Park {
  const root = new THREE.Group();
  root.name = 'park';
  const grass = createGrass();
  root.add(createBench(assets), createTrees(), createHedges(), createLampPost(), grass.mesh);
  return { root, grass };
}
