import { Vector3 } from 'three';
import type { CounterClient, Env, VisitSnapshot, VisitState } from '../src/contracts';
import { createBus } from '../src/core/bus';
import { createVisitState, type StorageLike } from '../src/state';
import { createCounterClient } from '../src/net';
import { createHud } from '../src/ui';
import { createAudio } from '../src/audio';

const bus = createBus();

/* ------------------------------------------------------------------ fakes */

const motionListeners = new Set<(r: boolean) => void>();
const env: Env = {
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  coarsePointer: window.matchMedia('(pointer: coarse)').matches,
  onReducedMotionChange(fn) {
    motionListeners.add(fn);
    return () => motionListeners.delete(fn);
  },
};

function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

/** Real state on throwaway storage, with an override so the lab can force an offended arrival. */
function labState(offended: boolean): VisitState {
  const real = createVisitState(new Date(), { storage: memoryStorage() });
  let forced = offended;
  return {
    snapshot(): VisitSnapshot {
      const s = real.snapshot();
      return forced ? { ...s, offended: true, streak: 0, firstVisitEver: false, hasThrownEver: true } : s;
    },
    recordToss(now) {
      const committed = real.recordToss(now);
      if (committed) forced = false;
      return committed;
    },
    markHintSeen: () => real.markHintSeen(),
    getSoundOn: () => real.getSoundOn(),
    setSoundOn: (on) => real.setSoundOn(on),
  };
}

function fakeCounter() {
  const listeners = new Set<(n: number) => void>();
  let total: number | null = null;
  const api: CounterClient & { set(n: number): void; get(): number | null } = {
    add(n = 1) {
      api.set((total ?? 0) + n);
    },
    onTotal(fn) {
      listeners.add(fn);
      if (total !== null) fn(total);
      return () => listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
    },
    set(n) {
      total = n;
      for (const fn of listeners) fn(n);
    },
    get: () => total,
  };
  return api;
}

/* ------------------------------------------------------------------ mounting */

const root = document.getElementById('hud-root')!;
let offended = false;
let useRealCounter = false;
let state = labState(offended);
let counter: CounterClient & { set?(n: number): void } = fakeCounter();
let hud = createHud({ root, bus, env, state, counter });
let audio = createAudio({ bus, state });
let streakDays = 0;

function remount() {
  hud.dispose();
  audio.dispose();
  counter.dispose();
  state = labState(offended);
  counter = useRealCounter ? createCounterClient() : fakeCounter();
  hud = createHud({ root, bus, env, state, counter });
  audio = createAudio({ bus, state });
  streakDays = state.snapshot().streak;
}

/* ------------------------------------------------------------------ controls */

const randomGround = () => new Vector3((Math.random() - 0.5) * 6, 0, -Math.random() * 6);
let crumbId = 0;

function toss() {
  const id = ++crumbId;
  const to = randomGround();
  bus.emit('crumb:tossed', { id, from: new Vector3(0, 0.6, 1.4), to, input: 'mouse' });
  counter.add(1);
  const wasOffended = state.snapshot().offended;
  if (state.recordToss()) {
    bus.emit('day:fed', { snapshot: state.snapshot() });
    if (wasOffended) bus.emit('flock:forgiven', {});
  }
  setTimeout(() => bus.emit('crumb:landed', { id, at: to }), 450);
}

function button(parent: string, label: string, fn: (b: HTMLButtonElement) => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => fn(b));
  document.getElementById(parent)!.appendChild(b);
  return b;
}

button('events', 'toss', toss);
button('events', 'toss ×10 fast', () => {
  for (let i = 0; i < 10; i++) setTimeout(toss, i * 90);
});
button('events', 'landed', () => bus.emit('crumb:landed', { id: ++crumbId, at: randomGround() }));
button('events', 'eaten (pigeon)', () => bus.emit('crumb:eaten', { id: crumbId, pigeonName: null, isGerald: false }));
button('events', 'eaten (Gerald)', () => bus.emit('crumb:eaten', { id: crumbId, pigeonName: 'Gerald', isGerald: true }));
button('events', 'peck', () => bus.emit('pigeon:peck', { at: randomGround() }));
button('events', 'flap soft', () => bus.emit('pigeon:flap', { at: randomGround(), strength: 0.3 }));
button('events', 'flap hard', () => bus.emit('pigeon:flap', { at: randomGround(), strength: 1 }));
button('events', 'coo', () => bus.emit('pigeon:coo', { at: randomGround(), isGerald: false }));
button('events', 'coo (Gerald)', () => bus.emit('pigeon:coo', { at: randomGround(), isGerald: true }));
button('events', 'squabble', () => bus.emit('squabble', { at: randomGround(), winnerIsGerald: Math.random() < 0.5 }));
button('events', 'forgiven', () => bus.emit('flock:forgiven', {}));
button('events', 'day:fed (fake +1)', () => {
  streakDays++;
  bus.emit('day:fed', { snapshot: { ...state.snapshot(), streak: streakDays, fedToday: true } });
});

button('visit', 'fresh first visit', () => {
  offended = false;
  remount();
});
button('visit', 'returning, offended', () => {
  offended = true;
  remount();
});

const fake = (n: number) => () => counter.set?.(n);
button('counter', 'none (remount)', () => remount());
button('counter', '0', fake(0));
button('counter', '1', fake(1));
button('counter', '4,213', fake(4213));
button('counter', '1,234,567', fake(1_234_567));
button('counter', '+37', () => counter.add(37));
button('counter', 'real client (/api/crumbs)', (b) => {
  useRealCounter = !useRealCounter;
  b.setAttribute('aria-pressed', String(useRealCounter));
  remount();
});

button('env', 'reduced motion', (b) => {
  env.reducedMotion = !env.reducedMotion;
  b.setAttribute('aria-pressed', String(env.reducedMotion));
  for (const fn of motionListeners) fn(env.reducedMotion);
}).setAttribute('aria-pressed', String(env.reducedMotion));
button('env', 'coarse pointer', (b) => {
  env.coarsePointer = !env.coarsePointer;
  b.setAttribute('aria-pressed', String(env.coarsePointer));
  remount();
}).setAttribute('aria-pressed', String(env.coarsePointer));
button('env', 'hide panel', () => {
  document.getElementById('panel')!.style.display = 'none';
  setTimeout(() => (document.getElementById('panel')!.style.display = ''), 6000);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    toss();
  }
});

/* ------------------------------------------------------------------ announcer mirror */

const said = document.getElementById('said')!;
new MutationObserver(() => {
  const region = root.querySelector('.ftp-sr');
  if (region?.textContent) said.textContent = `announcer: ${region.textContent}`;
}).observe(root, { subtree: true, childList: true, characterData: true });
