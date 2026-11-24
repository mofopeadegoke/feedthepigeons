import type { CreatePigeon, GameEvents, GeraldStage, SceneHandle, VisitState } from '../src/contracts';
import { createBus } from '../src/core/bus';
import { createEnv } from '../src/core/env';
import { createFeeding } from '../src/feeding';
import { createLabEnv, createStubPigeon, createStubScene, createStubVisitState, type StubScene, type StubVisitState } from './feeding-stubs';

// Globbed so the lab still compiles and runs while the other modules don't exist yet.
const sceneMods = import.meta.glob('../src/scene/index.ts');
const pigeonMods = import.meta.glob('../src/pigeon/index.ts');
const stateMods = import.meta.glob('../src/state/index.ts');

const params = new URLSearchParams(location.search);
if (params.get('tick') === 'timeout') {
  // Automated browsers can starve rAF in an unfocused window; a timer keeps real and stub scenes ticking.
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const want = {
  scene: params.get('scene') === 'real',
  pigeon: params.get('pigeon') === 'real',
  state: params.get('state') === 'real',
  flock: Number(params.get('flock') ?? 6),
  stage: Number(params.get('stage') ?? 0) as GeraldStage,
  offended: params.get('offended') === '1',
  reduced: params.get('reduced') === '1',
};

$<HTMLInputElement>('realScene').checked = want.scene;
$<HTMLInputElement>('realPigeon').checked = want.pigeon;
$<HTMLInputElement>('realState').checked = want.state;
$<HTMLInputElement>('flock').value = String(want.flock);
$<HTMLSelectElement>('stage-sel').value = String(want.stage);
$<HTMLInputElement>('offended').checked = want.offended;
$<HTMLInputElement>('reduced').checked = want.reduced;

const reload = () => {
  const p = new URLSearchParams();
  if (params.get('tick')) p.set('tick', params.get('tick')!);
  if ($<HTMLInputElement>('realScene').checked) p.set('scene', 'real');
  if ($<HTMLInputElement>('realPigeon').checked) p.set('pigeon', 'real');
  if ($<HTMLInputElement>('realState').checked) p.set('state', 'real');
  p.set('flock', $<HTMLInputElement>('flock').value);
  p.set('stage', $<HTMLSelectElement>('stage-sel').value);
  if ($<HTMLInputElement>('offended').checked) p.set('offended', '1');
  if ($<HTMLInputElement>('reduced').checked) p.set('reduced', '1');
  location.search = p.toString();
};
for (const id of ['realScene', 'realPigeon', 'realState']) $(id).addEventListener('change', reload);
$('apply').addEventListener('click', reload);
$('collapse').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

const logEl = $('log');
const lines: string[] = [];
const log = (s: string) => {
  lines.unshift(`${(performance.now() / 1000).toFixed(1)} ${s}`);
  lines.length = Math.min(lines.length, 60);
  logEl.textContent = lines.join('\n');
};

async function main() {
  const env = createLabEnv(createEnv());
  if (want.reduced) env.setReduced(true);
  const bus = createBus();
  const notes: string[] = [];
  const stage = $('stage');

  let scene: SceneHandle;
  const sceneLoader = sceneMods['../src/scene/index.ts'];
  if (want.scene && sceneLoader) {
    const mod = (await sceneLoader()) as { createScene(c: HTMLElement, e: typeof env): Promise<SceneHandle> };
    scene = await mod.createScene(stage, env);
    notes.push('scene: real');
  } else {
    scene = createStubScene(stage);
    notes.push(want.scene ? 'scene: stub (real missing)' : 'scene: stub');
  }

  let createPigeon: CreatePigeon = createStubPigeon;
  const pigeonLoader = pigeonMods['../src/pigeon/index.ts'];
  if (want.pigeon && pigeonLoader) {
    createPigeon = ((await pigeonLoader()) as { createPigeon: CreatePigeon }).createPigeon;
    notes.push('pigeon: real');
  } else notes.push(want.pigeon ? 'pigeon: stub (real missing)' : 'pigeon: stub');

  let state: VisitState;
  let stub: StubVisitState | null = null;
  const stateLoader = stateMods['../src/state/index.ts'];
  if (want.state && stateLoader) {
    state = ((await stateLoader()) as { createVisitState(): VisitState }).createVisitState();
    notes.push('state: real');
  } else {
    stub = createStubVisitState({ flockSize: want.flock, geraldStage: want.stage, offended: want.offended, totalDaysFed: [1, 5, 14, 30][want.stage] });
    state = stub;
    notes.push(want.state ? 'state: stub (real missing)' : 'state: stub');
  }
  $('moduleNote').textContent = notes.join(' · ');

  const counts: Record<string, number> = {};
  const events: Array<keyof GameEvents> = [
    'crumb:tossed', 'crumb:landed', 'crumb:eaten', 'crumb:faded', 'squabble', 'flock:glance', 'flock:forgiven',
    'day:fed', 'pigeon:arrived', 'pigeon:peck', 'pigeon:flap', 'pigeon:coo',
  ];
  for (const type of events) {
    bus.on(type, (payload) => {
      counts[type] = (counts[type] ?? 0) + 1;
      if (type === 'pigeon:peck' || type === 'crumb:landed' || type === 'pigeon:flap') return;
      const p = payload as unknown as Record<string, unknown>;
      const brief =
        type === 'crumb:tossed' ? `#${p.id} ${p.input}` :
        type === 'crumb:eaten' ? `#${p.id} by ${p.pigeonName ?? 'a pigeon'}` :
        type === 'squabble' ? (p.winnerIsGerald ? 'Gerald won' : '') :
        type === 'day:fed' ? JSON.stringify(p.snapshot) : '';
      log(`${type} ${brief}`);
    });
  }

  const feeding = createFeeding({ scene, bus, env, state, createPigeon });
  feeding.start();
  scene.start();
  scene.canvas.focus({ preventScroll: true });

  $('newDay').addEventListener('click', () => {
    if (stub) stub.newDay(Number($<HTMLInputElement>('growBy').value));
    else log('new day only works with the stub state');
  });
  $<HTMLSelectElement>('maxP').addEventListener('change', (e) => {
    const n = Number((e.target as HTMLSelectElement).value);
    if ('setQuality' in scene) (scene as StubScene).setQuality({ maxPigeons: n });
    else log('max pigeons only adjustable on the stub scene');
  });

  setInterval(() => {
    const s = state.snapshot();
    $('stats').textContent =
      Object.entries(counts).map(([k, v]) => `${k.padEnd(15)} ${v}`).join('\n') +
      `\nflockSize ${s.flockSize} stage ${s.geraldStage} offended ${s.offended}\nfedToday ${s.fedToday} streak ${s.streak}`;
  }, 400);

  // Hook for scripted checks from devtools.
  (window as unknown as Record<string, unknown>).__feeding = { scene, bus, env, state, feeding, counts };
}

main().catch((err) => {
  console.error(err);
  log(`failed: ${String(err)}`);
});
