/**
 * Stand-ins for the scene, pigeon and visit-state modules so the feeding lab works on its own.
 * Lab only: never imported from src/.
 */
import * as THREE from 'three';
import type {
  CreatePigeon,
  Env,
  GeraldStage,
  Pigeon,
  PigeonMood,
  Quality,
  SceneHandle,
  VisitSnapshot,
  VisitState,
} from '../src/contracts';
import { mulberry32 } from '../src/core/random';

/* ------------------------------------------------------------------ scene */

export interface StubScene extends SceneHandle {
  setQuality(q: Partial<Quality>): void;
  dispose(): void;
}

export function createStubScene(container: HTMLElement): StubScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#cfd9d2');
  scene.fog = new THREE.Fog('#cfd9d2', 12, 30);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
  const camBase = new THREE.Vector3(0, 1.1, 2.2);
  camera.position.copy(camBase);
  const lookAt = new THREE.Vector3(0, 0, -2.5);
  camera.lookAt(lookAt);

  scene.add(new THREE.HemisphereLight('#eef4ff', '#6b5a43', 1.1));
  const sun = new THREE.DirectionalLight('#fff1d6', 2.4);
  sun.position.set(3, 6, 2);
  sun.target.position.set(0, 0, -2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -6;
  sun.shadow.camera.right = 6;
  sun.shadow.camera.top = 6;
  sun.shadow.camera.bottom = -8;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const grass = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#7d9461', roughness: 1 }));
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);
  const walkBounds = { minX: -3.5, maxX: 3.5, minZ: -7, maxZ: 0.6 };
  const path = new THREE.Mesh(new THREE.PlaneGeometry(7, 22), new THREE.MeshStandardMaterial({ color: '#c9b79a', roughness: 0.95 }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, 0.002, -8);
  path.receiveShadow = true;
  scene.add(path);
  // Distance marks every 2 m, so throw lengths can be judged by eye.
  for (let z = 0; z >= -14; z -= 2) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(7, 0.02), new THREE.MeshBasicMaterial({ color: '#a8977c' }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, 0.003, z);
    scene.add(m);
  }
  const bench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.4), new THREE.MeshStandardMaterial({ color: '#7a5a3a' }));
  bench.position.set(1.7, 0.42, 1.2);
  bench.castShadow = bench.receiveShadow = true;
  scene.add(bench);

  const quality: Quality = { level: 'high', shadows: true, pixelRatio: Math.min(2, window.devicePixelRatio), maxPigeons: 24 };
  const qualityFns = new Set<(q: Quality) => void>();
  const frameFns = new Set<(dt: number, t: number) => void>();

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let camZ = camBase.z;
  let camGoalZ = camBase.z;
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  // Automated browsers can starve rAF in a background window; ?tick=timeout keeps the lab running there.
  const useTimeout = new URLSearchParams(location.search).get('tick') === 'timeout';
  const schedule = (fn: () => void) => (useTimeout ? window.setTimeout(fn, 16) : requestAnimationFrame(fn));
  const loop = () => {
    raf = schedule(loop);
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    elapsed += dt;
    camZ += (camGoalZ - camZ) * (1 - Math.exp(-dt * 1.5));
    camera.position.set(camBase.x, camBase.y + (camZ - camBase.z) * 0.35, camZ);
    camera.lookAt(lookAt);
    for (const fn of frameFns) fn(dt, elapsed);
    renderer.render(scene, camera);
  };

  const handle: StubScene = {
    renderer,
    scene,
    camera,
    canvas,
    quality,
    onQualityChange(fn) {
      qualityFns.add(fn);
      return () => qualityFns.delete(fn);
    },
    screenToGround(x, y) {
      const ndc = new THREE.Vector2((x / canvas.clientWidth) * 2 - 1, -(y / canvas.clientHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      return raycaster.ray.intersectPlane(groundPlane, new THREE.Vector3());
    },
    worldToScreen(p) {
      const v = p.clone().project(camera);
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight, visible: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z < 1 };
    },
    breadAnchor: new THREE.Vector3(0.12, 0, 0.75),
    benchSpot: new THREE.Vector3(1.3, 0.45, 1.2),
    walkBounds,
    frameFlock(count, instant) {
      camGoalZ = camBase.z + Math.min(1.4, Math.max(0, count - 1) * 0.06);
      if (instant) camZ = camGoalZ;
    },
    onFrame(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    start() {
      if (!raf) loop();
    },
    setQuality(q) {
      Object.assign(quality, q);
      renderer.shadowMap.enabled = quality.shadows;
      for (const fn of qualityFns) fn({ ...quality });
    },
    dispose() {
      if (useTimeout) clearTimeout(raf);
      else cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      canvas.remove();
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ pigeon */

type Pending = { resolve: (v?: never) => void } | null;

export const createStubPigeon: CreatePigeon = (opts) => {
  const rnd = mulberry32(opts.seed);
  const temperament = opts.isGerald ? 0.35 : rnd();
  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);
  const grey = new THREE.Color().setHSL(0.6, 0.06, 0.38 + rnd() * 0.18);
  const mat = new THREE.MeshStandardMaterial({ color: grey, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.14, 4, 10), mat);
  body.rotation.x = Math.PI / 2 - 0.35;
  body.position.set(0, 0.13, -0.01);
  body.castShadow = true;
  bodyPivot.add(body);
  const head = new THREE.Group();
  head.position.set(0, 0.22, 0.08);
  bodyPivot.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), mat);
  skull.castShadow = true;
  head.add(skull);
  const beakM = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.04, 6), new THREE.MeshStandardMaterial({ color: '#3b2f2a' }));
  beakM.rotation.x = Math.PI / 2;
  beakM.position.set(0, -0.005, 0.05);
  head.add(beakM);
  if (opts.isGerald) {
    const patch = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshStandardMaterial({ color: '#f1efe8' }));
    patch.scale.set(0.5, 0.6, 1.2);
    patch.position.set(0.068, 0.14, -0.02);
    bodyPivot.add(patch);
  }

  const pos = new THREE.Vector3();
  let heading = 0;
  let state: Pigeon['state'] = 'idle';
  let walkResolve: ((r: 'arrived' | 'interrupted') => void) | null = null;
  const walkTarget = new THREE.Vector3();
  let walkSpeed = 0.5;
  let walkStop = 0;
  let action: { kind: string; t: number; dur: number; done: Pending; from?: THREE.Vector3; to?: THREE.Vector3; h0?: number } | null = null;
  let mood: PigeonMood = 'calm';
  const viewer = new THREE.Vector3();
  let bobPhase = rnd() * 10;
  let idleLook = 0;
  const reach = 0.13;

  const finishWalk = (r: 'arrived' | 'interrupted') => {
    const fn = walkResolve;
    walkResolve = null;
    if (fn) fn(r);
  };
  const finishAction = () => {
    const a = action;
    action = null;
    state = 'idle';
    a?.done?.resolve();
  };
  const startAction = (kind: Pigeon['state'] | 'face', dur: number, extra: Partial<NonNullable<typeof action>> = {}) => {
    finishWalk('interrupted');
    if (action) finishAction();
    return new Promise<void>((resolve) => {
      action = { kind, t: 0, dur, done: { resolve: resolve as () => void }, ...extra };
      if (kind !== 'face') state = kind as Pigeon['state'];
    });
  };
  const angleTo = (p: THREE.Vector3) => Math.atan2(p.x - pos.x, p.z - pos.z);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const turnToward = (want: number, rate: number, dt: number) => {
    const d = wrap(want - heading);
    heading = wrap(heading + THREE.MathUtils.clamp(d, -rate * dt, rate * dt));
    return Math.abs(d);
  };

  const p: Pigeon = {
    object: root,
    isGerald: opts.isGerald,
    temperament,
    get state() {
      return state;
    },
    get position() {
      return pos.clone();
    },
    get heading() {
      return heading;
    },
    reach,
    place(at, h) {
      pos.set(at.x, at.y, at.z);
      heading = h;
    },
    walkTo(target, o = {}) {
      finishWalk('interrupted');
      if (action) finishAction();
      walkTarget.set(target.x, 0, target.z);
      walkSpeed = THREE.MathUtils.lerp(0.3, 1.25, o.urgency ?? 0.3);
      walkStop = o.stopShort ?? 0;
      state = 'walking';
      return new Promise((resolve) => {
        walkResolve = resolve;
      });
    },
    stop() {
      if (state === 'walking') state = 'idle';
      finishWalk('interrupted');
    },
    face(point) {
      return startAction('face', 2, { to: point.clone() });
    },
    peck() {
      return startAction('pecking', 0.42 + rnd() * 0.12);
    },
    lunge(toward) {
      return startAction('lunging', 0.42, { to: toward.clone(), from: pos.clone() });
    },
    sulk() {
      return startAction('idle', 0.9, { from: pos.clone(), h0: heading });
    },
    setMood(m, v) {
      mood = m;
      viewer.copy(v);
    },
    flyIn(from, to) {
      if (opts.reducedMotion) {
        pos.copy(to);
        return Promise.resolve();
      }
      return startAction('flying', 1.7, { from: from.clone(), to: to.clone() });
    },
    hopTo(target) {
      return startAction('hopping', 0.7, { from: pos.clone(), to: target.clone() });
    },
    idle() {
      if (state === 'idle' && !action) idleLook = 1;
    },
    update(dt, t) {
      bobPhase += dt;
      let headDip = 0;
      let headFwd = 0;
      if (state === 'walking' && !action) {
        const d = Math.hypot(walkTarget.x - pos.x, walkTarget.z - pos.z);
        const err = turnToward(angleTo(walkTarget), 7, dt);
        if (d <= walkStop + 0.01) {
          state = 'idle';
          finishWalk('arrived');
        } else if (err < 0.9) {
          const step = Math.min(d - walkStop, walkSpeed * dt * (1 - err));
          pos.x += Math.sin(heading) * step;
          pos.z += Math.cos(heading) * step;
          bobPhase += dt * walkSpeed * 10;
          headFwd = Math.sin(bobPhase * 2) * 0.025;
        }
      }
      if (action) {
        const a = action;
        a.t += dt;
        const k = Math.min(1, a.t / a.dur);
        if (a.kind === 'face') {
          if (turnToward(angleTo(a.to!), 6, dt) < 0.04 || k >= 1) finishAction();
        } else if (a.kind === 'pecking') {
          headDip = Math.sin(k * Math.PI);
        } else if (a.kind === 'lunging') {
          turnToward(angleTo(a.to!), 12, dt);
          const lurch = Math.sin(k * Math.PI) * 0.1;
          pos.copy(a.from!).addScaledVector(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)), lurch);
          bodyPivot.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.15);
        } else if (a.kind === 'idle') {
          const side = new THREE.Vector3(Math.cos(a.h0!), 0, -Math.sin(a.h0!));
          pos.copy(a.from!).addScaledVector(side, Math.min(1, k * 2) * 0.14);
          head.rotation.y = Math.sin(k * Math.PI * 6) * 0.5 * (1 - k);
        } else if (a.kind === 'flying' || a.kind === 'hopping') {
          const e = k * k * (3 - 2 * k);
          pos.lerpVectors(a.from!, a.to!, e);
          pos.y = THREE.MathUtils.lerp(a.from!.y, a.to!.y, e) + Math.sin(k * Math.PI) * (a.kind === 'flying' ? 0.6 : 0.25);
          heading = angleTo(a.to!) || heading;
          bodyPivot.rotation.z = a.kind === 'flying' ? Math.sin(t * 40) * 0.2 : 0;
        }
        if (k >= 1 && a.kind !== 'face') {
          bodyPivot.scale.setScalar(1);
          bodyPivot.rotation.z = 0;
          if (a.kind === 'flying' || a.kind === 'hopping') pos.copy(a.to!);
          finishAction();
        }
      }
      idleLook = Math.max(0, idleLook - dt * 0.8);
      if (!action || action.kind !== 'idle') head.rotation.y = Math.sin(idleLook * Math.PI * 2) * 0.7;
      head.position.set(0, 0.22 - headDip * 0.17, 0.08 + headFwd + headDip * 0.06);
      root.position.copy(pos);
      // Offended: puff up and turn the body half away from the viewer; heading stays the brain's.
      const away = wrap(Math.atan2(viewer.x - pos.x, viewer.z - pos.z) + Math.PI * 0.75 - heading);
      const moodTurn = mood === 'offended' ? away : mood === 'glance' ? away * 0.3 : 0;
      bodyPivot.rotation.y += (moodTurn - bodyPivot.rotation.y) * (1 - Math.exp(-dt * 4));
      const puff = mood === 'calm' ? 1 : 1.15;
      if (!action || action.kind !== 'lunging') bodyPivot.scale.lerp(new THREE.Vector3(puff, puff, puff), 1 - Math.exp(-dt * 4));
      root.rotation.y = heading;
    },
    setQuality(q) {
      body.castShadow = skull.castShadow = q.shadows;
    },
    dispose() {
      finishWalk('interrupted');
      if (action) finishAction();
      root.removeFromParent();
      mat.dispose();
    },
  };
  return p;
};

/* ------------------------------------------------------------------ visit state */

export interface StubVisitState extends VisitState {
  set(patch: Partial<VisitSnapshot>): void;
  /** Pretend a new local day started: the next toss counts as a fed day. */
  newDay(growBy: number): void;
}

export function createStubVisitState(initial: Partial<VisitSnapshot> = {}): StubVisitState {
  const snap: VisitSnapshot = {
    streak: 0,
    familiarity: 1,
    totalDaysFed: 0,
    flockSize: 6,
    geraldStage: 0 as GeraldStage,
    offended: false,
    firstVisitEver: true,
    hasThrownEver: false,
    fedToday: false,
    ...initial,
  };
  let growBy = 0;
  let sound = false;
  return {
    snapshot: () => ({ ...snap }),
    recordToss() {
      snap.hasThrownEver = true;
      if (snap.fedToday) return false;
      snap.fedToday = true;
      snap.streak += 1;
      snap.totalDaysFed += 1;
      snap.familiarity += 1;
      snap.flockSize = Math.min(24, snap.flockSize + growBy);
      growBy = 0;
      return true;
    },
    markHintSeen() {
      snap.firstVisitEver = false;
    },
    getSoundOn: () => sound,
    setSoundOn(on) {
      sound = on;
    },
    set(patch) {
      Object.assign(snap, patch);
    },
    newDay(n) {
      snap.fedToday = false;
      growBy = n;
    },
  };
}

/** Env with a lab override for reduced motion. */
export function createLabEnv(base: Env): Env & { setReduced(v: boolean): void } {
  const fns = new Set<(r: boolean) => void>();
  const env = {
    reducedMotion: base.reducedMotion,
    coarsePointer: base.coarsePointer,
    onReducedMotionChange(fn: (r: boolean) => void) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    setReduced(v: boolean) {
      env.reducedMotion = v;
      for (const fn of fns) fn(v);
    },
  };
  base.onReducedMotionChange((r) => env.setReduced(r));
  return env;
}
