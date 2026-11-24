import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/random';

export interface Bread {
  readonly object: THREE.Object3D;
  /** World point on the torn edge where the next crumb comes away. */
  tearPoint(out?: THREE.Vector3): THREE.Vector3;
  /** Visible tear: a bite comes out of the side facing the throw, with a pinch, squash and wobble. */
  tear(toward: THREE.Vector3, strength?: number): void;
  /** While aiming, the slice leans a touch as if a finger is pulling at it. 0 = rest. */
  setPull(toward: THREE.Vector3 | null, amount: number): void;
  setShadows(on: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

/** Slice width in metres; a sandwich loaf slice is about this wide. */
const SLICE_SCALE = 0.115;

/** Cheap smooth value noise, enough to make the slice look hand-torn rather than machined. */
function makeNoise(seed: number) {
  const rnd = mulberry32(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = rnd();
  const hash = (x: number, y: number, z: number) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return perm[(h ^ (h >>> 16)) & 511];
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const c = (dx: number, dy: number, dz: number) => hash(xi + dx, yi + dy, zi + dz);
    const x00 = lerp(c(0, 0, 0), c(1, 0, 0), xf), x10 = lerp(c(0, 1, 0), c(1, 1, 0), xf);
    const x01 = lerp(c(0, 0, 1), c(1, 0, 1), xf), x11 = lerp(c(0, 1, 1), c(1, 1, 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf) * 2 - 1;
  };
}

function makeCrumbTextures(seed: number): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 256;
  const rnd = mulberry32(seed);
  const colour = document.createElement('canvas');
  const height = document.createElement('canvas');
  colour.width = colour.height = height.width = height.height = size;
  const c = colour.getContext('2d')!;
  const h = height.getContext('2d')!;

  c.fillStyle = '#efdcb4';
  c.fillRect(0, 0, size, size);
  h.fillStyle = '#9a9a9a';
  h.fillRect(0, 0, size, size);

  // Big soft blotches first so the crumb isn't a uniform beige.
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size, y = rnd() * size, r = 10 + rnd() * 30;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const warm = rnd() > 0.5;
    g.addColorStop(0, warm ? 'rgba(214,180,120,0.25)' : 'rgba(250,240,215,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Pores: drawn on both maps at the same spots so colour and relief agree. Tiled draw keeps the texture seamless.
  const pore = (ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, a: number, fill: string) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, rx, ry, a, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
      }
    }
  };
  for (let i = 0; i < 1100; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 0.6 + Math.pow(rnd(), 2.4) * 4.2;
    const stretch = 0.5 + rnd() * 0.7;
    const a = rnd() * Math.PI;
    pore(c, x + 0.6, y + 0.6, r * 1.1, r * stretch * 1.1, a, 'rgba(255,249,232,0.55)');
    pore(c, x, y, r, r * stretch, a, `rgba(${170 + rnd() * 30},${130 + rnd() * 25},${80 + rnd() * 20},0.65)`);
    pore(h, x, y, r, r * stretch, a, `rgba(20,20,20,${0.5 + rnd() * 0.4})`);
  }
  for (let i = 0; i < 500; i++) {
    const x = rnd() * size, y = rnd() * size;
    pore(h, x, y, 0.8 + rnd() * 1.6, 0.6 + rnd(), rnd() * Math.PI, 'rgba(235,235,235,0.5)');
  }

  const map = new THREE.CanvasTexture(colour);
  map.colorSpace = THREE.SRGBColorSpace;
  const bump = new THREE.CanvasTexture(height);
  for (const t of [map, bump]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  return { map, bump };
}

interface SliceGeometry {
  geometry: THREE.BufferGeometry;
  /** Torn-edge midpoint in shape space (pre-rotation, pre-scale). */
  tearLocal: THREE.Vector3;
  /** Shape-space point bites shrink toward; inside the slice from every direction. */
  centre: THREE.Vector2;
  /** Outline distance from `centre` per angle, for placing crumbs on the bitten edge. */
  edgeRadius: (angle: number) => number;
  depth: number;
}

/** Bites never take the slice below this fraction of its radius, so it always reads as bread. */
const MAX_SHRINK = 0.46;
/** Fraction of the radius one bite takes at its centre. */
const BITE_DEPTH = 0.16;
/** Angular half-width of one bite, radians. Wide enough that the cap triangulation can't fold. */
const BITE_HALF_WIDTH = 0.42;
const MAX_BITES = 18;
/** Seconds of quiet before the slice starts making itself whole again. */
const HEAL_DELAY = 1.8;
/** Bite amount lost per second while healing; one full bite closes in about four seconds. */
const HEAL_RATE = 0.26;
const BITE_GROW_RATE = 9;

function buildSlice(seed: number): SliceGeometry {
  const rnd = mulberry32(seed);
  const jitter = (a: number) => (rnd() * 2 - 1) * a;

  // Classic sandwich-loaf slice: straight-ish sides, a domed top that overhangs a little.
  // The lower-left corner is torn away, which is where crumbs come from.
  const tornStart = new THREE.Vector2(-0.45, 0.02);
  const tornEnd = new THREE.Vector2(-0.1, -0.5);
  const torn: THREE.Vector2[] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = tornStart.clone().lerp(tornEnd, t);
    // Bulge inward a touch, like a bite-sized tug rather than a knife line.
    const inward = Math.sin(t * Math.PI) * 0.09;
    p.x += inward * 0.85 + (i === 0 || i === steps ? 0 : jitter(0.035));
    p.y += inward * 0.5 + (i === 0 || i === steps ? 0 : jitter(0.035));
    torn.push(p);
  }

  const shape = new THREE.Shape();
  shape.moveTo(tornEnd.x, tornEnd.y);
  shape.lineTo(0.38, -0.5);
  shape.quadraticCurveTo(0.45, -0.5, 0.45, -0.42);
  shape.lineTo(0.44, 0.22);
  shape.bezierCurveTo(0.58, 0.26, 0.6, 0.48, 0.42, 0.56);
  shape.bezierCurveTo(0.2, 0.66, -0.2, 0.66, -0.42, 0.56);
  shape.bezierCurveTo(-0.6, 0.48, -0.58, 0.26, -0.45, 0.22);
  shape.lineTo(tornStart.x, tornStart.y);
  for (let i = 1; i < torn.length; i++) shape.lineTo(torn[i].x, torn[i].y);

  // Long straight edges have a vertex only at each end; even spacing gives bites something to carve anywhere.
  const outline = shape.getSpacedPoints(200);
  if (outline.length > 1 && outline[0].distanceTo(outline[outline.length - 1]) < 1e-6) outline.pop();
  const spaced = new THREE.Shape(outline);

  const depth = 0.12;
  let geo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(spaced, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.028,
    bevelSize: 0.03,
    bevelSegments: 3,
    curveSegments: 14,
  });

  const nearTorn = (x: number, y: number) => {
    let best = Infinity;
    const p = new THREE.Vector2(x, y);
    const seg = new THREE.Vector2();
    for (let i = 0; i < torn.length - 1; i++) {
      const a = torn[i], b = torn[i + 1];
      seg.subVectors(b, a);
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(seg) / seg.lengthSq(), 0, 1);
      best = Math.min(best, p.distanceTo(a.clone().addScaledVector(seg, t)));
    }
    return best;
  };

  // Colour per face: caps and the torn edge are soft crumb, the rest is crust.
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const colours = new Float32Array(pos.count * 3);
  const crumb = new THREE.Color('#ffffff');
  const crust = new THREE.Color('#a8662c');
  const crustDark = new THREE.Color('#7f4a1e');
  const tornTint = new THREE.Color('#f2e4c6');
  const tmp = new THREE.Color();
  const noise = makeNoise(seed + 11);
  for (let f = 0; f < pos.count; f += 3) {
    let cx = 0, cy = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      cx += pos.getX(f + k) / 3;
      cy += pos.getY(f + k) / 3;
      nz += Math.abs(nrm.getZ(f + k)) / 3;
    }
    const isCap = nz > 0.97;
    const isTorn = nearTorn(cx, cy) < 0.06;
    for (let k = 0; k < 3; k++) {
      const i = f + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (isCap) tmp.copy(crumb);
      else if (isTorn) tmp.copy(tornTint);
      else tmp.copy(crust).lerp(crustDark, THREE.MathUtils.clamp(0.5 + noise(x * 9, y * 9, z * 9) * 0.7, 0, 1));
      colours[i * 3] = tmp.r;
      colours[i * 3 + 1] = tmp.g;
      colours[i * 3 + 2] = tmp.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geo.deleteAttribute('normal');
  geo = mergeVertices(geo, 1e-5);

  // Lumpy relief and a slight sag: position-only noise keeps split vertices welded visually.
  const p2 = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p2.count; i++) {
    const x = p2.getX(i), y = p2.getY(i), z = p2.getZ(i);
    const n = noise(x * 6, y * 6, z * 6) * 0.018 + noise(x * 17, y * 17, z * 17) * 0.007;
    const torn = nearTorn(x, y);
    const rag = torn < 0.08 ? noise(x * 30, y * 30, z * 30) * 0.03 : 0;
    const sag = -0.035 * (1 - (x * x + y * y) * 2.2);
    p2.setXYZ(i, x + n * 0.6 + rag * 0.5, y + n * 0.6 + rag * 0.5, z + n + rag + sag * (z > depth / 2 ? 1 : 0.3));
  }
  geo.computeVertexNormals();

  const centre = new THREE.Vector2(0.02, 0.08);
  const RADII = 128;
  const radii = new Float32Array(RADII);
  for (let i = 0; i < RADII; i++) {
    const a = (i / RADII) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    // Ray against the outline; the slice is star-shaped about `centre`, so the nearest hit is the edge.
    let hit = Infinity;
    for (let j = 0; j < outline.length; j++) {
      const p = outline[j], q = outline[(j + 1) % outline.length];
      const ex = q.x - p.x, ey = q.y - p.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = p.x - centre.x, wy = p.y - centre.y;
      const t = (wx * ey - wy * ex) / den;
      const u = (wx * dy - wy * dx) / den;
      if (t > 0 && u >= 0 && u <= 1 && t < hit) hit = t;
    }
    radii[i] = Number.isFinite(hit) ? hit : 0.4;
  }
  const edgeRadius = (angle: number) => {
    const f = ((((angle / (Math.PI * 2)) % 1) + 1) % 1) * RADII;
    const i0 = Math.floor(f) % RADII, i1 = (i0 + 1) % RADII;
    return THREE.MathUtils.lerp(radii[i0], radii[i1], f - Math.floor(f));
  };

  const mid = torn[Math.floor(torn.length / 2)];
  return {
    geometry: geo,
    tearLocal: new THREE.Vector3(mid.x + 0.03, mid.y + 0.03, depth + 0.03),
    centre,
    edgeRadius,
    depth,
  };
}

interface Bite {
  angle: number;
  /** 0..1 of a full bite currently carved; eases up when taken, back down when healing. */
  amount: number;
  target: number;
  /** Pushed out by newer bites: heals even while tossing continues. */
  retired: boolean;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** How much of the radius is missing at `angle`, from all live bites. */
function shrinkAt(bites: readonly Bite[], angle: number): number {
  let s = 0;
  for (const b of bites) {
    const d = Math.abs(wrapAngle(angle - b.angle));
    if (d >= BITE_HALF_WIDTH) continue;
    const w = Math.cos((d / BITE_HALF_WIDTH) * Math.PI * 0.5);
    const e = b.amount * b.amount * (3 - 2 * b.amount);
    s += BITE_DEPTH * e * w * w;
  }
  // Soft ceiling rather than a hard clamp so a saturated edge still has a rounded profile.
  return MAX_SHRINK * (1 - Math.exp(-s / MAX_SHRINK));
}

/** Damped spring; tear wobble and pull lean both ride on these. */
class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  constructor(private stiffness: number, private damping: number) {}
  kick(v: number) {
    this.velocity += v;
  }
  step(dt: number) {
    // Sub-step so a long frame on a slow phone can't make the spring explode.
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
  }
}

export function createBread(parent: THREE.Object3D, anchor: THREE.Vector3, shadows: boolean): Bread {
  const seed = 4127;
  const { geometry, tearLocal, centre, edgeRadius, depth } = buildSlice(seed);
  const { map, bump } = makeCrumbTextures(seed);
  const material = new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: 1.6,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
  });

  // Hierarchy: root (anchor + lean) → squash (scale about the base) → mesh (slice lying flat).
  const root = new THREE.Group();
  root.name = 'bread';
  root.position.copy(anchor);
  // The torn edge points at the flock, so crumbs visibly come away from the side facing the birds.
  const baseYaw = Math.PI + 0.55;
  root.rotation.y = baseYaw;
  const squash = new THREE.Group();
  root.add(squash);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.setScalar(SLICE_SCALE);
  // ExtrudeGeometry's bevel pushes the underside below z=0; lift so it rests on the anchor.
  mesh.position.y = 0.028 * SLICE_SCALE + 0.001;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  squash.add(mesh);
  parent.add(root);

  const squashSpring = new Spring(420, 13);
  const pitchSpring = new Spring(260, 9);
  const rollSpring = new Spring(260, 9);
  const pullDir = new THREE.Vector3();
  let pullAmount = 0;
  let pullTarget = 0;

  const tearWorld = new THREE.Vector3();
  const leanAxis = new THREE.Vector3();

  // Bites are carved radially toward `centre`; base positions and colours are kept so healing is exact.
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colAttr = geometry.getAttribute('color') as THREE.BufferAttribute;
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  const basePos = Float32Array.from(posAttr.array as Float32Array);
  const baseCol = Float32Array.from(colAttr.array as Float32Array);
  const vCount = posAttr.count;
  const vAngle = new Float32Array(vCount);
  const vRag = new Float32Array(vCount);
  const vIsCrust = new Uint8Array(vCount);
  const ragNoise = makeNoise(seed + 29);
  for (let i = 0; i < vCount; i++) {
    const x = basePos[i * 3], y = basePos[i * 3 + 1], z = basePos[i * 3 + 2];
    vAngle[i] = Math.atan2(y - centre.y, x - centre.x);
    // Torn bread is ragged, not scalloped: per-vertex roughness that only shows where a bite is.
    vRag[i] = ragNoise(x * 22, y * 22, z * 22);
    vIsCrust[i] = baseCol[i * 3] < 0.99 ? 1 : 0;
  }
  const tornTint = new THREE.Color('#f2e4c6');
  const bites: Bite[] = [];
  let sinceTear = Infinity;
  let lastBiteAngle = 0;
  let dirty = false;

  const carve = () => {
    const p = posAttr.array as Float32Array;
    const c = colAttr.array as Float32Array;
    for (let i = 0; i < vCount; i++) {
      const s = bites.length ? shrinkAt(bites, vAngle[i]) : 0;
      const k = 1 - s * (1 + vRag[i] * 0.35);
      const bx = basePos[i * 3], by = basePos[i * 3 + 1], bz = basePos[i * 3 + 2];
      p[i * 3] = centre.x + (bx - centre.x) * k;
      p[i * 3 + 1] = centre.y + (by - centre.y) * k;
      // A torn edge is a touch thinner than the crusted one, pulled down toward the base.
      p[i * 3 + 2] = bz * (1 - s * 0.35);
      const t = vIsCrust[i] ? THREE.MathUtils.clamp(s / 0.1, 0, 1) : 0;
      c[i * 3] = THREE.MathUtils.lerp(baseCol[i * 3], tornTint.r, t);
      c[i * 3 + 1] = THREE.MathUtils.lerp(baseCol[i * 3 + 1], tornTint.g, t);
      c[i * 3 + 2] = THREE.MathUtils.lerp(baseCol[i * 3 + 2], tornTint.b, t);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  };

  const takeBite = (desired: number) => {
    // An already-gnawed spot sends the next bite to its less-eaten neighbour, so the slice is worked around.
    let angle = wrapAngle(desired);
    if (shrinkAt(bites, angle) > MAX_SHRINK * 0.8) {
      for (let step = 1; step <= 7; step++) {
        const off = step * BITE_HALF_WIDTH * 0.7;
        const l = wrapAngle(desired - off), r = wrapAngle(desired + off);
        const sl = shrinkAt(bites, l), sr = shrinkAt(bites, r);
        if (Math.min(sl, sr) <= MAX_SHRINK * 0.8) {
          angle = sl <= sr ? l : r;
          break;
        }
      }
    }
    bites.push({ angle, amount: 0, target: 1, retired: false });
    let live = 0;
    for (let i = bites.length - 1; i >= 0; i--) {
      if (!bites[i].retired && ++live > MAX_BITES) bites[i].retired = true;
    }
    lastBiteAngle = angle;
    sinceTear = 0;
    dirty = true;
  };

  const toLocalDir = (worldDir: THREE.Vector3, out: THREE.Vector3) => {
    // Lean is expressed in the root's own yaw frame so pitch/roll mean the same whatever way the slice faces.
    const c = Math.cos(-baseYaw), s = Math.sin(-baseYaw);
    out.set(worldDir.x * c + worldDir.z * s, 0, -worldDir.x * s + worldDir.z * c);
    if (out.lengthSq() > 1e-6) out.normalize();
    return out;
  };

  return {
    object: root,
    tearPoint(out = new THREE.Vector3()) {
      mesh.updateWorldMatrix(true, false);
      if (!Number.isFinite(sinceTear)) return out.copy(tearLocal).applyMatrix4(mesh.matrixWorld);
      // Where the latest bite sits once carved, so the crumb visibly comes away from the gap.
      const r = edgeRadius(lastBiteAngle) * (1 - Math.max(shrinkAt(bites, lastBiteAngle), BITE_DEPTH * 0.6));
      out.set(centre.x + Math.cos(lastBiteAngle) * r, centre.y + Math.sin(lastBiteAngle) * r, depth * 0.7);
      return out.applyMatrix4(mesh.matrixWorld);
    },
    tear(toward, strength = 1) {
      tearWorld.subVectors(toward, root.position).setY(0);
      toLocalDir(tearWorld, leanAxis);
      // The mesh lies flat via a -90 degree x rotation, so the root frame's +z is the shape's -y.
      takeBite(Math.atan2(-leanAxis.z, leanAxis.x) + (Math.random() * 2 - 1) * 0.3);
      squashSpring.kick(-5.5 * strength);
      // The slice flicks away from the pull, the way it does when a piece finally gives.
      pitchSpring.kick(-leanAxis.z * 4.5 * strength);
      rollSpring.kick(leanAxis.x * 4.5 * strength);
    },
    setPull(toward, amount) {
      if (toward) pullDir.subVectors(toward, root.position).setY(0);
      pullTarget = toward ? THREE.MathUtils.clamp(amount, 0, 1) : 0;
    },
    setShadows(on) {
      mesh.castShadow = on;
      mesh.receiveShadow = on;
    },
    update(dt) {
      sinceTear += dt;
      const healing = sinceTear > HEAL_DELAY;
      for (let i = bites.length - 1; i >= 0; i--) {
        const b = bites[i];
        if (healing || b.retired) b.target = 0;
        if (b.amount < b.target) b.amount = Math.min(b.target, b.amount + dt * BITE_GROW_RATE);
        else if (b.amount > b.target) b.amount = Math.max(b.target, b.amount - dt * HEAL_RATE);
        else continue;
        dirty = true;
        if (b.amount <= 0 && b.target <= 0) bites.splice(i, 1);
      }
      if (dirty) {
        carve();
        dirty = false;
      }
      pullAmount += (pullTarget - pullAmount) * (1 - Math.exp(-dt * 14));
      toLocalDir(pullDir, leanAxis);
      pitchSpring.target = leanAxis.z * 0.09 * pullAmount;
      rollSpring.target = -leanAxis.x * 0.09 * pullAmount;
      squashSpring.target = -0.05 * pullAmount;
      squashSpring.step(dt);
      pitchSpring.step(dt);
      rollSpring.step(dt);
      const s = squashSpring.value;
      squash.scale.set(1 - s * 0.35, 1 + s, 1 - s * 0.35);
      squash.rotation.set(pitchSpring.value, 0, rollSpring.value);
    },
    dispose() {
      parent.remove(root);
      geometry.dispose();
      material.dispose();
      map.dispose();
      bump.dispose();
    },
  };
}
