import * as THREE from 'three';
import type { CreatePigeon, Env, EventBus, Pigeon, PigeonMood, Quality, SceneHandle, VisitSnapshot } from '../contracts';
import { mulberry32 } from '../core/random';
import type { Crumb, Crumbs } from './crumbs';
import { TUNING } from './tuning';

type Task = 'idle' | 'seek' | 'wait' | 'eat' | 'fight' | 'arrive' | 'bench-approach' | 'bench' | 'hop';

interface Bird {
  p: Pigeon;
  index: number;
  name: string | null;
  task: Task;
  target: Crumb | null;
  /** Bumped on every command so stale promise callbacks know they've been superseded. */
  token: number;
  busy: boolean;
  nextThink: number;
  nextIdle: number;
  sulkUntil: number;
  squabbleReadyAt: number;
  urgency: number;
  goal: THREE.Vector3;
  tries: number;
  mood: PigeonMood;
  forgiven: boolean;
  benchUntil: number;
  benchReadyAt: number;
  react: number;
}

export interface FlockDeps {
  scene: SceneHandle;
  bus: EventBus;
  env: Env;
  crumbs: Crumbs;
  createPigeon: CreatePigeon;
  /** Whether the brain should announce arrivals itself (only if the pigeon module doesn't). */
  emitArrivals: boolean;
}

export interface Flock {
  start(snapshot: VisitSnapshot, t: number): void;
  setSnapshot(snapshot: VisitSnapshot): void;
  /** Grow toward the snapshot's flock size with fly-ins. */
  grow(snapshot: VisitSnapshot, t: number): void;
  onToss(crumb: Crumb, t: number): void;
  setQuality(q: Quality): void;
  centre(out: THREE.Vector3): THREE.Vector3;
  readonly count: number;
  update(dt: number, t: number): void;
  debug(): unknown;
  dispose(): void;
}

const GERALD_NAME = 'Gerald';
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = (r: readonly number[]) => rand(r[0], r[1]);

function wait(seconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
}

export function createFlock(deps: FlockDeps): Flock {
  const { scene, bus, env, crumbs } = deps;
  const F = TUNING.flock;
  const bounds = scene.walkBounds;
  const birds: Bird[] = [];
  let snap: VisitSnapshot | null = null;
  let quality: Quality = scene.quality;
  let squabbleGlobalReady = 0;
  let now = 0;
  let disposed = false;
  let flockForgiven = true;
  let glanceAnnounced = false;
  let nextIndex = 0;

  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  /* ---------------------------------------------------------- geometry helpers */

  const viewerGround = (out: THREE.Vector3) => out.set(scene.camera.position.x, 0, scene.camera.position.z);
  const viewerDist = (p: THREE.Vector3) => Math.hypot(p.x - scene.camera.position.x, p.z - scene.camera.position.z);
  const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
  const clampWalk = (p: THREE.Vector3, margin = 0.15) => {
    p.x = THREE.MathUtils.clamp(p.x, bounds.minX + margin, bounds.maxX - margin);
    p.z = THREE.MathUtils.clamp(p.z, bounds.minZ + margin, bounds.maxZ - margin);
    p.y = 0;
    return p;
  };
  const inWalk = (p: THREE.Vector3, slack = 0.1) =>
    p.x >= bounds.minX - slack && p.x <= bounds.maxX + slack && p.z >= bounds.minZ - slack && p.z <= bounds.maxZ + slack;
  const beak = (b: Bird, out: THREE.Vector3) => {
    const h = b.p.heading;
    return out.set(b.p.position.x + Math.sin(h) * b.p.reach, 0, b.p.position.z + Math.cos(h) * b.p.reach);
  };
  const headingError = (b: Bird, point: THREE.Vector3) => {
    const want = Math.atan2(point.x - b.p.position.x, point.z - b.p.position.z);
    let d = want - b.p.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return Math.abs(d);
  };

  const geraldStage = () => (snap ? snap.geraldStage : 0);

  const boldness = (b: Bird) => {
    if (!b.p.isGerald) return b.p.temperament;
    return [0.2, 0.6, 2.0, 2.2][geraldStage()];
  };

  const interestRadius = (b: Bird) => {
    if (b.p.isGerald) return F.geraldInterest[geraldStage()];
    let r = F.interestBase + b.p.temperament * F.interestPerTemperament;
    // Hunger is contagious: a bird beside one already hurrying to food widens its own interest.
    for (const o of birds) {
      if (o !== b && (o.task === 'seek' || o.task === 'eat') && flat(o.p.position, b.p.position) < 1.2) {
        r += 0.9;
        break;
      }
    }
    return r;
  };

  const allowedFor = (b: Bird, c: Crumb) => {
    if (!inWalk(c.ground)) return false;
    if (b.p.isGerald && viewerDist(c.ground) < F.geraldMinViewerDistance[geraldStage()]) return false;
    return true;
  };

  const minIdleViewerDist = (b: Bird) => (b.p.isGerald ? F.geraldIdleMinViewerDistance[geraldStage()] : 1.3);

  /* ---------------------------------------------------------- spawning */

  const spawnSpot = (rng: () => number, isGerald: boolean, out: THREE.Vector3) => {
    const n = Math.max(1, snap?.flockSize ?? 1);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = THREE.MathUtils.lerp(bounds.maxZ, bounds.minZ, 0.42);
    const rx = Math.min((bounds.maxX - bounds.minX) / 2 - 0.3, 0.7 + Math.sqrt(n) * 0.5);
    const rz = Math.min((bounds.maxZ - bounds.minZ) / 2 - 0.3, 0.6 + Math.sqrt(n) * 0.6);
    let best = new THREE.Vector3(cx, 0, cz);
    let bestClear = -1;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng());
      const p = new THREE.Vector3(cx + Math.cos(a) * r * rx, 0, cz + Math.sin(a) * r * rz);
      clampWalk(p, 0.3);
      if (isGerald && viewerDist(p) < F.geraldIdleMinViewerDistance[geraldStage()] + 0.8) continue;
      let clear = Infinity;
      for (const o of birds) clear = Math.min(clear, flat(o.p.position, p));
      if (clear > 0.55) return out.copy(p);
      if (clear > bestClear) {
        bestClear = clear;
        best = p;
      }
    }
    return out.copy(best);
  };

  const makeBird = (index: number): Bird => {
    const isGerald = index === 0;
    const p = deps.createPigeon({
      seed: 1000 + index * 7919,
      isGerald,
      quality,
      reducedMotion: env.reducedMotion,
      bus,
    });
    if (!p.object.parent) scene.scene.add(p.object);
    const b: Bird = {
      p,
      index,
      name: isGerald ? GERALD_NAME : null,
      task: 'idle',
      target: null,
      token: 0,
      busy: false,
      nextThink: now + Math.random() * F.thinkInterval,
      nextIdle: now + rand(0.5, 3),
      sulkUntil: 0,
      squabbleReadyAt: 0,
      urgency: 0,
      goal: new THREE.Vector3(),
      tries: 0,
      mood: 'calm',
      forgiven: flockForgiven,
      benchUntil: 0,
      benchReadyAt: now + rand(10, 20),
      react: 0,
    };
    b.react = THREE.MathUtils.lerp(F.reactMax, F.reactMin, Math.min(1, boldness(b)));
    birds.push(b);
    nextIndex = Math.max(nextIndex, index + 1);
    return b;
  };

  const faceRoughlyTowardViewer = (b: Bird, rng: () => number) => {
    viewerGround(tmpA);
    return Math.atan2(tmpA.x - b.p.position.x, tmpA.z - b.p.position.z) + (rng() - 0.5) * 2.4;
  };

  const flyInBird = (index: number, delay: number) => {
    const rng = mulberry32(1000 + index * 7919 + 17);
    const b = makeBird(index);
    const to = spawnSpot(rng, b.p.isGerald, new THREE.Vector3());
    const side = to.x >= 0 ? 1 : -1;
    const from = new THREE.Vector3(side * (Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)) + 4 + rng() * 2), 3.5 + rng() * 1.5, to.z - 1 - rng() * 2);
    b.task = 'arrive';
    b.busy = true;
    // Park off-stage until its turn so a staggered arrival doesn't pop in early.
    b.p.place(from, -side * Math.PI / 2);
    b.p.object.visible = false;
    const tok = ++b.token;
    void wait(delay).then(async () => {
      if (disposed || tok !== b.token) return;
      b.p.object.visible = true;
      if (env.reducedMotion) {
        b.p.place(to, faceRoughlyTowardViewer(b, rng));
      } else {
        await b.p.flyIn(from, to);
      }
      if (disposed || tok !== b.token) return;
      b.busy = false;
      b.task = 'idle';
      b.nextIdle = now + rand(0.8, 2);
      b.nextThink = now + 0.3;
      if (!b.forgiven) setMood(b, 'offended');
      if (deps.emitArrivals) bus.emit('pigeon:arrived', { isGerald: b.p.isGerald });
    });
  };

  const removeBird = (b: Bird) => {
    b.token++;
    if (b.target && b.target.claimedBy === b) b.target.claimedBy = null;
    scene.scene.remove(b.p.object);
    b.p.dispose();
    birds.splice(birds.indexOf(b), 1);
  };

  /* ---------------------------------------------------------- commands */

  const setMood = (b: Bird, mood: PigeonMood) => {
    b.mood = mood;
    b.p.setMood(mood, scene.camera.position);
  };

  const walk = (b: Bird, point: THREE.Vector3, urgency: number, stopShort: number, then: (res: 'arrived' | 'interrupted') => void) => {
    const tok = ++b.token;
    b.goal.copy(point);
    b.urgency = urgency;
    void b.p.walkTo(point.clone(), { urgency, stopShort }).then((res) => {
      if (disposed || tok !== b.token) return;
      then(res);
    });
  };

  /** Run a non-interruptible body action; the brain leaves the bird alone until it finishes. */
  const act = async (b: Bird, task: Task, fn: () => Promise<void>) => {
    const tok = ++b.token;
    b.busy = true;
    b.task = task;
    try {
      await fn();
    } catch (err) {
      console.error('[feeding] pigeon action failed', err);
    }
    if (disposed) return false;
    b.busy = false;
    return tok === b.token;
  };

  const goIdle = (b: Bird, pause: number) => {
    b.task = 'idle';
    if (b.target && b.target.claimedBy === b) b.target.claimedBy = null;
    b.target = null;
    b.tries = 0;
    b.nextIdle = now + pause;
  };

  const giveUp = (b: Bird) => {
    b.token++;
    b.p.stop();
    goIdle(b, rand(0.7, 1.6));
    // A little look-around sells "oh, it's gone" better than freezing.
    if (Math.random() < 0.55) b.p.idle();
  };

  /* ---------------------------------------------------------- choosing food */

  const competitorsCloser = (b: Bird, c: Crumb, d: number) => {
    let n = 0;
    for (const o of birds) {
      if (o === b || o.target !== c) continue;
      if (flat(o.p.position, c.ground) < d) n++;
    }
    return n;
  };

  const chooseTarget = (b: Bird): Crumb | null => {
    const radius = interestRadius(b);
    let best: Crumb | null = null;
    let bestScore = Infinity;
    for (const c of crumbs.all) {
      if (!crumbs.isEdible(c) || c.claimedBy) continue;
      if (!allowedFor(b, c)) continue;
      const d = flat(b.p.position, c.ground);
      if (d > radius) continue;
      // Each bird notices at its own pace; far crumbs take a beat longer to register.
      if (now < c.tossedAt + b.react + d * 0.05) continue;
      let score = d + competitorsCloser(b, c, d) * 0.9;
      if (c.phase === 'flying') score += 0.2;
      if (b.p.isGerald && geraldStage() >= 2) score -= Math.max(0, 6 - viewerDist(c.ground)) * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  };

  const seekUrgency = (b: Bird, c: Crumb) => {
    const d = flat(b.p.position, c.ground);
    const rivals = competitorsCloser(b, c, Infinity) - (c === b.target ? 1 : 0);
    let u = 0.28 + boldness(b) * 0.15 + Math.max(0, rivals) * 0.28;
    if (c.phase === 'flying') u += 0.15;
    if (d < 0.6) u -= 0.1;
    return THREE.MathUtils.clamp(u, 0.15, 1);
  };

  const seek = (b: Bird, c: Crumb) => {
    if (b.target && b.target !== c && b.target.claimedBy === b) b.target.claimedBy = null;
    b.task = 'seek';
    b.target = c;
    b.tries = 0;
    approach(b, c, seekUrgency(b, c));
  };

  const approach = (b: Bird, c: Crumb, urgency: number) => {
    const d = flat(b.p.position, c.ground);
    if (d < b.p.reach * 0.6) {
      // Crumb is under its chest: shuffle back a step so the beak can get at it.
      tmpA.subVectors(b.p.position, c.ground).setY(0);
      if (tmpA.lengthSq() < 1e-6) tmpA.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      tmpA.normalize().multiplyScalar(b.p.reach + 0.08).add(c.ground);
      clampWalk(tmpA, 0.05);
      walk(b, tmpA, 0.2, 0, () => approach(b, c, urgency));
      return;
    }
    walk(b, c.ground, urgency, b.p.reach, (res) => {
      if (res === 'arrived') arrived(b);
    });
  };

  const arrived = (b: Bird) => {
    const c = b.target;
    if (!c || !crumbs.isEdible(c) || (c.claimedBy && c.claimedBy !== b)) return retarget(b);
    if (!crumbs.isOnGround(c)) {
      b.task = 'wait';
      return;
    }
    const miss = beak(b, tmpA).distanceTo(c.ground);
    if (miss > 0.09 && headingError(b, c.ground) > 0.5 && flat(b.p.position, c.ground) < b.p.reach + 0.1) {
      void act(b, 'seek', () => b.p.face(c.ground.clone())).then((ok) => {
        if (ok) arrived(b);
      });
      return;
    }
    if (miss > 0.09) {
      if (++b.tries > 3) return retarget(b);
      b.task = 'seek';
      approach(b, c, Math.max(0.2, b.urgency * 0.7));
      return;
    }
    peckAt(b, c);
  };

  const peckAt = (b: Bird, c: Crumb) => {
    c.claimedBy = b;
    void act(b, 'eat', () => b.p.peck()).then(() => {
      if (disposed) return;
      if (crumbs.isEdible(c) && c.claimedBy === b) {
        if (c.pecksLeft > 1) {
          tmpA.set(Math.sin(b.p.heading), 0, Math.cos(b.p.heading));
          crumbs.bite(c, tmpA);
          // Chase the skittering half: often the funniest moment, and a chance for a neighbour to nick it.
          b.task = 'seek';
          b.target = c;
          b.nextThink = now + rand(0.25, 0.5);
          b.tries = 0;
          return;
        }
        crumbs.eat(c, b.name, b.p.isGerald);
      }
      goIdle(b, rand(0.2, 0.6));
      b.nextThink = now + rand(0.05, 0.25);
    });
  };

  const retarget = (b: Bird) => {
    const next = chooseTarget(b);
    if (next) seek(b, next);
    else giveUp(b);
  };

  /* ---------------------------------------------------------- squabbles */

  const trySquabble = (a: Bird): boolean => {
    if (!a.target || now < a.squabbleReadyAt || now < squabbleGlobalReady) return false;
    const dA = flat(a.p.position, a.target.ground);
    if (dA > F.squabbleApproach) return false;
    for (const o of birds) {
      if (o === a || o.busy || o.task !== 'seek' || !o.target || now < o.squabbleReadyAt) continue;
      if (flat(o.target.ground, a.target.ground) > F.squabbleRange) continue;
      const dB = flat(o.p.position, o.target.ground);
      if (dB > F.squabbleApproach) continue;
      // Roll once per pairing; whichever way it goes, these two won't re-roll for a while.
      a.squabbleReadyAt = o.squabbleReadyAt = now + 1.6;
      if (Math.random() > F.squabbleChance) return false;
      squabble(a, dA, o, dB);
      return true;
    }
    return false;
  };

  const squabble = (a: Bird, dA: number, o: Bird, dB: number) => {
    squabbleGlobalReady = now + F.squabbleGlobalCooldown;
    a.squabbleReadyAt = o.squabbleReadyAt = now + F.squabbleBirdCooldown;
    const sA = (0.35 + boldness(a)) / (dA + 0.15);
    const sB = (0.35 + boldness(o)) / (dB + 0.15);
    const [winner, loser] = Math.random() < sA / (sA + sB) ? [a, o] : [o, a];
    const prize = winner.target!;
    const lost = loser.target;
    if (lost && lost !== prize && lost.claimedBy === loser) lost.claimedBy = null;
    winner.p.stop();
    loser.p.stop();
    const at = tmpA.addVectors(a.p.position, o.p.position).multiplyScalar(0.5).clone();
    bus.emit('squabble', { at, winnerIsGerald: winner.p.isGerald });

    const wPos = winner.p.position.clone();
    const lPos = loser.p.position.clone();
    void act(winner, 'fight', () => winner.p.lunge(lPos)).then((ok) => {
      if (!ok) return;
      if (crumbs.isEdible(prize) && (!prize.claimedBy || prize.claimedBy === winner)) {
        winner.task = 'seek';
        winner.target = prize;
        winner.tries = 0;
        approach(winner, prize, 0.75);
      } else {
        retarget(winner);
      }
    });
    // The loser flaps back half a beat late, then thinks better of it.
    void act(loser, 'fight', async () => {
      await wait(0.09);
      await loser.p.lunge(wPos);
      await loser.p.sulk();
    }).then((ok) => {
      if (!ok) return;
      goIdle(loser, rand(1, 2.5));
      loser.sulkUntil = now + pick(F.sulkSeconds);
    });
  };

  /* ---------------------------------------------------------- idle life */

  const centre = (out: THREE.Vector3) => {
    out.set(0, 0, 0);
    let n = 0;
    for (const b of birds) {
      if (b.task === 'arrive' || b.task === 'bench' || b.task === 'hop') continue;
      out.add(b.p.position);
      n++;
    }
    if (n === 0) return out.set((bounds.minX + bounds.maxX) / 2, 0, THREE.MathUtils.lerp(bounds.maxZ, bounds.minZ, 0.42));
    return out.multiplyScalar(1 / n).setY(0);
  };

  const clearance = (b: Bird, p: THREE.Vector3) => {
    let c = Infinity;
    for (const o of birds) {
      if (o === b) continue;
      c = Math.min(c, flat(o.p.position, p), o.task === 'seek' || o.task === 'idle' ? flat(o.goal, p) + 0.1 : Infinity);
    }
    return c;
  };

  const nearestNeighbour = (b: Bird) => {
    let best: Bird | null = null;
    let d = Infinity;
    for (const o of birds) {
      if (o === b || o.task === 'arrive' || o.task === 'bench' || o.task === 'hop') continue;
      const dd = flat(o.p.position, b.p.position);
      if (dd < d) {
        d = dd;
        best = o;
      }
    }
    return { bird: best, dist: d };
  };

  const stroll = (b: Bird, to: THREE.Vector3, urgency: number) => {
    walk(b, to, urgency, 0, () => {
      b.task = 'idle';
    });
    b.task = 'idle';
  };

  const wander = (b: Bird) => {
    const c = centre(tmpB);
    const far = flat(b.p.position, c) > F.cohesionRadius;
    let best: THREE.Vector3 | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const a = far ? Math.atan2(c.x - b.p.position.x, c.z - b.p.position.z) + rand(-0.6, 0.6) : b.p.heading + rand(-1.8, 1.8);
      const len = pick(F.wanderStep);
      const p = new THREE.Vector3(b.p.position.x + Math.sin(a) * len, 0, b.p.position.z + Math.cos(a) * len);
      clampWalk(p, 0.25);
      if (viewerDist(p) < minIdleViewerDist(b)) continue;
      const score = Math.min(1.2, clearance(b, p)) - flat(p, c) * 0.08;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) stroll(b, best, rand(0.08, 0.25));
  };

  const benchStaging = (out: THREE.Vector3) => {
    out.set(scene.benchSpot.x, 0, bounds.maxZ - 0.2);
    return clampWalk(out, 0.2);
  };

  const goToBench = (b: Bird) => {
    b.task = 'bench-approach';
    walk(b, benchStaging(tmpA), 0.3, 0, (res) => {
      if (res !== 'arrived' || b.task !== 'bench-approach') return;
      void act(b, 'hop', () => b.p.hopTo(scene.benchSpot.clone())).then((ok) => {
        if (!ok) return;
        b.task = 'bench';
        b.benchUntil = now + pick(F.benchStay);
        b.nextIdle = now + rand(2, 4);
      });
    });
  };

  const leaveBench = (b: Bird) => {
    const down = benchStaging(new THREE.Vector3());
    down.x += rand(-0.4, 0.4);
    clampWalk(down, 0.2);
    void act(b, 'hop', () => b.p.hopTo(down)).then((ok) => {
      if (!ok) return;
      b.benchReadyAt = now + pick(F.benchCooldown);
      goIdle(b, rand(0.5, 1.5));
      b.nextThink = now + 0.1;
    });
  };

  const idleLife = (b: Bird) => {
    if (now < b.nextIdle) return;
    b.nextIdle = now + pick(F.idleGap) * (1.25 - boldness(b) * 0.25);
    const { bird: n, dist } = nearestNeighbour(b);
    if (n && dist < F.personalSpace) {
      // Too close for comfort: a short step away, more of a shuffle than a walk.
      tmpA.subVectors(b.p.position, n.p.position).setY(0);
      if (tmpA.lengthSq() < 1e-6) tmpA.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      tmpA.normalize().multiplyScalar(rand(0.22, 0.4)).add(b.p.position);
      stroll(b, clampWalk(tmpA, 0.2), 0.3);
      return;
    }
    if (b.p.isGerald && geraldStage() >= 3 && now > b.benchReadyAt && Math.random() < F.benchChancePerIdle && !anyCrumbNear(b)) {
      goToBench(b);
      return;
    }
    if (viewerDist(b.p.position) < minIdleViewerDist(b) - 0.2) {
      // Gerald in his shy days drifts back out if he finds himself too close.
      tmpA.set(b.p.position.x, 0, b.p.position.z - 1.2);
      stroll(b, clampWalk(tmpA, 0.3), 0.2);
      return;
    }
    const r = Math.random();
    if (r < 0.5) wander(b);
    else if (r < 0.85) b.p.idle();
    else if (n) {
      void act(b, 'idle', () => b.p.face(n.p.position.clone())).then((ok) => {
        if (ok) b.task = 'idle';
      });
    } else {
      b.p.idle();
    }
  };

  const anyCrumbNear = (b: Bird) => {
    for (const c of crumbs.all) if (crumbs.isEdible(c) && flat(c.ground, b.p.position) < interestRadius(b) + 1) return true;
    return false;
  };

  /* ---------------------------------------------------------- the brain tick */

  const think = (b: Bird) => {
    if (b.busy || b.task === 'arrive' || b.task === 'hop') return;
    if (!b.forgiven) return;
    if (now < b.sulkUntil) return;

    if (b.task === 'bench') {
      const hungry = Math.random() < 0.25 && anyCrumbNear(b);
      if (now > b.benchUntil || hungry) leaveBench(b);
      else if (now > b.nextIdle) {
        b.nextIdle = now + pick(F.idleGap);
        b.p.idle();
      }
      return;
    }

    if (b.task === 'seek' || b.task === 'wait') {
      const c = b.target;
      if (!c || !crumbs.isEdible(c) || (c.claimedBy && c.claimedBy !== b) || !allowedFor(b, c)) {
        if (c && c.claimedBy && c.claimedBy !== b && Math.random() < 0.5) b.p.idle();
        return retarget(b);
      }
      if (b.task === 'wait') {
        if (crumbs.isOnGround(c)) arrived(b);
        return;
      }
      if (trySquabble(b)) return;
      // Distracted by something much handier on the way.
      const alt = chooseTarget(b);
      const dNow = flat(b.p.position, c.ground);
      if (alt && alt !== c && flat(b.p.position, alt.ground) < dNow * 0.45 - 0.2) return seek(b, alt);
      const moved = flat(b.goal, c.ground) > 0.06;
      const u = seekUrgency(b, c);
      if (moved || Math.abs(u - b.urgency) > 0.22) approach(b, c, u);
      return;
    }

    // idle, bench-approach
    const c = chooseTarget(b);
    if (c) return seek(b, c);
    if (b.task === 'idle') idleLife(b);
  };

  /* ---------------------------------------------------------- offended */

  const thresholds = (b: Bird) =>
    b.p.isGerald ? { glance: F.offended.geraldGlanceAt, forgive: F.offended.geraldForgiveAt } : { glance: F.offended.glanceAt, forgive: F.offended.forgiveAt };

  const flockThresholds = () => (birds.some((b) => !b.p.isGerald) ? { glance: F.offended.glanceAt, forgive: F.offended.forgiveAt } : { glance: F.offended.geraldGlanceAt, forgive: F.offended.geraldForgiveAt });

  const offendedToss = (order: number) => {
    for (const b of birds) {
      if (b.forgiven) continue;
      const th = thresholds(b);
      // Staggered so the flock doesn't turn like a drill team; Gerald is always quickest.
      const lag = b.p.isGerald ? 0.25 : rand(0.35, 0.95);
      if (order >= th.forgive) {
        b.forgiven = true;
        void wait(lag).then(() => {
          if (disposed || !birds.includes(b)) return;
          setMood(b, 'calm');
          b.nextThink = now + 0.2;
          b.nextIdle = now + rand(0.4, 1.2);
        });
      } else if (order === th.glance) {
        void wait(lag).then(() => {
          if (disposed || b.forgiven || !birds.includes(b)) return;
          setMood(b, 'glance');
          void wait(F.offended.glanceHold + rand(-0.3, 0.4)).then(() => {
            if (!disposed && !b.forgiven && b.mood === 'glance') setMood(b, 'offended');
          });
        });
      }
    }
    const fth = flockThresholds();
    if (order === fth.glance && !glanceAnnounced) {
      glanceAnnounced = true;
      bus.emit('flock:glance', {});
    }
    if (order >= fth.forgive && !flockForgiven) {
      flockForgiven = true;
      bus.emit('flock:forgiven', {});
    }
  };

  /* ---------------------------------------------------------- public */

  return {
    get count() {
      return birds.length;
    },
    start(s, t) {
      now = t;
      snap = s;
      flockForgiven = !s.offended;
      const n = Math.max(1, Math.min(s.flockSize, quality.maxPigeons));
      for (let i = 0; i < n; i++) {
        const rng = mulberry32(1000 + i * 7919 + 17);
        const b = makeBird(i);
        const at = spawnSpot(rng, b.p.isGerald, new THREE.Vector3());
        b.p.place(at, faceRoughlyTowardViewer(b, rng));
        b.goal.copy(at);
        if (s.offended) setMood(b, 'offended');
      }
    },
    setSnapshot(s) {
      snap = s;
      for (const b of birds) b.react = THREE.MathUtils.lerp(F.reactMax, F.reactMin, Math.min(1, boldness(b)));
    },
    grow(s, t) {
      now = t;
      snap = s;
      const want = Math.min(s.flockSize, quality.maxPigeons);
      let delay = rand(0.4, 0.9);
      while (birds.length < want) {
        flyInBird(nextIndex, delay);
        delay += pick(F.flyInStagger);
      }
    },
    onToss(crumb) {
      if (!flockForgiven || birds.some((b) => !b.forgiven)) offendedToss(crumb.order);
    },
    setQuality(q) {
      quality = q;
      for (const b of birds) b.p.setQuality(q);
      if (birds.length <= q.maxPigeons) return;
      // Drop the least noticeable birds: off-screen first, then whoever is farthest out to the side.
      const spare = birds
        .filter((b) => !b.p.isGerald && b.task !== 'eat' && b.task !== 'fight')
        .map((b) => {
          const s = scene.worldToScreen(b.p.position);
          return { b, score: (s.visible ? 0 : 100) + Math.abs(b.p.position.x) + viewerDist(b.p.position) * 0.2 };
        })
        .sort((x, y) => y.score - x.score);
      while (birds.length > q.maxPigeons && spare.length) removeBird(spare.shift()!.b);
    },
    centre,
    update(dt, t) {
      now = t;
      for (const b of birds) {
        b.p.update(dt, t);
        if (now >= b.nextThink) {
          b.nextThink = now + F.thinkInterval * rand(0.7, 1.3);
          think(b);
        }
      }
    },
    debug() {
      return birds.map((b) => ({ i: b.index, task: b.task, busy: b.busy, st: b.p.state, tgt: b.target?.id ?? null, tries: b.tries, pos: [+b.p.position.x.toFixed(2), +b.p.position.z.toFixed(2)], forgiven: b.forgiven }));
    },
    dispose() {
      disposed = true;
      for (const b of [...birds]) removeBird(b);
    },
  };
}
