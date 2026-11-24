import * as THREE from 'three';
import type { EventBus, Pigeon, PigeonMood, PigeonOptions, Quality, QualityLevel } from '../contracts';
import { mulberry32 } from '../core/random';
import { getPigeonGeometry } from './build';
import { makeBlob, makeMaterial, makeUniforms, type PigeonUniforms } from './material';
import { C, Pose } from './pose';
import { BONE, BONE_COUNT, MORPH, REACH, REST, WRIST } from './rig';
import { lookForSeed } from './variants';

type State = Pigeon['state'];

interface Action {
  state: State;
  airborne: boolean;
  start(): void;
  /** Returns true when finished. */
  update(dt: number): boolean;
  end(interrupted: boolean): void;
}

interface Swing {
  from: THREE.Vector3;
  fromYaw: number;
  t: number;
  dur: number;
  lift: number;
  gait: boolean;
}

interface Foot {
  side: 1 | -1;
  /** Ground contact under the ankle, in the parent's space. */
  world: THREE.Vector3;
  yaw: number;
  pitch: number;
  swing: Swing | null;
}

type GestureKind = 'look' | 'tilt' | 'preen' | 'stretch' | 'coo' | 'ruffle';
interface Gesture {
  kind: GestureKind;
  t: number;
  d: number;
  side: number;
  vals: number[];
  emitted: boolean;
}

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 2.2);
const wrap = (a: number) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const damp = (cur: number, tgt: number, rate: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
/** Rises over `a`, holds, falls over the last `r` seconds of `d`. */
const env = (t: number, d: number, a: number, r: number) => ease(t / a) * (1 - ease((t - (d - r)) / r));

const geoLevel = (l: QualityLevel) => (l === 'high' ? 'hi' : l === 'medium' ? 'mid' : 'lo');
const BEAK_OFF = REST.beakTip.clone().sub(REST.head);
const NECK_LEN = REST.head.distanceTo(REST.neckBase);
const NECK_DIR = REST.head.clone().sub(REST.neckBase).normalize();
const mir = (v: THREE.Vector3, s: number) => new THREE.Vector3(v.x * s, v.y, v.z);
const SHOULDER = [mir(REST.shoulder, 1), mir(REST.shoulder, -1)];
const HIP = [mir(REST.hip, 1), mir(REST.hip, -1)];

// Scratch objects: update() runs for up to 24 birds per frame, so avoid per-frame allocation.
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

export class PigeonImpl implements Pigeon {
  readonly object = new THREE.Group();
  readonly isGerald: boolean;
  readonly temperament: number;
  state: State = 'idle';

  private readonly pos = new THREE.Vector3();
  private yaw = 0;
  private readonly size: number;
  private readonly bus: EventBus;
  private readonly rng: () => number;
  private reduced: boolean;

  private readonly mesh: THREE.SkinnedMesh;
  private readonly bones: THREE.Bone[] = [];
  private readonly uniforms: PigeonUniforms;
  private readonly materials: Partial<Record<QualityLevel, THREE.Material>> = {};
  private level: QualityLevel;
  private readonly blob: THREE.Mesh;
  private shadowsOn: boolean;

  private readonly pose = new Pose();
  private action: Action | null = null;
  private queued: Action | null = null;
  private readonly feet: Foot[];
  private readonly gait = { p: 0, k: -1, L: 0.05, w: 0, mv: 0, advanced: false };
  private speed = 0;
  private readonly invRoot = new THREE.Matrix4();

  private headAbsW = 0;
  private readonly headAbsPos = new THREE.Vector3();
  private readonly headAbsQ = new THREE.Quaternion();

  private mood: PigeonMood = 'calm';
  private readonly viewer = new THREE.Vector3(0, 1.1, 2.2);
  private moodTurning = false;
  private peekT = 3;
  private peekOn = 0;
  private readonly moodSide: number;

  private gesture: Gesture | null = null;
  private gestureCooldown = 1.5;
  private autoIdleT: number;
  private readonly sacc = { t: 0, yaw: 0, pitch: 0, roll: 0 };
  private time = 0;
  private readonly breathPhase: number;
  private groundY = 0;
  private runFlapT = 1.5;
  private runFlap = 0;

  // Bone-space working state, reused every frame.
  private readonly qBody = new THREE.Quaternion();
  private readonly bodyPos = new THREE.Vector3();
  private readonly puffS = new THREE.Vector3(1, 1, 1);

  constructor(opts: PigeonOptions) {
    const look = lookForSeed(opts.seed, opts.isGerald);
    this.isGerald = opts.isGerald;
    this.temperament = look.temperament;
    this.size = look.size;
    this.bus = opts.bus;
    this.reduced = opts.reducedMotion;
    this.rng = mulberry32(opts.seed * 7919 + 3);
    this.moodSide = this.rng() < 0.5 ? 1 : -1;
    this.breathPhase = this.rng() * TAU;
    this.autoIdleT = 4 + this.rng() * 8;
    this.uniforms = makeUniforms(look, opts.seed);
    this.level = opts.quality.level;
    this.shadowsOn = opts.quality.shadows;

    const rest: THREE.Vector3[] = [
      new THREE.Vector3(), REST.body, REST.neck, REST.head,
      SHOULDER[0], WRIST.clone().sub(REST.shoulder), SHOULDER[1], mir(WRIST, -1).sub(SHOULDER[1]),
      REST.tail, HIP[0], HIP[1], mir(REST.ankle, 1), mir(REST.ankle, -1),
    ];
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.position.copy(rest[i]);
      this.bones.push(b);
    }
    const base = this.bones[BONE.base];
    for (let i = 1; i < BONE_COUNT; i++) {
      if (i === BONE.wingLTip) this.bones[BONE.wingL].add(this.bones[i]);
      else if (i === BONE.wingRTip) this.bones[BONE.wingR].add(this.bones[i]);
      else base.add(this.bones[i]);
    }
    const geo = getPigeonGeometry(geoLevel(this.level));
    this.mesh = new THREE.SkinnedMesh(geo, this.material(this.level));
    this.mesh.add(base);
    this.object.add(this.mesh);
    this.object.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.12, 0), 0.45);
    this.mesh.castShadow = this.shadowsOn;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'pigeon';
    this.blob = makeBlob();
    this.object.add(this.blob);
    this.object.name = this.isGerald ? 'pigeon-gerald' : 'pigeon';
    this.object.matrixAutoUpdate = false;

    this.feet = [1, -1].map((side) => ({
      side: side as 1 | -1, world: new THREE.Vector3(), yaw: 0, pitch: 0, swing: null,
    }));
    this.place(new THREE.Vector3(), 0);
    this.setQuality(opts.quality);
  }

  /* ---------------------------------------------------------------- read-only state */

  get position(): THREE.Vector3 {
    return this.pos.clone();
  }
  get heading(): number {
    return this.yaw;
  }
  get reach(): number {
    return REACH * this.size;
  }

  /* ---------------------------------------------------------------- commands */

  place(at: THREE.Vector3, heading: number): void {
    this.cancelAll();
    this.teleport(at, heading);
  }

  private teleport(at: THREE.Vector3, heading: number): void {
    this.pos.copy(at);
    this.groundY = at.y;
    this.yaw = heading;
    this.speed = 0;
    this.gait.k = -1;
    this.gait.w = 0;
    this.headAbsW = 0;
    this.pose.reset();
    this.syncRoot();
    for (const f of this.feet) {
      this.spot(f, f.world);
      f.yaw = heading;
      f.pitch = 0;
      f.swing = null;
    }
    this.applyBones();
  }

  walkTo(target: THREE.Vector3, opts?: { urgency?: number; stopShort?: number }): Promise<'arrived' | 'interrupted'> {
    return new Promise((resolve) => this.run(this.makeWalk(target.clone(), opts?.urgency ?? 0, opts?.stopShort ?? 0, resolve)));
  }

  stop(): void {
    if (this.queued) {
      this.queued.end(true);
      this.queued = null;
    }
    if (this.action && !this.action.airborne) this.finish(true);
  }

  face(point: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => this.run(this.makeFace(point.clone(), resolve)));
  }

  peck(): Promise<void> {
    return new Promise((resolve) => this.run(this.makePeck(resolve)));
  }

  lunge(toward: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => this.run(this.makeLunge(toward.clone(), resolve)));
  }

  sulk(): Promise<void> {
    return new Promise((resolve) => this.run(this.makeSulk(resolve)));
  }

  setMood(mood: PigeonMood, viewer: THREE.Vector3): void {
    if (mood !== this.mood && mood === 'offended') this.peekT = 2 + this.rng() * 3;
    this.mood = mood;
    this.viewer.copy(viewer);
  }

  flyIn(from: THREE.Vector3, to: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => this.run(this.makeFly(from.clone(), to.clone(), resolve)));
  }

  hopTo(target: THREE.Vector3): Promise<void> {
    return new Promise((resolve) => this.run(this.makeHop(target.clone(), resolve)));
  }

  idle(): void {
    if (this.action || this.gesture || this.gestureCooldown > 0) return;
    this.startGesture();
  }

  /** Not in the contract; lets the integrator follow the OS setting live. */
  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  setQuality(q: Quality): void {
    this.level = q.level;
    this.shadowsOn = q.shadows;
    const geo = getPigeonGeometry(geoLevel(q.level));
    if (this.mesh.geometry !== geo) {
      this.mesh.geometry = geo;
      this.mesh.updateMorphTargets();
    }
    this.mesh.material = this.material(q.level);
    this.mesh.castShadow = q.shadows;
    // Real shadows carry the grounding when they exist; the blob stays faintly for contact.
    (this.blob.material as THREE.MeshBasicMaterial).userData.base = q.shadows ? 0.16 : 0.42;
  }

  dispose(): void {
    this.cancelAll();
    this.object.removeFromParent();
    for (const m of Object.values(this.materials)) m?.dispose();
    (this.blob.material as THREE.Material).dispose();
    this.mesh.skeleton.dispose();
  }

  /* ---------------------------------------------------------------- frame */

  update(dt: number, t: number): void {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time = t;
    const P = this.pose;
    P.begin();
    this.ambient(dt);
    this.moodLayer(dt);
    if (!this.action && this.queued) {
      this.action = this.queued;
      this.queued = null;
      this.state = this.action.state;
      this.action.start();
    }
    if (this.action) {
      if (this.gesture) this.gesture = null;
      if (this.action.update(dt)) this.finish(false);
    } else {
      this.speed = 0;
      this.idleLayer(dt);
    }
    if (this.runFlap > 0) this.runFlapLayer(dt);
    P.step(dt);
    this.syncRoot();
    this.updateFeet(dt);
    this.applyBones();
    this.updateBlob();
  }

  /* ---------------------------------------------------------------- action plumbing */

  private run(a: Action): void {
    if (this.action?.airborne) {
      // Interrupting mid-air would leave the bird floating; the new command waits for touchdown.
      this.queued?.end(true);
      this.queued = a;
      return;
    }
    if (this.action) this.finish(true);
    this.action = a;
    this.state = a.state;
    a.start();
  }

  private finish(interrupted: boolean): void {
    const a = this.action;
    this.action = null;
    this.state = 'idle';
    this.headAbsW = 0;
    this.gestureCooldown = Math.max(this.gestureCooldown, 1 + this.rng() * 1.5);
    a?.end(interrupted);
  }

  private cancelAll(): void {
    this.queued?.end(true);
    this.queued = null;
    if (this.action) {
      const a = this.action;
      this.action = null;
      this.state = 'idle';
      a.end(true);
    }
    this.headAbsW = 0;
  }

  private emitFlap(strength: number): void {
    this.bus.emit('pigeon:flap', { at: new THREE.Vector3(this.pos.x, this.pos.y + 0.13 * this.size, this.pos.z), strength });
  }

  private fwd(out: THREE.Vector3, yaw = this.yaw): THREE.Vector3 {
    return out.set(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** Default standing spot for a foot, in parent space. */
  private spot(f: Foot, out: THREE.Vector3, extraZ = 0): THREE.Vector3 {
    const x = f.side * REST.ankle.x * this.size;
    const z = (REST.ankle.z + extraZ) * this.size;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(this.pos.x + x * c + z * s, this.pos.y, this.pos.z - x * s + z * c);
  }

  private amp(): number {
    return this.reduced ? 0.5 : 1;
  }

  /* ---------------------------------------------------------------- locomotion */

  private advanceGait(distWorld: number, dYaw: number, mv: number, urgency: number, dt: number): void {
    const g = this.gait;
    g.advanced = true;
    g.mv = mv;
    g.L = lerp(0.05, 0.085, urgency) * (0.65 + 0.35 * mv);
    g.w = damp(g.w, mv, 8, dt);
    if (g.k === -1) {
      // Start with whichever foot is lagging most, as a real bird would.
      const e0 = this.feet[0].world.distanceTo(this.spot(this.feet[0], _v, g.L));
      const e1 = this.feet[1].world.distanceTo(this.spot(this.feet[1], _v, g.L));
      const want = e1 > e0 ? 1 : 0;
      if ((Math.floor(g.p) & 1) !== want) g.p += 1;
      g.k = Math.floor(g.p) - 1;
    }
    g.p += distWorld / (g.L * this.size) + Math.abs(dYaw) / 0.5;
    const k = Math.floor(g.p);
    const ph = g.p - k;
    if (k !== g.k) {
      const prev = this.feet[g.k & 1];
      if (prev.swing?.gait) {
        prev.swing = null;
        prev.pitch = 0;
      }
      g.k = k;
      const f = this.feet[k & 1];
      f.swing = { from: f.world.clone(), fromYaw: f.yaw, t: 0, dur: 0, lift: 0.013 * this.size * (this.reduced ? 0.7 : 1), gait: true };
    }
    const f = this.feet[k & 1];
    const s = f.swing;
    if (!s) return;
    this.spot(f, _v, g.L * 0.5 * mv);
    _v.addScaledVector(this.fwd(_v2), g.L * this.size * (1 - ph) * mv);
    s.t = ph;
    const e = ease(ph);
    f.world.lerpVectors(s.from, _v, e);
    f.world.y += s.lift * Math.sin(Math.PI * ph);
    f.yaw = s.fromYaw + wrap(this.yaw - s.fromYaw) * e;
    f.pitch = 0.6 * Math.sin(Math.PI * ph);
  }

  private updateFeet(dt: number): void {
    const g = this.gait;
    if (!g.advanced) {
      g.w = damp(g.w, 0, 7, dt);
      if (g.k !== -1) {
        // Walking ended mid-stride: let the lifted foot finish on its own clock instead of freezing in the air.
        for (const f of this.feet)
          if (f.swing?.gait) {
            f.swing.dur = Math.max(0.06, (1 - f.swing.t) * 0.14);
            f.swing.from.copy(f.world);
            f.swing.fromYaw = f.yaw;
            f.swing.lift *= 1 - f.swing.t;
            f.swing.t = 0;
            f.swing.gait = false;
          }
        g.k = -1;
      }
    }
    g.advanced = false;

    if (this.pose.v[C.tuck] > 0.02) {
      for (const f of this.feet) {
        this.spot(f, f.world);
        f.yaw = this.yaw;
        f.swing = null;
      }
      return;
    }
    if (g.k === -1 && !this.feet.some((f) => f.swing)) {
      let worst: Foot | null = null;
      let worstErr = 0;
      for (const f of this.feet) {
        const err = f.world.distanceTo(this.spot(f, _v)) / this.size + Math.abs(wrap(f.yaw - this.yaw)) * 0.05;
        if (err > worstErr) {
          worstErr = err;
          worst = f;
        }
      }
      if (worst && worstErr > 0.016) {
        worst.swing = {
          from: worst.world.clone(), fromYaw: worst.yaw, t: 0,
          dur: (this.reduced ? 0.16 : 0.11) + 0.03 * this.rng(),
          lift: Math.min(0.012, 0.004 + worstErr * 0.3) * this.size, gait: false,
        };
      }
    }
    for (const f of this.feet) {
      const s = f.swing;
      if (!s || s.gait) continue;
      s.t = Math.min(1, s.t + dt / s.dur);
      this.spot(f, _v);
      const e = ease(s.t);
      f.world.lerpVectors(s.from, _v, e);
      f.world.y += s.lift * Math.sin(Math.PI * s.t);
      f.yaw = s.fromYaw + wrap(this.yaw - s.fromYaw) * e;
      f.pitch = 0.5 * Math.sin(Math.PI * s.t);
      if (s.t >= 1) {
        f.swing = null;
        f.pitch = 0;
      }
    }
  }

  private makeWalk(target: THREE.Vector3, urgency: number, stopShort: number, resolve: (r: 'arrived' | 'interrupted') => void): Action {
    const u = clamp(urgency + (this.temperament - 0.5) * 0.1, 0, 1);
    return {
      state: 'walking',
      airborne: false,
      start: () => {},
      update: (dt) => {
        const P = this.pose;
        const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        const remaining = dist - stopShort;
        const err = dist > 1e-4 ? wrap(Math.atan2(dx, dz) - this.yaw) : 0;
        const eps = 0.004 * this.size;
        if (remaining <= eps && (Math.abs(err) < 0.15 || dist < 0.02)) return true;
        const turnRate = lerp(4.5, 9, u) * (this.reduced ? 0.7 : 1);
        const dYaw = remaining > 0.01 || remaining <= eps ? clamp(err * 9 * dt, -turnRate * dt, turnRate * dt) : 0;
        const vmax = lerp(0.24, 0.62, u) * this.size * (this.reduced ? 0.8 : 1);
        const align = Math.max(0, Math.cos(err));
        let vT = remaining > eps ? vmax * align * align : 0;
        const decel = lerp(1.6, 3.5, u) * this.size;
        vT = Math.min(vT, Math.sqrt(2 * decel * Math.max(0, remaining)));
        const accel = lerp(1.6, 4.5, u) * this.size;
        this.speed = vT > this.speed ? Math.min(vT, this.speed + accel * dt) : Math.max(vT, this.speed - decel * 2 * dt);
        const step = Math.min(this.speed * dt, Math.max(0, remaining));
        this.pos.addScaledVector(this.fwd(_v), step);
        this.yaw = wrap(this.yaw + dYaw);
        this.advanceGait(step, dYaw, clamp(this.speed / (0.24 * this.size), 0, 1), u, dt);
        // Head leads the turn, the body follows.
        P.to(C.headYaw, clamp(err * 0.75, -0.9, 0.9), 16);
        P.to(C.bodyPitch, 0.03 + 0.13 * u * clamp(this.speed / vmax, 0, 1));
        P.to(C.tailPitch, 0.04 * u);
        if (u > 0.6 && this.speed > vmax * 0.7 && !this.reduced) {
          this.runFlapT -= dt;
          if (this.runFlapT <= 0) {
            this.runFlapT = 1.1 + this.rng() * 1.8;
            this.runFlap = 0.42;
            this.emitFlap(0.35);
          }
        }
        return false;
      },
      end: (interrupted) => resolve(interrupted ? 'interrupted' : 'arrived'),
    };
  }

  private runFlapLayer(dt: number): void {
    const d = 0.42;
    this.runFlap = Math.max(0, this.runFlap - dt);
    const t = d - this.runFlap;
    const e = env(t, d, 0.08, 0.12);
    const flap = 0.25 + 0.55 * Math.sin(TAU * 8 * t);
    const P = this.pose;
    P.to(C.spreadL, 0.55 * e, 25);
    P.to(C.spreadR, 0.55 * e, 25);
    P.to(C.flapL, flap * e, Infinity);
    P.to(C.flapR, flap * e, Infinity);
    P.to(C.tailSpread, 0.4 * e);
  }

  private makeFace(point: THREE.Vector3, resolve: () => void): Action {
    return {
      state: 'walking',
      airborne: false,
      start: () => {},
      update: (dt) => {
        const dx = point.x - this.pos.x, dz = point.z - this.pos.z;
        if (Math.hypot(dx, dz) < 1e-3) return true;
        const err = wrap(Math.atan2(dx, dz) - this.yaw);
        if (Math.abs(err) < 0.03) return true;
        const rate = this.reduced ? 2.4 : 4;
        const dYaw = clamp(err * 7 * dt, -rate * dt, rate * dt);
        this.yaw = wrap(this.yaw + dYaw);
        this.advanceGait(0, dYaw, 0, 0.2, dt);
        this.pose.to(C.headYaw, clamp(err * 0.85, -1.1, 1.1), 18);
        return false;
      },
      end: () => resolve(),
    };
  }

  /* ---------------------------------------------------------------- peck */

  /** Head centre that puts the beak tip at (0, y, z) in bird space with the head pitched nose-down by `pitch`. */
  private headForTip(z: number, y: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(pitch), s = Math.sin(pitch);
    const oy = BEAK_OFF.y * c - BEAK_OFF.z * s;
    const oz = BEAK_OFF.y * s + BEAK_OFF.z * c;
    return out.set(0, y - oy, z - oz);
  }

  private makePeck(resolve: () => void): Action {
    const r = this.rng();
    const n = r < 0.45 ? 1 : r < 0.85 ? 2 : 3;
    const k = this.reduced ? 1.35 : 1;
    type Seg = { name: 'reach' | 'aim' | 'strike' | 'hit' | 'up' | 'gulp' | 'settle'; d: number };
    const segs: Seg[] = [{ name: 'reach', d: 0.14 * k }];
    for (let i = 0; i < n; i++) {
      segs.push({ name: 'aim', d: (0.04 + this.rng() * 0.08) * k });
      segs.push({ name: 'strike', d: 0.065 * k });
      segs.push({ name: 'hit', d: 0.04 * k });
      segs.push({ name: 'up', d: 0.09 * k });
    }
    segs.push({ name: 'gulp', d: 0.3 * k }, { name: 'settle', d: 0.16 * k });
    let si = 0, t = 0, swallowed = false, done = false;
    const readyZ = REACH - 0.012, readyY = 0.03, readyP = 0.9;
    const downZ = REACH, downY = 0.0015, downP = 1.12;
    const jitter = (this.rng() - 0.5) * 0.12;
    const swallow = () => {
      if (!swallowed) {
        swallowed = true;
        resolve();
      }
    };
    const setAbs = (z: number, y: number, p: number, w: number) => {
      this.headForTip(z, y, p, this.headAbsPos);
      _e.set(p, jitter, 0, 'YXZ');
      this.headAbsQ.setFromEuler(_e);
      this.headAbsW = w;
    };
    return {
      state: 'pecking',
      airborne: false,
      start: () => {
        this.speed = 0;
      },
      update: (dt) => {
        const P = this.pose;
        t += dt;
        while (si < segs.length && t >= segs[si].d) {
          t -= segs[si].d;
          si++;
          if (si < segs.length && segs[si].name === 'hit') {
            this.object.updateMatrix();
            const tip = new THREE.Vector3(0, downY, downZ).applyMatrix4(this.object.matrix);
            this.bus.emit('pigeon:peck', { at: tip });
          }
        }
        if (si >= segs.length) {
          done = true;
          return true;
        }
        const seg = segs[si];
        const x = t / seg.d;
        const bowed = seg.name !== 'gulp' && seg.name !== 'settle';
        if (bowed) {
          P.to(C.bodyPitch, 0.46, 9);
          P.to(C.tailPitch, 0.22, 8);
          P.to(C.bodyLift, -0.004);
          P.to(C.headYaw, 0);
        }
        switch (seg.name) {
          case 'reach':
            setAbs(readyZ, readyY, readyP, ease(x));
            break;
          case 'aim':
            setAbs(readyZ, readyY + 0.002 * Math.sin(x * Math.PI), readyP, 1);
            break;
          case 'strike': {
            const e = x * x;
            setAbs(lerp(readyZ, downZ, e), lerp(readyY, downY, e), lerp(readyP, downP, e), 1);
            break;
          }
          case 'hit':
            setAbs(downZ, downY, downP, 1);
            break;
          case 'up': {
            const e = easeOut(x);
            setAbs(lerp(downZ, readyZ, e), lerp(downY, readyY, e), lerp(downP, readyP, e), 1);
            break;
          }
          case 'gulp': {
            setAbs(readyZ, readyY, readyP, 1 - ease(t / (0.16 * k)));
            P.to(C.headPitch, -0.32, 12);
            P.to(C.headUp, 0.006);
            P.to(C.throat, 1 + 0.28 * Math.sin(Math.PI * x), 20);
            if (t >= 0.13 * k) swallow();
            break;
          }
          case 'settle':
            this.headAbsW = 0;
            swallow();
            break;
        }
        return false;
      },
      end: () => {
        // An interrupted peck still resolves so the brain never hangs on it.
        if (!done || !swallowed) swallow();
      },
    };
  }

  /* ---------------------------------------------------------------- squabbles */

  private makeLunge(toward: THREE.Vector3, resolve: () => void): Action {
    const k = this.reduced ? 1.3 : 1;
    const dW = 0.13 * k, dT = 0.24 * k, dS = 0.3 * k;
    const from = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let targetYaw = 0, dist = 0, t = 0, flapped = false;
    const wingAmp = this.reduced ? 0.35 : 1;
    return {
      state: 'lunging',
      airborne: false,
      start: () => {
        this.speed = 0;
        const dx = toward.x - this.pos.x, dz = toward.z - this.pos.z;
        const h = Math.hypot(dx, dz);
        targetYaw = h > 1e-3 ? Math.atan2(dx, dz) : this.yaw;
        dist = clamp(h - 0.09 * this.size, 0, 0.14 * this.size) * (this.reduced ? 0.5 : 1);
      },
      update: (dt) => {
        const P = this.pose;
        t += dt;
        if (t < dW) {
          const e = wrap(targetYaw - this.yaw);
          this.yaw = wrap(this.yaw + clamp(e * 14 * dt, -12 * dt, 12 * dt));
          from.copy(this.pos);
          this.fwd(dir, targetYaw);
          P.to(C.bodyLift, -0.012, 14);
          P.to(C.bodyPitch, 0.28, 14);
          P.to(C.puff, 1.12, 10);
          P.to(C.headFwd, 0.012);
          P.to(C.headUp, -0.03);
          P.to(C.headPitch, 0.3);
          P.to(C.tailSpread, 0.6);
          P.to(C.tailPitch, 0.12);
          P.to(C.spreadL, 0.25 * wingAmp);
          P.to(C.spreadR, 0.25 * wingAmp);
        } else if (t < dW + dT) {
          if (!flapped) {
            flapped = true;
            this.yaw = targetYaw;
            this.emitFlap(this.reduced ? 0.3 : 0.75);
          }
          const x = (t - dW) / dT;
          this.pos.copy(from).addScaledVector(dir, dist * easeOut(x));
          const flap = (0.35 + 0.6 * Math.sin(TAU * 7 * (t - dW))) * wingAmp;
          P.to(C.spreadL, 0.62 * wingAmp, 22);
          P.to(C.spreadR, 0.62 * wingAmp, 22);
          P.to(C.flapL, flap, Infinity);
          P.to(C.flapR, flap, Infinity);
          P.to(C.sweepL, 0.1);
          P.to(C.sweepR, 0.1);
          P.to(C.bodyPitch, 0.22);
          P.to(C.bodyLift, 0.004 * Math.sin(Math.PI * x));
          P.to(C.puff, 1.12, 10);
          P.to(C.headFwd, 0.035, 20);
          P.to(C.headUp, -0.02);
          P.to(C.headPitch, 0.25);
          P.to(C.tailSpread, 0.8);
        } else if (t < dW + dT + dS) {
          P.to(C.puff, 1.06);
        } else return true;
        return false;
      },
      end: () => resolve(),
    };
  }

  private makeSulk(resolve: () => void): Action {
    const k = this.reduced ? 1.3 : 1;
    const dStep = 0.34 * k, dRuffle = 0.36 * k, dShake = 0.32 * k, dRec = 0.26 * k;
    const side = this.rng() < 0.5 ? 1 : -1;
    const from = new THREE.Vector3();
    const lat = new THREE.Vector3();
    let yaw0 = 0, t = 0;
    const a = this.amp();
    return {
      state: 'walking',
      airborne: false,
      start: () => {
        this.speed = 0;
        from.copy(this.pos);
        yaw0 = this.yaw;
        const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
        lat.set(side * c, 0, -side * s);
      },
      update: (dt) => {
        const P = this.pose;
        t += dt;
        if (t < dStep) {
          const x = ease(t / dStep);
          this.pos.copy(from).addScaledVector(lat, 0.05 * this.size * x * (this.reduced ? 0.6 : 1));
          this.yaw = wrap(yaw0 + side * 0.45 * x);
          P.to(C.bodyRoll, -side * 0.08 * a);
          P.to(C.headUp, -0.012);
          P.to(C.headPitch, 0.2);
          P.to(C.headYaw, side * 0.3);
        } else if (t < dStep + dRuffle) {
          const tt = t - dStep;
          const e = env(tt, dRuffle, 0.08, 0.12);
          P.to(C.puff, 1.16 + 0.025 * Math.sin(TAU * 16 * tt) * e * a, 18);
          P.to(C.liftL, 0.6 * e * a);
          P.to(C.liftR, 0.6 * e * a);
          P.to(C.tailYaw, 0.25 * Math.sin(TAU * 9 * tt) * e * a, Infinity);
          P.to(C.tailSpread, 0.4 * e);
          P.to(C.headUp, -0.008);
        } else if (t < dStep + dRuffle + dShake) {
          const tt = t - dStep - dRuffle;
          const decay = 1 - tt / dShake;
          P.to(C.puff, 1.06);
          P.to(C.headYaw, 0.45 * Math.sin(TAU * 12 * tt) * decay * a, Infinity);
          P.to(C.headRoll, 0.25 * Math.sin(TAU * 12 * tt + 1) * decay * a, Infinity);
          P.to(C.headPitch, -0.1);
        } else if (t < dStep + dRuffle + dShake + dRec) {
          P.to(C.puff, 1.04);
        } else return true;
        return false;
      },
      end: () => resolve(),
    };
  }

  /* ---------------------------------------------------------------- flight */

  private wingbeat(phase: number, amp: number, spread: number): void {
    const P = this.pose;
    const s = Math.sin(phase), c = Math.cos(phase);
    const flap = 0.25 + amp * s;
    // Wings partly fold on the upstroke, as real birds do to cut drag.
    const sp = spread * (1 - 0.18 * Math.max(0, c));
    for (const [sC, fC, swC, tC] of [[C.spreadL, C.flapL, C.sweepL, C.tipL], [C.spreadR, C.flapR, C.sweepR, C.tipR]] as const) {
      P.to(sC, sp, Infinity);
      P.to(fC, flap, Infinity);
      P.to(swC, 0.22 * c, Infinity);
      P.to(tC, -0.55 * Math.cos(phase + 0.6), Infinity);
    }
  }

  private makeFly(from: THREE.Vector3, to: THREE.Vector3, resolve: () => void): Action {
    if (this.reduced) {
      let t = 0;
      return {
        state: 'flying',
        airborne: false,
        start: () => {
          const dx = to.x - from.x, dz = to.z - from.z;
          this.teleport(to, Math.hypot(dx, dz) > 1e-3 ? Math.atan2(dx, dz) : this.yaw);
        },
        update: (dt) => {
          t += dt;
          const e = env(t, 0.6, 0.15, 0.35);
          this.pose.to(C.liftL, 0.5 * e);
          this.pose.to(C.liftR, 0.5 * e);
          this.pose.to(C.puff, 1 + 0.05 * e);
          return t >= 0.6;
        },
        end: () => resolve(),
      };
    }
    const dirH = new THREE.Vector3(to.x - from.x, 0, to.z - from.z);
    const D = from.distanceTo(to);
    if (dirH.lengthSq() < 1e-6) dirH.set(0, 0, 1);
    dirH.normalize();
    const p1 = from.clone().addScaledVector(dirH, D * 0.35);
    p1.y = lerp(from.y, to.y, 0.3);
    const p2 = to.clone().addScaledVector(dirH, -0.7).add(new THREE.Vector3(0, 0.55 + 0.08 * D, 0));
    const T = clamp(D / 3.5, 1.1, 3);
    const curve = new THREE.CubicBezierCurve3(from, p1, p2, to);
    const dLand = 0.5;
    let t = 0, phase = 0, landed = false;
    return {
      state: 'flying',
      airborne: true,
      start: () => {
        this.cancelGait();
        this.pos.copy(from);
        this.yaw = Math.atan2(dirH.x, dirH.z);
        this.groundY = to.y;
        this.pose.v[C.tuck] = 1;
        this.pose.v[C.spreadL] = this.pose.v[C.spreadR] = 1;
      },
      update: (dt) => {
        const P = this.pose;
        t += dt;
        if (t < T) {
          const x = t / T;
          const s = 1 - Math.pow(1 - x, 1.6);
          curve.getPoint(s, this.pos);
          curve.getTangent(Math.min(0.999, s), _v);
          if (Math.hypot(_v.x, _v.z) > 0.2) {
            const want = Math.atan2(_v.x, _v.z);
            this.yaw = wrap(this.yaw + wrap(want - this.yaw) * (1 - Math.exp(-6 * dt)));
          }
          const flare = ease((x - 0.72) / 0.23);
          const freq = lerp(8.5, 5.5, flare);
          const prev = phase;
          phase += dt * freq * TAU;
          // A downstroke starts each time the wing passes its highest point.
          if (Math.floor((prev - Math.PI / 2) / TAU) !== Math.floor((phase - Math.PI / 2) / TAU)) this.emitFlap(lerp(0.5, 0.85, flare));
          this.wingbeat(phase, lerp(0.85, 1.05, flare), 1);
          P.to(C.bodyPitch, lerp(0.2, -0.7, flare), 12);
          P.to(C.tailSpread, lerp(0.35, 1, flare));
          P.to(C.tailPitch, lerp(-0.05, 0.2, flare));
          P.to(C.tuck, 1 - flare, 10);
          P.to(C.legReach, 0.03 * flare);
          P.to(C.headPitch, lerp(0.15, -0.1, flare));
          P.to(C.headFwd, 0.012 * (1 - flare));
          return false;
        }
        if (!landed) {
          landed = true;
          this.pos.copy(to);
          this.emitFlap(0.6);
        }
        const lt = t - T;
        const e = ease(lt / 0.32);
        P.to(C.tuck, 0, 30);
        P.to(C.legReach, 0);
        P.to(C.bodyLift, -0.018 * Math.sin(Math.PI * Math.min(1, lt / 0.25)), 30);
        P.to(C.bodyPitch, lerp(-0.2, 0, e));
        P.to(C.spreadL, 1 - e, 20);
        P.to(C.spreadR, 1 - e, 20);
        P.to(C.flapL, 0.3 * (1 - e), 20);
        P.to(C.flapR, 0.3 * (1 - e), 20);
        const flick = env(lt - 0.3, 0.2, 0.06, 0.12);
        P.to(C.liftL, 0.5 * flick, 30);
        P.to(C.liftR, 0.5 * flick, 30);
        P.to(C.tailSpread, 0.6 * (1 - e));
        return lt >= dLand;
      },
      end: () => {
        if (!landed) this.pos.copy(to);
        this.pose.v[C.tuck] = 0;
        this.resetFeet();
        resolve();
      },
    };
  }

  private makeHop(target: THREE.Vector3, resolve: () => void): Action {
    const start = new THREE.Vector3();
    let targetYaw = 0, t = 0, beats = 1, T = 0.35, arc = 0.08, phaseTurn = 0;
    const dCrouch = 0.12, dLand = 0.28;
    let lastBeat = -1;
    return {
      state: 'hopping',
      airborne: true,
      start: () => {
        this.speed = 0;
        start.copy(this.pos);
        const dx = target.x - start.x, dz = target.z - start.z;
        const dy = target.y - start.y;
        targetYaw = Math.hypot(dx, dz) > 0.03 ? Math.atan2(dx, dz) : this.yaw;
        phaseTurn = Math.min(0.3, Math.abs(wrap(targetYaw - this.yaw)) / 6);
        beats = Math.abs(dy) > 0.2 ? 2 : 1;
        T = 0.3 + 0.35 * Math.min(1, Math.abs(dy) / 0.45);
        arc = 0.06 + 0.12 * Math.abs(dy);
      },
      update: (dt) => {
        const P = this.pose;
        t += dt;
        let tt = t;
        if (tt < phaseTurn) {
          const e = wrap(targetYaw - this.yaw);
          this.yaw = wrap(this.yaw + clamp(e * 12 * dt, -9 * dt, 9 * dt));
          this.advanceGait(0, e * 12 * dt, 0, 0.5, dt);
          return false;
        }
        tt -= phaseTurn;
        if (tt < dCrouch) {
          this.yaw = targetYaw;
          P.to(C.bodyLift, -0.016, 20);
          P.to(C.bodyPitch, 0.18, 16);
          P.to(C.spreadL, 0.15);
          P.to(C.spreadR, 0.15);
          return false;
        }
        tt -= dCrouch;
        if (tt < T) {
          const s = tt / T;
          const e = ease(s);
          this.pos.lerpVectors(start, target, e);
          this.pos.y = lerp(start.y, target.y, Math.pow(s, 0.8)) + arc * 4 * s * (1 - s);
          this.groundY = lerp(start.y, target.y, e);
          const beat = Math.floor(s * beats);
          if (beat !== lastBeat && beat < beats) {
            lastBeat = beat;
            this.emitFlap(this.reduced ? 0.25 : 0.5);
          }
          const amp = this.reduced ? 0.3 : 0.85;
          const open = Math.pow(Math.sin(Math.PI * s), 0.5) * (this.reduced ? 0.4 : 0.85);
          this.wingbeat(s * beats * TAU + Math.PI / 2, amp * open, open);
          P.to(C.tuck, 0.65 * Math.sin(Math.PI * s), 20);
          P.to(C.bodyPitch, lerp(0.1, -0.25, s));
          P.to(C.tailSpread, 0.7);
          return false;
        }
        tt -= T;
        if (tt < dLand) {
          if (this.pos.y !== target.y) {
            this.pos.copy(target);
            this.groundY = target.y;
          }
          P.to(C.tuck, 0, 40);
          P.to(C.bodyLift, -0.012 * Math.sin(Math.PI * Math.min(1, tt / 0.2)), 30);
          P.to(C.tailSpread, 0.3);
          return false;
        }
        return true;
      },
      end: () => {
        this.pos.copy(target);
        this.groundY = target.y;
        this.pose.v[C.tuck] = 0;
        this.resetFeet();
        resolve();
      },
    };
  }

  private cancelGait(): void {
    this.gait.k = -1;
    for (const f of this.feet) f.swing = null;
  }

  private resetFeet(): void {
    this.syncRoot();
    for (const f of this.feet) {
      this.spot(f, f.world);
      f.yaw = this.yaw;
      f.swing = null;
      f.pitch = 0;
    }
  }

  /* ---------------------------------------------------------------- ambient life, mood, gestures */

  private viewerAngle(): { yaw: number; pitch: number } {
    const dx = this.viewer.x - this.pos.x, dz = this.viewer.z - this.pos.z;
    const yaw = wrap(Math.atan2(dx, dz) - this.yaw);
    const pitch = Math.atan2(this.viewer.y - (this.pos.y + 0.2 * this.size), Math.hypot(dx, dz));
    return { yaw, pitch };
  }

  private ambient(dt: number): void {
    const P = this.pose;
    const a = this.amp();
    this.sacc.t -= dt;
    if (this.sacc.t <= 0) {
      // Pigeons look around in quick jerks with holds, not smooth pans.
      this.sacc.t = (0.8 + this.rng() * 1.8) * (this.reduced ? 1.8 : 1);
      this.sacc.yaw = (this.rng() - 0.5) * 0.9 * a;
      this.sacc.pitch = (this.rng() - 0.55) * 0.22 * a;
      this.sacc.roll = (this.rng() - 0.5) * 0.36 * a;
    }
    const rate = this.reduced ? 7 : 24;
    P.to(C.headYaw, this.sacc.yaw, rate);
    P.to(C.headPitch, this.sacc.pitch, rate);
    P.to(C.headRoll, this.sacc.roll, rate);
    this.gestureCooldown -= dt;
  }

  private moodLayer(dt: number): void {
    const P = this.pose;
    if (this.mood === 'calm') return;
    const v = this.viewerAngle();
    if (this.mood === 'glance') {
      P.to(C.puff, 1.05, 3);
      P.to(C.headYaw, clamp(v.yaw, -1.7, 1.7), this.reduced ? 6 : 12);
      P.to(C.headPitch, -clamp(v.pitch, 0, 0.5), 10);
      P.to(C.headRoll, 0.22 * Math.sign(v.yaw || 1));
      return;
    }
    P.to(C.puff, 1.13, 2.5);
    if (!this.action) {
      // Turn so the viewer ends up behind one shoulder; hysteresis stops it fidgeting.
      const want = wrap(v.yaw + Math.PI + this.moodSide * 0.8);
      if (Math.abs(want) > 0.35) this.moodTurning = true;
      if (this.moodTurning) {
        const rate = this.reduced ? 0.9 : 1.4;
        this.yaw = wrap(this.yaw + clamp(want * 3 * dt, -rate * dt, rate * dt));
        if (Math.abs(want) < 0.08) this.moodTurning = false;
      }
    }
    this.peekT -= dt;
    if (this.peekT <= 0) {
      this.peekOn = 0.7 + this.rng() * 0.4;
      this.peekT = 4 + this.rng() * 4;
    }
    if (this.peekOn > 0) {
      // A disdainful side-eye toward the viewer, then a snap away.
      this.peekOn -= dt;
      P.to(C.headYaw, clamp(v.yaw * 0.6, -1.5, 1.5), this.reduced ? 6 : 14);
      P.to(C.headRoll, -0.35 * Math.sign(v.yaw || 1));
      P.to(C.headPitch, -0.12);
    } else {
      P.to(C.headYaw, clamp(-Math.sign(v.yaw || 1) * 0.5, -1, 1), this.reduced ? 5 : 10);
      P.to(C.headPitch, -0.2);
      P.to(C.headRoll, 0);
    }
  }

  private startGesture(): void {
    const pool: Array<[GestureKind, number]> =
      this.mood === 'offended'
        ? [['ruffle', 0.5], ['look', 0.5]]
        : [['look', 0.28], ['tilt', 0.14], ['preen', 0.2], ['stretch', 0.08], ['coo', this.isGerald ? 0.2 : 0.14], ['ruffle', 0.12]];
    const total = pool.reduce((s, e) => s + e[1], 0);
    let r = this.rng() * total;
    let kind: GestureKind = 'look';
    for (const [k, w] of pool) {
      r -= w;
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    const D: Record<GestureKind, number> = { look: 2.1, tilt: 1.3, preen: 2.2, stretch: 1.7, coo: 1.7, ruffle: 1.0 };
    const vals: number[] = [];
    for (let i = 0; i < 9; i++) vals.push(this.rng() - 0.5);
    this.gesture = {
      kind, t: 0, d: D[kind] * (this.reduced ? 1.3 : 1), side: this.rng() < 0.5 ? 1 : -1, vals, emitted: false,
    };
  }

  private idleLayer(dt: number): void {
    this.autoIdleT -= dt;
    if (!this.gesture && this.autoIdleT <= 0) {
      this.autoIdleT = 8 + this.rng() * 8;
      if (this.gestureCooldown <= 0) this.startGesture();
    }
    const g = this.gesture;
    if (!g) return;
    g.t += dt;
    if (g.t >= g.d) {
      this.gesture = null;
      this.gestureCooldown = 1.2 + this.rng() * 2;
      return;
    }
    const P = this.pose;
    const a = this.amp();
    const t = g.t, d = g.d, s = g.side;
    const e = env(t, d, 0.25, 0.3);
    switch (g.kind) {
      case 'look': {
        const i = Math.min(2, Math.floor(t / (d / 3)));
        const rate = this.reduced ? 7 : 26;
        P.to(C.headYaw, g.vals[i * 3] * 2.2 * a, rate);
        P.to(C.headPitch, (g.vals[i * 3 + 1] - 0.15) * 0.5 * a, rate);
        P.to(C.headRoll, g.vals[i * 3 + 2] * 1.0 * a, rate);
        break;
      }
      case 'tilt':
        P.to(C.headRoll, s * 0.85 * e * a, 12);
        P.to(C.headPitch, -0.25 * e * a);
        P.to(C.headYaw, s * 0.2 * e);
        break;
      case 'preen': {
        P.to(C.headYaw, s * 1.7 * e * a, 9);
        P.to(C.headPitch, 0.55 * e * a, 9);
        P.to(C.headFwd, -0.045 * e * a);
        P.to(C.headUp, -0.035 * e * a + 0.004 * Math.sin(TAU * 7 * t) * e * a, 30);
        P.to(C.headSide, s * 0.03 * e * a);
        P.to(C.headRoll, -s * 0.3 * e * a);
        P.to(s > 0 ? C.liftL : C.liftR, 0.7 * e * a);
        P.to(C.puff, 1.06);
        break;
      }
      case 'stretch': {
        const sC = s > 0 ? C.spreadL : C.spreadR;
        const fC = s > 0 ? C.flapL : C.flapR;
        const wC = s > 0 ? C.sweepL : C.sweepR;
        P.to(sC, 0.8 * e * a, 8);
        P.to(fC, -0.35 * e * a, 8);
        P.to(wC, 0.6 * e * a, 8);
        P.to(C.tailSpread, 0.8 * e * a);
        P.to(C.tailYaw, -s * 0.25 * e * a);
        P.to(C.bodyRoll, -s * 0.06 * e * a);
        P.to(C.headPitch, 0.15 * e);
        break;
      }
      case 'coo': {
        if (!g.emitted && t > 0.25) {
          g.emitted = true;
          this.object.updateMatrix();
          const at = REST.head.clone().applyMatrix4(this.object.matrix);
          this.bus.emit('pigeon:coo', { at, isGerald: this.isGerald });
        }
        const bow = (0.5 - 0.5 * Math.cos(TAU * 2.2 * t)) * e;
        P.to(C.throat, 1 + 0.38 * e, 6);
        P.to(C.puff, 1.06);
        P.to(C.headUp, -0.014 * bow * a, 20);
        P.to(C.headPitch, 0.25 * bow * a, 20);
        P.to(C.bodyPitch, 0.12 * bow * a, 20);
        P.to(C.tailSpread, 0.45 * e * a);
        P.to(C.tailPitch, -0.05 * bow);
        break;
      }
      case 'ruffle': {
        const puffE = env(t, 0.55, 0.12, 0.25);
        P.to(C.puff, 1 + 0.2 * puffE * a, 14);
        const shake = env(t - 0.3, 0.45, 0.06, 0.15) * a * (this.reduced ? 0.25 : 1);
        P.to(C.bodyRoll, 0.12 * Math.sin(TAU * 11 * t) * shake, Infinity);
        P.to(C.tailYaw, 0.3 * Math.sin(TAU * 11 * t + 1) * shake, Infinity);
        P.to(C.headYaw, 0.4 * Math.sin(TAU * 11 * t + 2) * shake, Infinity);
        P.to(C.liftL, 0.5 * puffE * a);
        P.to(C.liftR, 0.5 * puffE * a);
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- skinning */

  private material(level: QualityLevel): THREE.Material {
    return (this.materials[level] ??= makeMaterial(this.uniforms, level));
  }

  private syncRoot(): void {
    this.object.position.copy(this.pos);
    this.object.rotation.set(0, this.yaw, 0);
    this.object.scale.setScalar(this.size);
    this.object.updateMatrix();
    this.invRoot.copy(this.object.matrix).invert();
  }

  private toBody(rest: THREE.Vector3, puffed: boolean, out: THREE.Vector3): THREE.Vector3 {
    out.copy(rest).sub(REST.body);
    if (puffed) out.multiply(this.puffS);
    return out.applyQuaternion(this.qBody).add(this.bodyPos);
  }

  private applyBones(): void {
    const v = this.pose.v;
    const g = this.gait;
    const b = this.bones;
    const a = this.amp();
    const ph = g.p - Math.floor(g.p);
    const gw = g.w;

    const roll = v[C.bodyRoll] + 0.06 * Math.sin(Math.PI * g.p) * gw * a;
    const yawB = v[C.bodyYaw] + 0.045 * Math.sin(Math.PI * g.p + 0.6) * gw * a;
    const lift = v[C.bodyLift] - 0.0035 * Math.cos(TAU * ph) * gw * a;
    this.qBody.setFromEuler(_e.set(v[C.bodyPitch], yawB, roll, 'YXZ'));
    this.bodyPos.set(v[C.bodySide], REST.body.y + lift, v[C.bodyFwd]);
    const breath = 1 + 0.007 * Math.sin(this.time * TAU * 0.8 + this.breathPhase) * a;
    const puff = v[C.puff] * breath;
    this.puffS.set(1 + (puff - 1) * 1.15, puff, 1 + (puff - 1) * 0.8);
    const body = b[BONE.body];
    body.position.copy(this.bodyPos);
    body.quaternion.copy(this.qBody);
    body.scale.copy(this.puffS);

    // Head-bob: during the hold the head stays put in the world while the body walks under it,
    // then it thrusts forward; this offset is relative to the body-carried head position.
    const L = g.L;
    const th = 0.4;
    const x = ph < th ? ease(ph / th) : 1;
    const bobK = gw * g.mv * (this.reduced ? 0.6 : 1);
    const bob = bobK * L * (x - ph - (1 - th) / 2);
    const bobUp = bobK * 0.003 * (ph < th ? Math.sin((Math.PI * ph) / th) : 0);

    const headPos = this.toBody(REST.head, false, _v);
    headPos.x += v[C.headSide];
    headPos.y += v[C.headUp] + bobUp;
    headPos.z += v[C.headFwd] + bob;
    const qHead = _q.setFromEuler(_e.set(v[C.headPitch], v[C.headYaw], v[C.headRoll], 'YXZ'));
    if (this.headAbsW > 0) {
      headPos.lerp(this.headAbsPos, this.headAbsW);
      qHead.slerp(this.headAbsQ, this.headAbsW);
    }
    const head = b[BONE.head];
    head.position.copy(headPos);
    head.quaternion.copy(qHead);
    head.scale.setScalar(1 + (puff - 1) * 0.35);

    const nb = this.toBody(REST.neckBase, true, _v2);
    const len = nb.distanceTo(headPos);
    const mid = _v3.addVectors(nb, headPos).multiplyScalar(0.5);
    if (len < NECK_LEN) {
      // A compressed neck bows forward into an S rather than collapsing through itself.
      const bow = _q2.copy(this.qBody);
      const dir = new THREE.Vector3(0, 0.45, 1).normalize().applyQuaternion(bow);
      mid.addScaledVector(dir, (NECK_LEN - len) * 0.5);
    }
    const neck = b[BONE.neck];
    neck.position.copy(mid);
    // Aim the neck along base-to-head so pecks and stretches read as one smooth tube, then borrow a
    // little of the head's twist so turned heads don't wring the neck.
    _v2.subVectors(headPos, nb).normalize();
    neck.quaternion.setFromUnitVectors(NECK_DIR, _v2).slerp(qHead, 0.3);
    const np = 1 + (puff - 1) * 1.4;
    const thr = v[C.throat];
    neck.scale.set(np * thr, np * (1 + (thr - 1) * 0.3), np * (1 + (thr - 1) * 0.8));

    const infl = this.mesh.morphTargetInfluences!;
    const wingScale = 1 + (puff - 1) * 0.6;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      const sp = clamp(v[i === 0 ? C.spreadL : C.spreadR], 0, 1);
      const flap = v[i === 0 ? C.flapL : C.flapR];
      const sweep = v[i === 0 ? C.sweepL : C.sweepR];
      const tip = v[i === 0 ? C.tipL : C.tipR];
      const lw = v[i === 0 ? C.liftL : C.liftR];
      const wing = b[i === 0 ? BONE.wingL : BONE.wingR];
      this.toBody(SHOULDER[i], true, wing.position);
      _q2.setFromEuler(_e.set(-lw * 0.12, s * sweep, s * (flap + lw * 0.16), 'YXZ'));
      wing.quaternion.copy(this.qBody).multiply(_q2);
      wing.scale.setScalar(wingScale);
      const tipBone = b[i === 0 ? BONE.wingLTip : BONE.wingRTip];
      tipBone.quaternion.setFromEuler(_e.set(0, 0, s * tip * sp));
      infl[i === 0 ? MORPH.wingL : MORPH.wingR] = sp;
    }

    const tail = b[BONE.tail];
    this.toBody(REST.tail, true, tail.position);
    _q2.setFromEuler(_e.set(v[C.tailPitch], v[C.tailYaw] - roll * 0.8, 0, 'YXZ'));
    tail.quaternion.copy(this.qBody).multiply(_q2);
    infl[MORPH.tail] = clamp(v[C.tailSpread], 0, 1);

    for (let i = 0; i < 2; i++) {
      const hip = b[i === 0 ? BONE.hipL : BONE.hipR];
      this.toBody(HIP[i], false, hip.position);
      hip.quaternion.copy(this.qBody);
    }

    const tuck = clamp(v[C.tuck], 0, 1);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const bone = b[i === 0 ? BONE.footL : BONE.footR];
      const p = bone.position.copy(f.world).applyMatrix4(this.invRoot);
      p.y += REST.ankle.y;
      p.z += v[C.legReach];
      if (tuck > 0) p.lerp(_v.set(f.side * 0.016, 0.05, -0.03), tuck);
      bone.quaternion.setFromEuler(_e.set(f.pitch + tuck * 1.1, wrap(f.yaw - this.yaw), 0, 'YXZ'));
    }
  }

  private updateBlob(): void {
    const above = Math.max(0, this.pos.y - this.groundY);
    this.blob.position.set(0, (-above + 0.002) / this.size, 0);
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    const base = (mat.userData.base as number | undefined) ?? 0.3;
    mat.opacity = base * clamp(1 - above / 1.2, 0, 1);
    const sc = 1 + Math.min(1, above) * 0.6;
    this.blob.scale.set(sc, 1, sc);
    this.blob.visible = mat.opacity > 0.01;
  }
}
