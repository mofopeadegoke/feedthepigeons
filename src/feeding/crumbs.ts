import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EventBus, InputKind } from '../contracts';
import { mulberry32 } from '../core/random';
import { TUNING } from './tuning';

export type CrumbPhase = 'flying' | 'bouncing' | 'sliding' | 'resting' | 'fading' | 'gone';

export interface Crumb {
  readonly id: number;
  /** 1-based order of tossing this visit; the offended flock counts these. */
  readonly order: number;
  phase: CrumbPhase;
  size: number;
  pecksLeft: number;
  /** Where birds should head: predicted landing while airborne, actual spot once down (y = 0). */
  readonly ground: THREE.Vector3;
  readonly tossedAt: number;
  landedAt: number;
  /** Opaque owner tag: the bird currently pecking it. Others retarget instead of piling in. */
  claimedBy: unknown;
}

export interface TossOptions {
  input: InputKind;
  apex: number;
  spin: number;
}

export interface Crumbs {
  readonly all: readonly Crumb[];
  toss(from: THREE.Vector3, to: THREE.Vector3, t: number, opts: TossOptions): Crumb;
  /** A bite that doesn't finish it: the crumb shrinks and skitters a little way. */
  bite(c: Crumb, away: THREE.Vector3): void;
  eat(c: Crumb, pigeonName: string | null, isGerald: boolean): void;
  isEdible(c: Crumb): boolean;
  isOnGround(c: Crumb): boolean;
  update(dt: number, t: number): void;
  setShadows(on: boolean): void;
  dispose(): void;
}

interface CrumbBody extends Crumb {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  flightT: number;
  flightDur: number;
  vy0: number;
  spinAxis: THREE.Vector3;
  spinSpeed: number;
  baseScale: THREE.Vector3;
  shrink: number;
  fade: number;
  landedOnce: boolean;
}

const VARIANTS = 7;

function buildCrumbGeometries(): THREE.BufferGeometry[] {
  const rnd = mulberry32(90210);
  const crust = new THREE.Color('#a4652f');
  const crustDark = new THREE.Color('#82501f');
  const soft = new THREE.Color('#f1e0bb');
  const softShade = new THREE.Color('#dcc596');
  const out: THREE.BufferGeometry[] = [];
  for (let v = 0; v < VARIANTS; v++) {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const colours = new Float32Array(pos.count * 3);
    // Each variant gets a crust side (some have none) at a random direction.
    const crustDir = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const hasCrust = rnd() > 0.35;
    const p = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      // Torn bread is lumpy with the odd flat break; mix a random push with a few flattened facets.
      const push = 0.72 + rnd() * 0.5;
      p.multiplyScalar(push);
      if (p.y < -0.45) p.y = -0.45 - (p.y + 0.45) * 0.2;
      pos.setXYZ(i, p.x, p.y, p.z);
      const isCrust = hasCrust && p.clone().normalize().dot(crustDir) > 0.45;
      if (isCrust) c.copy(crust).lerp(crustDark, rnd());
      else c.copy(soft).lerp(softShade, rnd() * 0.8);
      colours[i * 3] = c.r;
      colours[i * 3 + 1] = c.g;
      colours[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    g.computeVertexNormals();
    out.push(g);
  }
  return out;
}

export function createCrumbs(parent: THREE.Object3D, bus: EventBus, shadows: boolean): Crumbs {
  const rnd = mulberry32(Date.now() & 0xffff);
  const geometries = buildCrumbGeometries();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  const group = new THREE.Group();
  group.name = 'crumbs';
  parent.add(group);

  const all: CrumbBody[] = [];
  let nextId = 1;
  let order = 0;
  let castShadows = shadows;
  const g = TUNING.arc.gravity;
  const tmpQ = new THREE.Quaternion();

  const restY = (c: CrumbBody) => c.size * 0.42 * c.shrink;

  const remove = (c: CrumbBody) => {
    group.remove(c.mesh);
    c.phase = 'gone';
    const i = all.indexOf(c);
    if (i >= 0) all.splice(i, 1);
  };

  const enforceGroundLimit = () => {
    const resting = all.filter((c) => c.phase === 'resting' || c.phase === 'sliding');
    let excess = resting.length - TUNING.crumb.maxOnGround;
    if (excess <= 0) return;
    // Oldest first, but never pull a crumb out from under a beak mid-peck.
    resting.sort((a, b) => a.landedAt - b.landedAt);
    for (const c of resting) {
      if (excess <= 0) break;
      if (c.claimedBy) continue;
      c.phase = 'fading';
      c.fade = 0;
      excess--;
    }
  };

  const bounceImpact = (c: CrumbBody, t: number) => {
    if (!c.landedOnce) {
      c.landedOnce = true;
      c.landedAt = t;
      c.ground.set(c.pos.x, 0, c.pos.z);
      bus.emit('crumb:landed', { id: c.id, at: c.ground.clone() });
    }
    const vy = Math.abs(c.vel.y);
    if (vy < 0.45) {
      c.vel.y = 0;
      c.phase = 'sliding';
      enforceGroundLimit();
      return;
    }
    c.vel.y = vy * TUNING.crumb.restitution * (0.8 + rnd() * 0.4);
    // Bread is soft: most of the carry dies on first touch, then a short skitter.
    c.vel.x *= 0.38;
    c.vel.z *= 0.38;
    c.spinSpeed *= 0.45;
  };

  const crumbs: Crumbs = {
    all,
    toss(from, to, t, opts) {
      const size = THREE.MathUtils.lerp(TUNING.crumb.sizeMin, TUNING.crumb.sizeMax, Math.pow(rnd(), 1.3));
      const mesh = new THREE.Mesh(geometries[Math.floor(rnd() * VARIANTS)], material);
      mesh.castShadow = castShadows;
      mesh.receiveShadow = castShadows;
      const baseScale = new THREE.Vector3(size * (0.85 + rnd() * 0.3), size * (0.55 + rnd() * 0.25), size * (0.75 + rnd() * 0.3));
      mesh.scale.copy(baseScale).multiplyScalar(0.4);
      mesh.quaternion.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
      mesh.position.copy(from);
      group.add(mesh);

      const c: CrumbBody = {
        id: nextId++,
        order: ++order,
        phase: 'flying',
        size,
        pecksLeft: size > TUNING.crumb.twoPeckSize ? 2 : 1,
        ground: new THREE.Vector3(to.x, 0, to.z),
        tossedAt: t,
        landedAt: Infinity,
        claimedBy: null,
        mesh,
        pos: from.clone(),
        vel: new THREE.Vector3(),
        from: from.clone(),
        to: to.clone(),
        flightT: 0,
        flightDur: 0,
        vy0: 0,
        spinAxis: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(),
        spinSpeed: opts.spin * (rnd() > 0.5 ? 1 : -1),
        baseScale,
        shrink: 1,
        fade: 0,
        landedOnce: false,
      };
      const rest = restY(c);
      c.to.y = rest;
      const apexY = Math.max(from.y, rest) + opts.apex;
      c.vy0 = Math.sqrt(2 * g * (apexY - from.y));
      c.flightDur = c.vy0 / g + Math.sqrt((2 * (apexY - rest)) / g);
      all.push(c);
      bus.emit('crumb:tossed', { id: c.id, from: from.clone(), to: c.ground.clone(), input: opts.input });
      return c;
    },
    bite(crumb, away) {
      const c = crumb as CrumbBody;
      c.pecksLeft = Math.max(1, c.pecksLeft - 1);
      c.shrink *= 0.62;
      c.size *= 0.62;
      c.claimedBy = null;
      const dir = new THREE.Vector3(away.x, 0, away.z);
      if (dir.lengthSq() < 1e-6) dir.set(rnd() - 0.5, 0, rnd() - 0.5);
      dir.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), (rnd() - 0.5) * 1.2);
      c.vel.copy(dir).multiplyScalar(0.35 + rnd() * 0.3);
      c.vel.y = 0.7 + rnd() * 0.4;
      c.spinSpeed = 10 * (rnd() > 0.5 ? 1 : -1);
      c.phase = 'bouncing';
    },
    eat(crumb, pigeonName, isGerald) {
      const c = crumb as CrumbBody;
      if (c.phase === 'gone') return;
      remove(c);
      bus.emit('crumb:eaten', { id: c.id, pigeonName, isGerald });
    },
    isEdible(c) {
      return c.phase !== 'fading' && c.phase !== 'gone';
    },
    isOnGround(c) {
      return c.phase === 'resting' || c.phase === 'sliding';
    },
    update(dt, t) {
      for (let i = all.length - 1; i >= 0; i--) {
        const c = all[i];
        const m = c.mesh;
        if (c.phase === 'flying') {
          c.flightT += dt;
          const ft = Math.min(c.flightT, c.flightDur);
          const k = ft / c.flightDur;
          c.pos.set(
            c.from.x + (c.to.x - c.from.x) * k,
            c.from.y + c.vy0 * ft - 0.5 * g * ft * ft,
            c.from.z + (c.to.z - c.from.z) * k,
          );
          // Pops to full size as it leaves the slice, so the tear reads as a piece coming away.
          const grow = Math.min(1, c.flightT / 0.12);
          m.scale.copy(c.baseScale).multiplyScalar(0.4 + 0.6 * grow);
          if (c.flightT >= c.flightDur) {
            const vh = 1 / c.flightDur;
            c.vel.set((c.to.x - c.from.x) * vh, c.vy0 - g * c.flightDur, (c.to.z - c.from.z) * vh);
            c.pos.copy(c.to);
            c.phase = 'bouncing';
            bounceImpact(c, t);
          }
        } else if (c.phase === 'bouncing') {
          c.vel.y -= g * dt;
          c.pos.addScaledVector(c.vel, dt);
          const rest = restY(c);
          if (c.pos.y <= rest) {
            c.pos.y = rest;
            bounceImpact(c, t);
          }
          c.ground.set(c.pos.x, 0, c.pos.z);
        } else if (c.phase === 'sliding') {
          const sp = Math.hypot(c.vel.x, c.vel.z);
          const nsp = Math.max(0, sp - TUNING.crumb.groundFriction * dt);
          if (nsp < 0.01) {
            c.vel.set(0, 0, 0);
            c.phase = 'resting';
          } else {
            c.vel.x *= nsp / sp;
            c.vel.z *= nsp / sp;
          }
          c.pos.x += c.vel.x * dt;
          c.pos.z += c.vel.z * dt;
          c.ground.set(c.pos.x, 0, c.pos.z);
          c.spinSpeed *= Math.exp(-dt * 12);
        } else if (c.phase === 'fading') {
          c.fade += dt / TUNING.crumb.fadeSeconds;
          const k = Math.min(1, c.fade);
          // Shrinks into the ground rather than blinking out, as if trodden in or blown off.
          m.scale.copy(c.baseScale).multiplyScalar(c.shrink * (1 - k * k));
          c.pos.y = restY(c) * (1 - k) - k * 0.004;
          if (k >= 1) {
            remove(c);
            bus.emit('crumb:faded', { id: c.id });
            continue;
          }
        }

        if (c.phase !== 'flying' && c.phase !== 'fading') {
          m.scale.lerp(c.baseScale.clone().multiplyScalar(c.shrink), 1 - Math.exp(-dt * 18));
        }
        if (c.spinSpeed !== 0 && c.phase !== 'resting') {
          tmpQ.setFromAxisAngle(c.spinAxis, c.spinSpeed * dt);
          m.quaternion.premultiply(tmpQ);
        }
        m.position.copy(c.pos);
      }
    },
    setShadows(on) {
      castShadows = on;
      for (const c of all) {
        c.mesh.castShadow = on;
        c.mesh.receiveShadow = on;
      }
    },
    dispose() {
      for (const c of [...all]) remove(c);
      parent.remove(group);
      for (const geo of geometries) geo.dispose();
      material.dispose();
    },
  };

  return crumbs;
}
