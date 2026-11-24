import * as THREE from 'three';
import { createEnv } from '../src/core/env';
import { mulberry32 } from '../src/core/random';
import type { QualityLevel } from '../src/contracts';
import { createScene, hasWebGL, showFallback, showLoading } from '../src/scene';

const app = document.querySelector<HTMLElement>('#app')!;
const info = document.querySelector<HTMLElement>('#info')!;
const marker = document.querySelector<HTMLElement>('#marker')!;
const params = new URLSearchParams(location.search);
const env = createEnv();

function fallback() {
  app.innerHTML = '';
  let tosses = 0;
  showFallback(app, () => {
    info.textContent = `tosses: ${++tosses}`;
  });
}

async function main() {
  // Simulate a device size inside a desktop window without resizing the browser.
  if (params.has('w')) {
    app.style.cssText = `position:fixed;left:0;top:0;width:${params.get('w')}px;height:${params.get('h')}px;`;
    document.querySelector<HTMLElement>('#panel')!.style.left = `${Number(params.get('w')) + 16}px`;
  }
  if (params.has('fallback') || !hasWebGL()) return fallback();

  const loading = showLoading(app);
  if (params.has('hold')) return;
  const park = await createScene(app, env);

  const capsuleGeo = new THREE.CapsuleGeometry(0.075, 0.17, 6, 12);
  capsuleGeo.rotateX(Math.PI / 2);
  const capsuleMat = new THREE.MeshStandardMaterial({ color: 0x7a7c88, roughness: 0.6 });
  const birds: THREE.Mesh[] = [];
  const rng = mulberry32(3);
  const b = park.walkBounds;
  for (let i = 0; i < 24; i++) {
    const m = new THREE.Mesh(capsuleGeo, capsuleMat);
    // First bird near the bread, the rest scattered across the walkable area like a real flock.
    const x = i === 0 ? 0.3 : THREE.MathUtils.lerp(b.minX, b.maxX, rng());
    const z = i === 0 ? -0.6 : THREE.MathUtils.lerp(b.minZ, b.maxZ, rng());
    m.position.set(x, 0.12, z);
    m.rotation.y = rng() * Math.PI * 2;
    m.castShadow = m.receiveShadow = true;
    park.scene.add(m);
    birds.push(m);
  }
  const bench = new THREE.Mesh(capsuleGeo, capsuleMat);
  bench.position.copy(park.benchSpot).setY(park.benchSpot.y + 0.12);
  bench.castShadow = true;
  park.scene.add(bench);

  const bread = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.065, 0.1),
    new THREE.MeshStandardMaterial({ color: 0xc9935a, roughness: 0.8 }),
  );
  bread.position.copy(park.breadAnchor).setY(park.breadAnchor.y + 0.0325);
  bread.castShadow = bread.receiveShadow = true;
  park.scene.add(bread);

  const hitDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.05, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff2255 }),
  );
  hitDot.visible = false;
  park.scene.add(hitDot);

  let flock = Number(params.get('flock') ?? 1);
  const showFlock = (n: number) => birds.forEach((m, i) => (m.visible = i < n));
  showFlock(flock);
  park.frameFlock(flock, true);

  const q = params.get('q') as QualityLevel | null;
  if (q) park.setQualityLevel(q);

  park.onQualityChange((nq) => console.log('quality ->', nq));
  park.canvas.addEventListener('pointerdown', (e) => {
    const r = park.canvas.getBoundingClientRect();
    const hit = park.screenToGround(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    hitDot.position.copy(hit).setY(0.005);
    hitDot.visible = true;
  });

  document.querySelectorAll<HTMLButtonElement>('[data-flock]').forEach((btn) =>
    btn.addEventListener('click', () => {
      flock = Number(btn.dataset.flock);
      showFlock(flock);
      park.frameFlock(flock, false);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((btn) =>
    btn.addEventListener('click', () => park.setQualityLevel(btn.dataset.q as QualityLevel)),
  );
  document.querySelector('#fallback')!.addEventListener('click', () => {
    location.search = '?fallback';
  });

  let acc = 0;
  let frames = 0;
  park.onFrame((dt) => {
    acc += dt;
    frames++;
    const s = park.worldToScreen(park.breadAnchor);
    marker.hidden = !s.visible || !params.has('marker');
    marker.style.left = `${s.x}px`;
    marker.style.top = `${s.y}px`;
    if (acc > 0.5) {
      info.textContent = `${park.quality.level} · ${Math.round(frames / acc)} fps · fov ${park.camera.fov.toFixed(1)}`;
      acc = 0;
      frames = 0;
    }
  });

  park.start();
  await loading.done();
}

main();
