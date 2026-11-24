import './style.css';
import type { VisitState } from './contracts';
import { createBus } from './core/bus';
import { createEnv } from './core/env';
import { createVisitState } from './state';
import { createCounterClient } from './net';
import { createHud } from './ui';
import { createAudio } from './audio';

const app = document.querySelector<HTMLElement>('#app')!;
const stage = document.createElement('div');
stage.id = 'stage';
const hudRoot = document.createElement('div');
hudRoot.id = 'hud';
app.append(stage, hudRoot);

const env = createEnv();
const bus = createBus();
const state = createVisitState();
const counter = createCounterClient();

// Every crumb counts toward the worldwide total, whether or not a pigeon ever eats it.
bus.on('crumb:tossed', () => counter.add(1));

// The HUD goes up before the 3D park so the counter is readable while assets download.
createHud({ root: hudRoot, bus, env, state, counter });
createAudio({ bus, state });

void boot();

async function boot(): Promise<void> {
  // Scene and pigeon code is the heavy part of the bundle; splitting it lets the HUD paint first.
  const sceneModule = await import('./scene');

  if (!sceneModule.hasWebGL()) {
    startFallback(sceneModule.showFallback, state);
    return;
  }

  const loading = sceneModule.showLoading(app);
  try {
    const [scene, { createPigeon }, { createFeeding }] = await Promise.all([
      sceneModule.createScene(stage, env),
      import('./pigeon'),
      import('./feeding'),
    ]);
    const feeding = createFeeding({ scene, bus, env, state, createPigeon });
    feeding.start();
    scene.start();
    await loading.done();
  } catch (err) {
    // A context lost or a shader that won't compile on some odd GPU should still leave people a way to feed.
    console.error('[boot] live park failed, falling back', err);
    stage.replaceChildren();
    await loading.done();
    startFallback(sceneModule.showFallback, state);
  }
}

function startFallback(
  showFallback: (container: HTMLElement, onToss: () => void) => void,
  visit: VisitState,
): void {
  let id = 0;
  showFallback(stage, () => {
    // The counter, hint and announcer key off this event; there is no 3D throw, so the points are nominal.
    void import('three').then(({ Vector3 }) => {
      const origin = new Vector3();
      bus.emit('crumb:tossed', { id: ++id, from: origin, to: origin, input: 'mouse' });
      if (visit.recordToss()) bus.emit('day:fed', { snapshot: visit.snapshot() });
    });
  });
}
