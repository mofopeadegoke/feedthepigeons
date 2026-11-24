import * as THREE from 'three';
import type { FeedingDeps, FeedingHandle, InputKind } from '../contracts';
import { createAimInput, type AimInput } from './aim';
import { createBread } from './bread';
import { createCrumbs } from './crumbs';
import { createFlock } from './flock';
import { TUNING } from './tuning';

export { TUNING as FEEDING_TUNING } from './tuning';

export interface FeedingOptions {
  /**
   * Set false if the pigeon module already emits 'pigeon:arrived' when a fly-in lands,
   * so arrivals aren't announced twice.
   */
  emitArrivals?: boolean;
}

export function createFeeding(deps: FeedingDeps, options: FeedingOptions = {}): FeedingHandle {
  const { scene, bus, env, state } = deps;
  const A = TUNING.arc;
  const T = TUNING.throw;

  const bread = createBread(scene.scene, scene.breadAnchor, scene.quality.shadows);
  const crumbs = createCrumbs(scene.scene, bus, scene.quality.shadows);
  const flock = createFlock({
    scene,
    bus,
    env,
    crumbs,
    createPigeon: deps.createPigeon,
    emitArrivals: options.emitArrivals ?? true,
  });

  let t = 0;
  let lastTossAt = -Infinity;
  let input: AimInput | null = null;
  let started = false;
  const unsubs: Array<() => void> = [];
  const from = new THREE.Vector3();

  const dropTarget = () => {
    const a = scene.breadAnchor;
    const d = T.dropMin + Math.random() * (T.dropMax - T.dropMin);
    const b = scene.walkBounds;
    // From a bench-top bread, "just in front" means the near edge of the path, where birds can get at it.
    const z = Math.min(a.z - d, b.maxZ - 0.08 - Math.random() * 0.35);
    return new THREE.Vector3(a.x + (Math.random() - 0.5) * 2 * T.dropSpread, 0, z);
  };

  const toss = (target: THREE.Vector3 | null, kind: InputKind): boolean => {
    const nowMs = performance.now();
    if (nowMs - lastTossAt < T.minIntervalMs) return false;
    lastTossAt = nowMs;

    const isDrop = target === null;
    const to = target ?? dropTarget();
    const anchorFlat = new THREE.Vector3(scene.breadAnchor.x, 0, scene.breadAnchor.z);
    const dist = to.distanceTo(anchorFlat);
    const reduced = env.reducedMotion;
    let apex: number;
    if (isDrop) apex = reduced ? A.dropApex * 0.6 : A.dropApex;
    else if (reduced) apex = Math.min(A.reducedApexMax, A.reducedApexBase + A.reducedApexPerMetre * dist);
    else apex = Math.min(A.apexMax, A.apexBase + A.apexPerMetre * dist);
    const spinLo = reduced ? A.reducedSpinMin : A.spinMin;
    const spinHi = reduced ? A.reducedSpinMax : A.spinMax;
    const spin = (spinLo + Math.random() * (spinHi - spinLo)) * (isDrop ? 0.45 : 1);

    // Tear first: the bite it takes decides where on the edge the crumb comes away from.
    bread.tear(to, isDrop ? 0.6 : 0.8 + Math.min(1, dist / 10) * 0.5);
    bread.tearPoint(from);
    const crumb = crumbs.toss(from, to, t, { input: kind, apex, spin });

    if (state.recordToss()) {
      const snapshot = state.snapshot();
      bus.emit('day:fed', { snapshot });
      flock.setSnapshot(snapshot);
      const before = flock.count;
      flock.grow(snapshot, t);
      if (flock.count !== before) scene.frameFlock(flock.count, env.reducedMotion);
    }
    flock.onToss(crumb, t);
    return true;
  };

  const frame = (dt: number, time: number) => {
    t = time;
    bread.update(dt);
    crumbs.update(dt, time);
    input?.update(dt, time);
    flock.update(dt, time);
  };

  return {
    start() {
      if (started) return;
      started = true;
      flock.start(state.snapshot(), t);
      if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__flockDebug = () => ({ birds: flock.debug(), crumbs: crumbs.all.map((c) => ({ id: c.id, ph: c.phase, claimed: !!c.claimedBy, g: [+c.ground.x.toFixed(2), +c.ground.z.toFixed(2)] })) });
      scene.frameFlock(flock.count, true);
      input = createAimInput({ scene, env, bread, flockCentre: (out) => flock.centre(out), onToss: toss });
      unsubs.push(scene.onFrame(frame));
      unsubs.push(
        scene.onQualityChange((q) => {
          bread.setShadows(q.shadows);
          crumbs.setShadows(q.shadows);
          const before = flock.count;
          flock.setQuality(q);
          if (flock.count !== before) scene.frameFlock(flock.count, env.reducedMotion);
        }),
      );
    },
    dispose() {
      for (const u of unsubs.splice(0)) u();
      input?.dispose();
      input = null;
      flock.dispose();
      crumbs.dispose();
      bread.dispose();
    },
  };
}
