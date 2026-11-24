import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Quality, QualityLevel } from '../src/contracts';
import { createBus } from '../src/core/bus';
import { createPigeon } from '../src/pigeon';
import type { PigeonImpl } from '../src/pigeon';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfd6dc);
scene.fog = new THREE.Fog(0xcfd6dc, 8, 22);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x8a7d6a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(3, 6, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -5;
sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5;
sun.shadow.camera.bottom = -5;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
scene.add(sun);

// Paving with a little noise so motion against the ground is readable.
const tc = document.createElement('canvas');
tc.width = tc.height = 512;
const g2 = tc.getContext('2d')!;
g2.fillStyle = '#9d968b';
g2.fillRect(0, 0, 512, 512);
for (let i = 0; i < 9000; i++) {
  const s = 40 + Math.random() * 60;
  g2.fillStyle = `rgba(${s},${s - 4},${s - 10},0.08)`;
  g2.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 4, 2 + Math.random() * 4);
}
g2.strokeStyle = 'rgba(60,55,50,0.35)';
g2.lineWidth = 3;
for (let i = 0; i <= 512; i += 128) {
  g2.beginPath(); g2.moveTo(i, 0); g2.lineTo(i, 512); g2.stroke();
  g2.beginPath(); g2.moveTo(0, i); g2.lineTo(512, i); g2.stroke();
}
const groundTex = new THREE.CanvasTexture(tc);
groundTex.colorSpace = THREE.SRGBColorSpace;
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping;
groundTex.repeat.set(20, 20);
groundTex.anisotropy = 8;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// A stand-in bench seat to test hopTo onto raised spots.
const bench = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.4), new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 0.8 }));
bench.position.set(1.4, 0.43, -1.2);
bench.castShadow = bench.receiveShadow = true;
scene.add(bench);
const benchSpot = new THREE.Vector3(1.2, 0.455, -1.2);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.02, 60);
const viewer = new THREE.Vector3(0, 1.1, 2.2);
let closeUp = false;

const bus = createBus();
const log: string[] = [];
for (const ev of ['pigeon:peck', 'pigeon:flap', 'pigeon:coo'] as const)
  bus.on(ev, () => {
    log.unshift(ev.replace('pigeon:', ''));
    log.length = Math.min(log.length, 6);
  });

let level: QualityLevel = 'high';
const quality = (): Quality => ({ level, shadows: level !== 'low', pixelRatio: 1, maxPigeons: 24 });
let reduced = false;

interface Bird { p: PigeonImpl; seed: number; gerald: boolean }
let birds: Bird[] = [];
let sel = 0;
const make = (seed: number, gerald: boolean, at: THREE.Vector3, heading: number) => {
  const p = createPigeon({ seed, isGerald: gerald, quality: quality(), reducedMotion: reduced, bus }) as PigeonImpl;
  p.place(at, heading);
  scene.add(p.object);
  birds.push({ p, seed, gerald });
  return p;
};
const clear = () => {
  for (const b of birds) b.p.dispose();
  birds = [];
  sel = 0;
};
const single = () => {
  clear();
  make(1, false, new THREE.Vector3(0, 0, -1), 0.6);
};
const row = () => {
  clear();
  const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
  seeds.forEach((s, i) => make(s, false, new THREE.Vector3(-2.4 + i * 0.42, 0, -1.8 + (i % 2) * 0.3), 0.4 + (i % 3) * 0.4));
  make(7, true, new THREE.Vector3(0, 0, -0.6), 0.9);
  sel = birds.length - 1;
};
single();

const cur = () => birds[sel]?.p;
const ui = document.getElementById('ui')!;
const btn = (label: string, fn: () => void) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = (e) => {
    e.stopPropagation();
    fn();
    refresh();
  };
  ui.append(b);
  return b;
};
const rnd = () => new THREE.Vector3((Math.random() - 0.5) * 3, cur()?.position.y ?? 0, -0.4 - Math.random() * 3);
btn('walk', () => void cur()?.walkTo(rnd(), { urgency: 0 }));
btn('scuttle', () => void cur()?.walkTo(rnd(), { urgency: 1 }));
btn('stop', () => cur()?.stop());
btn('face me', () => void cur()?.face(viewer));
btn('peck', () => void cur()?.peck());
btn('lunge', () => {
  const p = cur();
  if (p) void p.lunge(p.position.add(new THREE.Vector3(Math.sin(p.heading), 0, Math.cos(p.heading)).multiplyScalar(0.3)));
});
btn('sulk', () => void cur()?.sulk());
const moodBtns: Record<string, HTMLButtonElement> = {};
for (const m of ['calm', 'glance', 'offended'] as const) moodBtns[m] = btn(m, () => birds.forEach((b) => b.p.setMood(m, viewer)));
btn('fly in', () => {
  const p = cur();
  if (!p) return;
  const to = new THREE.Vector3((Math.random() - 0.5) * 2, 0, -1 - Math.random() * 2);
  void p.flyIn(new THREE.Vector3(-6 + Math.random() * 12, 4, -8), to);
});
btn('hop bench', () => void cur()?.hopTo(benchSpot));
btn('hop down', () => void cur()?.hopTo(new THREE.Vector3(1.2, 0, -0.75)));
btn('idle', () => birds.forEach((b) => b.p.idle()));
const rmBtn = btn('reduced: off', () => {
  reduced = !reduced;
  birds.forEach((b) => b.p.setReducedMotion(reduced));
});
const qBtn = btn('quality: high', () => {
  level = level === 'high' ? 'medium' : level === 'medium' ? 'low' : 'high';
  renderer.shadowMap.enabled = level !== 'low';
  scene.traverse((o) => {
    if ((o as THREE.Mesh).material) ((o as THREE.Mesh).material as THREE.Material).needsUpdate = true;
  });
  birds.forEach((b) => b.p.setQuality(quality()));
});
const camBtn = btn('close-up', () => (closeUp = !closeUp));
btn('one bird', single);
btn('flock row', row);
btn('next bird', () => (sel = (sel + 1) % Math.max(1, birds.length)));
const refresh = () => {
  rmBtn.textContent = `reduced: ${reduced ? 'on' : 'off'}`;
  qBtn.textContent = `quality: ${level}`;
  camBtn.classList.toggle('sel', closeUp);
};

// Click on the ground: selected bird walks so its beak lands on the spot, then pecks.
const ray = new THREE.Raycaster();
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshStandardMaterial({ color: 0xe8d2a0 }));
scene.add(marker);
renderer.domElement.addEventListener('pointerdown', async (e) => {
  ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObject(ground)[0];
  const p = cur();
  if (!hit || !p) return;
  marker.position.copy(hit.point).setY(0.006);
  const r = await p.walkTo(hit.point, { urgency: e.shiftKey ? 1 : 0.3, stopShort: p.reach });
  if (r === 'arrived') await p.peck();
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const stats = document.getElementById('stats')!;
const timer = new THREE.Timer();
const camTarget = new THREE.Vector3();
let fps = 60;
let t = 0;
// Lets a reviewer freeze or slow time to inspect a pose (lab.timeScale = 0).
const timing = { scale: 1, stepTo: 0 };
function frame() {
  timer.update();
  const raw = Math.min(timer.getDelta(), 0.1);
  let dt = raw * timing.scale;
  if (timing.stepTo > 0) {
    dt = Math.min(1 / 60, timing.stepTo);
    timing.stepTo -= dt;
  }
  t += dt;
  fps = fps * 0.95 + (1 / Math.max(raw, 1e-3)) * 0.05;
  for (const b of birds) b.p.update(dt, t);
  const p = cur();
  if (closeUp && p) {
    const pos = p.position;
    camTarget.lerp(pos.clone().add(new THREE.Vector3(0, 0.12, 0)), 1 - Math.exp(-6 * raw));
    camera.position.lerp(pos.clone().add(new THREE.Vector3(0.7, 0.32, 0.85)), 1 - Math.exp(-4 * raw));
    camera.lookAt(camTarget);
  } else {
    camera.position.copy(viewer);
    camTarget.set(0, 0.1, -1.4);
    camera.lookAt(camTarget);
  }
  renderer.render(scene, camera);
  stats.textContent = `${fps.toFixed(0)} fps · ${renderer.info.render.calls} calls · ${renderer.info.render.triangles} tris · ${p?.state ?? '-'} · ${log.join(' ')}`;
  requestAnimationFrame(frame);
}
frame();

Object.assign(window as unknown as Record<string, unknown>, {
  lab: {
    get birds() { return birds; },
    cur, camera, scene, THREE, viewer,
    setClose: (v: boolean) => (closeUp = v),
    select: (i: number) => (sel = i),
    single, row, timing,
    /** Advance the simulation by `s` seconds in 60 Hz steps while paused. */
    advance: (s: number) => {
      for (let i = 0; i < Math.round(s * 60); i++) {
        t += 1 / 60;
        for (const b of birds) b.p.update(1 / 60, t);
      }
    },
  },
});
