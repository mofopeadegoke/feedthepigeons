import * as THREE from 'three';
import { BONE, EYE_R, MORPH, REST, smooth, spreadCenter } from './rig';
import { cone, ell, smin, surfaceNets } from './sdf';

/** Part ids read by the shader to pick a colour model. */
export const PART = { body: 0, wing: 1, tail: 2, leg: 3, eye: 4 } as const;

type Weights = Array<[number, number]>;

/* ------------------------------------------------------------------ body field */

function core(x: number, y: number, z: number): number {
  let d = ell(x, y, z, 0, 0.108, -0.008, 0.046, 0.05, 0.088, 0.22);
  d = smin(d, ell(x, y, z, 0, 0.127, 0.038, 0.043, 0.048, 0.046), 0.03);
  d = smin(d, ell(x, y, z, 0, 0.096, -0.07, 0.029, 0.024, 0.047, 0.25), 0.022);
  d = smin(d, ell(Math.abs(x), y, z, 0.019, 0.062, 0.004, 0.019, 0.025, 0.028), 0.018);
  d = smin(d, cone(x, y, z, 0, 0.138, 0.045, 0, 0.197, 0.083, 0.029, 0.0175), 0.024);
  d = smin(d, ell(x, y, z, 0, 0.211, 0.092, 0.0205, 0.021, 0.025, -0.12), 0.014);
  return d;
}
const beakD = (x: number, y: number, z: number) => cone(x, y, z, 0, 0.2078, 0.11, 0, 0.2036, 0.1342, 0.0052, 0.0011);
const cereD = (x: number, y: number, z: number) => ell(x, y, z, 0, 0.2113, 0.1137, 0.005, 0.0036, 0.0068, 0.1);

export function bodyField(x: number, y: number, z: number): number {
  return smin(smin(core(x, y, z), beakD(x, y, z), 0.0035), cereD(x, y, z), 0.0015);
}

function grad(f: (x: number, y: number, z: number) => number, x: number, y: number, z: number, e: number, out: THREE.Vector3) {
  return out.set(
    f(x + e, y, z) - f(x - e, y, z),
    f(x, y + e, z) - f(x, y - e, z),
    f(x, y, z + e) - f(x, y, z - e),
  ).divideScalar(2 * e);
}

/** Half-width of the body at (y, z): where the folded wing must sit to hug the flank. */
function surfX(y: number, z: number): number {
  if (bodyField(0, y, z) >= 0) return 0;
  let lo = 0, hi = 0.09;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (bodyField(m, y, z) < 0) lo = m;
    else hi = m;
  }
  return lo;
}

/* ------------------------------------------------------------------ accumulator */

class Acc {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  part: number[] = [];
  mask: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  mp: number[][] = [[], [], []];
  mn: number[][] = [[], [], []];
  idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  vert(
    p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, part: number,
    m0: number, m1: number, w: Weights,
    morph?: { slot: number; dp: THREE.Vector3; dn: THREE.Vector3 },
  ): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.part.push(part);
    this.mask.push(m0, m1, 0);
    const ws = w.filter((e) => e[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ws.reduce((s, e) => s + e[1], 0) || 1;
    for (let i = 0; i < 4; i++) {
      this.si.push(ws[i] ? ws[i][0] : 0);
      this.sw.push(ws[i] ? ws[i][1] / sum : 0);
    }
    for (let s = 0; s < 3; s++) {
      if (morph && morph.slot === s) {
        this.mp[s].push(morph.dp.x, morph.dp.y, morph.dp.z);
        this.mn[s].push(morph.dn.x, morph.dn.y, morph.dn.z);
      } else {
        this.mp[s].push(0, 0, 0);
        this.mn[s].push(0, 0, 0);
      }
    }
    return this.count - 1;
  }
}

/* ------------------------------------------------------------------ body */

function buildBody(acc: Acc, cell: number) {
  const { positions, indices } = surfaceNets(bodyField, [-0.066, 0.03, -0.135], [0.066, 0.252, 0.152], cell);
  const p = new THREE.Vector3();
  const g = new THREE.Vector3();
  const A = new THREE.Vector3(0, 0.135, 0.04);
  const D = REST.head.clone().sub(A);
  const dd = D.lengthSq();
  const base = acc.count;
  for (let i = 0; i < positions.length; i += 3) {
    p.set(positions[i], positions[i + 1], positions[i + 2]);
    // Surface nets vertices sit near, not on, the surface; projecting keeps the silhouette crisp.
    for (let it = 0; it < 3; it++) {
      const d = bodyField(p.x, p.y, p.z);
      grad(bodyField, p.x, p.y, p.z, cell * 0.2, g);
      p.addScaledVector(g, -d / Math.max(g.lengthSq(), 1e-8));
    }
    grad(bodyField, p.x, p.y, p.z, cell * 0.3, g).normalize();
    const mBeak = smooth(0.0022, -0.0004, beakD(p.x, p.y, p.z));
    const mCere = smooth(0.0016, -0.0003, cereD(p.x, p.y, p.z));
    const s = p.clone().sub(A).dot(D) / dd;
    let wHead = smooth(0.64, 0.92, s);
    if (mBeak > 0 || mCere > 0 || p.z > 0.108) wHead = 1;
    const wNeck = smooth(0.04, 0.5, s) * (1 - wHead) * smooth(-0.01, 0.03, p.z);
    const wBody = Math.max(0, 1 - wHead - wNeck);
    acc.vert(p, g, 0, 0, PART.body, mBeak, mCere, [[BONE.body, wBody], [BONE.neck, wNeck], [BONE.head, wHead]]);
  }
  for (const i of indices) acc.idx.push(base + i);
}

/* ------------------------------------------------------------------ thin plates (wings, tail) */

interface Plate {
  na: number;
  nb: number;
  /** a in [0,1] along the plate, b in [-1,1] across it. state 0 = rest, 1 = morph target. */
  center(a: number, b: number, state: number, out: THREE.Vector3): void;
  up(a: number, b: number, state: number, out: THREE.Vector3): void;
  thick(a: number, b: number): number;
  weights(a: number, b: number): Weights;
  part: number;
  slot: number;
  mirror: boolean;
}

function buildPlate(acc: Acc, P: Plate) {
  const { na, nb } = P;
  const cols = na + 1, rows = nb + 1;
  const grid = (state: number, sign: number) => {
    const pts: THREE.Vector3[] = [];
    const c = new THREE.Vector3(), up = new THREE.Vector3();
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const a = i / na;
        const b = -Math.cos((Math.PI * j) / nb);
        P.center(a, b, state, c);
        P.up(a, b, state, up);
        const t = P.thick(a, b) * (sign > 0 ? 0.6 : 0.4);
        const q = c.clone().addScaledVector(up.normalize(), sign * t);
        if (P.mirror) q.x = -q.x;
        pts.push(q);
      }
    return pts;
  };
  const normals = (pts: THREE.Vector3[], state: number, sign: number) => {
    const out: THREE.Vector3[] = [];
    const up = new THREE.Vector3();
    const at = (i: number, j: number) => pts[Math.min(cols - 1, Math.max(0, i)) * rows + Math.min(rows - 1, Math.max(0, j))];
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const du = at(i + 1, j).clone().sub(at(i - 1, j));
        const dv = at(i, j + 1).clone().sub(at(i, j - 1));
        const n = du.cross(dv);
        P.up(i / na, -Math.cos((Math.PI * j) / nb), state, up);
        if (P.mirror) up.x = -up.x;
        up.normalize().multiplyScalar(sign);
        if (n.lengthSq() < 1e-14) n.copy(up);
        n.normalize();
        if (n.dot(up) < 0) n.negate();
        // Edge normals blend toward the plate normal so the rim doesn't read as a hard crease.
        out.push(n);
      }
    return out;
  };
  for (const sign of [1, -1]) {
    const p0 = grid(0, sign), n0 = normals(p0, 0, sign);
    const morph = P.slot >= 0;
    const p1 = morph ? grid(1, sign) : p0;
    const n1 = morph ? normals(p1, 1, sign) : n0;
    const base = acc.count;
    for (let i = 0; i < cols; i++)
      for (let j = 0; j < rows; j++) {
        const k = i * rows + j;
        const a = i / na, b = -Math.cos((Math.PI * j) / nb);
        acc.vert(p0[k], n0[k], a, b, P.part, 0, 0, P.weights(a, b),
          morph ? { slot: P.slot, dp: p1[k].clone().sub(p0[k]), dn: n1[k].clone().sub(n0[k]) } : undefined);
      }
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
    for (let i = 0; i < na; i++)
      for (let j = 0; j < nb; j++) {
        const a = i * rows + j, b = (i + 1) * rows + j, c = (i + 1) * rows + j + 1, d = i * rows + j + 1;
        e1.subVectors(p0[b], p0[a]);
        e2.subVectors(p0[c], p0[a]);
        fn.crossVectors(e1, e2);
        if (fn.lengthSq() < 1e-16) {
          e1.subVectors(p0[c], p0[a]);
          e2.subVectors(p0[d], p0[a]);
          fn.crossVectors(e1, e2);
        }
        const avg = n0[a].clone().add(n0[b]).add(n0[c]).add(n0[d]);
        if (fn.dot(avg) >= 0) acc.idx.push(base + a, base + b, base + c, base + a, base + c, base + d);
        else acc.idx.push(base + a, base + c, base + b, base + a, base + d, base + c);
      }
  }
}

function foldedCenter(u: number, v: number, out: THREE.Vector3) {
  const z = 0.058 - 0.222 * u;
  const ymid = 0.143 - 0.06 * u + 0.02 * u * u;
  const H = 0.033 * Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.pow(u, 0.6)))) * (1 - 0.5 * u);
  const y = ymid + H * v;
  const x = Math.max(surfX(y, z) + 0.0032 + 0.004 * u, 0.007 + 0.008 * (1 - u));
  return out.set(x, y, z);
}

function buildWing(acc: Acc, mirror: boolean, na: number, nb: number) {
  const sh = mirror ? BONE.wingR : BONE.wingL;
  const tip = mirror ? BONE.wingRTip : BONE.wingLTip;
  // surfX is expensive; folded centres don't depend on the side so cache them per (a, b).
  const cache = new Map<string, THREE.Vector3>();
  buildPlate(acc, {
    na, nb, part: PART.wing, slot: mirror ? MORPH.wingR : MORPH.wingL, mirror,
    center(a, b, state, out) {
      if (state === 1) {
        spreadCenter(a, b, out);
        return;
      }
      const key = `${a.toFixed(5)},${b.toFixed(5)}`;
      let c = cache.get(key);
      if (!c) cache.set(key, (c = foldedCenter(a, b, new THREE.Vector3())));
      out.copy(c);
    },
    up(_a, b, state, out) {
      if (state === 1) out.set(0, 1, 0);
      else out.set(1, 0.55 * Math.max(0, b), 0);
    },
    thick(a, b) {
      const edge = Math.sqrt(Math.min(1, a / 0.06)) * Math.sqrt(Math.max(0, Math.min(1, (1 - a) / 0.1)));
      return 0.0085 * Math.sqrt(Math.max(0, 1 - b * b)) * edge * (1 - 0.45 * a);
    },
    weights(a) {
      const wt = smooth(0.32, 0.52, a);
      return [[sh, 1 - wt], [tip, wt]];
    },
  });
}

function buildTail(acc: Acc, na: number, nb: number) {
  const B = new THREE.Vector3(0, 0.104, -0.045);
  const T = new THREE.Vector3(0, 0.074, -0.172);
  buildPlate(acc, {
    na, nb, part: PART.tail, slot: MORPH.tail, mirror: false,
    center(a, b, state, out) {
      const w = state === 0 ? 0.017 + 0.017 * a : 0.017 + 0.072 * Math.pow(a, 0.8);
      const len = a * (1 - 0.07 * b * b);
      out.lerpVectors(B, T, len);
      out.y += -0.004 * b * b + (state === 1 ? 0.006 * a : 0) - 0.006 * Math.sin(Math.PI * a) * 0.5;
      // b grows toward the bird's right so the plate's top faces up with consistent winding.
      out.x = -b * w;
    },
    up(_a, _b, _s, out) {
      out.set(0, 1, 0.24);
    },
    thick(a, b) {
      const edge = Math.sqrt(Math.min(1, a / 0.05)) * Math.sqrt(Math.max(0, Math.min(1, (1 - a) / 0.06)));
      return 0.009 * (1 - 0.6 * a) * Math.sqrt(Math.max(0, 1 - b * b)) * edge;
    },
    weights(a) {
      const wb = 1 - smooth(0.0, 0.2, a);
      return [[BONE.tail, 1 - wb], [BONE.body, wb]];
    },
  });
}

/* ------------------------------------------------------------------ legs, eyes */

function tube(
  acc: Acc, pts: THREE.Vector3[], radii: number[], radial: number,
  weights: (t: number) => Weights, isToe: boolean,
) {
  const n = pts.length;
  const ref = new THREE.Vector3(0, 1, 0);
  const base = acc.count;
  const tangents = pts.map((_, i) => pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    const r = Math.abs(t.dot(ref)) > 0.9 ? new THREE.Vector3(1, 0, 0) : ref;
    const s1 = new THREE.Vector3().crossVectors(t, r).normalize();
    const s2 = new THREE.Vector3().crossVectors(s1, t).normalize();
    for (let k = 0; k < radial; k++) {
      const ang = (k / radial) * Math.PI * 2;
      const nrm = s1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(s2, Math.sin(ang));
      const p = pts[i].clone().addScaledVector(nrm, radii[i]);
      acc.vert(p, nrm, isToe ? 1 : 0, i / (n - 1), PART.leg, 0, 0, weights(i / (n - 1)));
    }
  }
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < radial; k++) {
      const a = base + i * radial + k, b = base + i * radial + ((k + 1) % radial);
      const c = a + radial, d = b + radial;
      acc.idx.push(a, c, b, b, c, d);
    }
  const capStart = acc.vert(pts[0].clone().addScaledVector(tangents[0], -radii[0] * 0.7), tangents[0].clone().negate(),
    isToe ? 1 : 0, 0, PART.leg, 0, 0, weights(0));
  const capEnd = acc.vert(pts[n - 1].clone().addScaledVector(tangents[n - 1], radii[n - 1] * 1.2), tangents[n - 1].clone(),
    isToe ? 1 : 0, 1, PART.leg, 0, 0, weights(1));
  for (let k = 0; k < radial; k++) {
    const a = base + k, b = base + ((k + 1) % radial);
    acc.idx.push(capStart, a, b);
    const c = base + (n - 1) * radial + k, d = base + (n - 1) * radial + ((k + 1) % radial);
    acc.idx.push(capEnd, d, c);
  }
}

function buildLeg(acc: Acc, side: 1 | -1, radial: number) {
  const foot = side > 0 ? BONE.footL : BONE.footR;
  const hip = side > 0 ? BONE.hipL : BONE.hipR;
  const A = REST.ankle.clone();
  A.x *= side;
  const H = REST.hip.clone();
  H.x *= side;
  const mid = A.clone().lerp(H, 0.5).add(new THREE.Vector3(0, 0, 0.004));
  tube(acc, [A.clone().add(new THREE.Vector3(0, -0.001, 0)), mid, H], [0.0033, 0.0036, 0.0045], radial,
    (t) => {
      const wf = 1 - smooth(0.15, 0.85, t);
      return [[foot, wf], [hip, 1 - wf]];
    }, false);
  const toes: Array<[number, number]> = [[0.45, 0.032], [0.06, 0.038], [-0.36, 0.031], [Math.PI - 0.15, 0.02]];
  for (const [yaw, len] of toes) {
    const a = side * yaw;
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const start = A.clone().add(new THREE.Vector3(0, -0.0015, 0));
    const p1 = start.clone().addScaledVector(dir, len * 0.45);
    p1.y = 0.0032;
    const p2 = start.clone().addScaledVector(dir, len * 0.85);
    p2.y = 0.0022;
    const p3 = start.clone().addScaledVector(dir, len);
    p3.y = 0.0012;
    tube(acc, [start, p1, p2, p3], [0.0027, 0.0022, 0.0016, 0.0007], Math.max(4, radial - 2), () => [[foot, 1]], true);
  }
}

function buildEyes(acc: Acc, ws: number, hs: number) {
  const sphere = new THREE.SphereGeometry(EYE_R, ws, hs);
  const sp = sphere.getAttribute('position');
  const sn = sphere.getAttribute('normal');
  const si = sphere.getIndex()!;
  for (const side of [1, -1]) {
    const base = acc.count;
    const c = REST.eye.clone();
    c.x *= side;
    for (let i = 0; i < sp.count; i++) {
      const p = new THREE.Vector3(sp.getX(i), sp.getY(i), sp.getZ(i)).add(c);
      const n = new THREE.Vector3(sn.getX(i), sn.getY(i), sn.getZ(i));
      acc.vert(p, n, 0, 0, PART.eye, 0, 0, [[BONE.head, 1]]);
    }
    for (let i = 0; i < si.count; i++) acc.idx.push(base + si.getX(i));
  }
  sphere.dispose();
}

/* ------------------------------------------------------------------ assembly */

export type GeoLevel = 'hi' | 'mid' | 'lo';
const cache = new Map<GeoLevel, THREE.BufferGeometry>();

/** One merged, skinned geometry per detail level, shared by every pigeon (one draw call per bird). */
export function getPigeonGeometry(level: GeoLevel): THREE.BufferGeometry {
  const hit = cache.get(level);
  if (hit) return hit;
  const hi = level !== 'lo';
  const acc = new Acc();
  buildBody(acc, level === 'hi' ? 0.0037 : level === 'mid' ? 0.0047 : 0.0062);
  buildWing(acc, false, hi ? 24 : 14, hi ? 10 : 6);
  buildWing(acc, true, hi ? 24 : 14, hi ? 10 : 6);
  buildTail(acc, hi ? 14 : 8, hi ? 12 : 6);
  buildLeg(acc, 1, hi ? 8 : 5);
  buildLeg(acc, -1, hi ? 8 : 5);
  buildEyes(acc, hi ? 12 : 8, hi ? 8 : 6);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nrm, 3));
  g.setAttribute('aUv', new THREE.Float32BufferAttribute(acc.uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(acc.part, 1));
  g.setAttribute('aMask', new THREE.Float32BufferAttribute(acc.mask, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(acc.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(acc.sw, 4));
  g.morphAttributes.position = acc.mp.map((a) => new THREE.Float32BufferAttribute(a, 3));
  g.morphAttributes.normal = acc.mn.map((a) => new THREE.Float32BufferAttribute(a, 3));
  g.morphTargetsRelative = true;
  g.setIndex(acc.idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.12, 0), 0.42);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.4, -0.05, -0.3), new THREE.Vector3(0.4, 0.4, 0.3));
  cache.set(level, g);
  return g;
}
