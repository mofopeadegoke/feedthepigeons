import * as THREE from 'three';
import type { Env, Quality, QualityLevel, SceneHandle } from '../contracts';
import { loadSceneAssets } from './assets';
import { ensurePositioned } from './dom';
import { createGround } from './ground';
import { BENCH, createPark, createSkyDome } from './park';
import { guessInitialLevel, lowerLevel, qualityFor, FrameMonitor } from './quality';
import { CameraRig } from './rig';

export { showLoading } from './loading';
export { showFallback } from './fallback';

/** SceneHandle plus a manual override used by the lab page and debugging. */
export interface ParkSceneHandle extends SceneHandle {
  setQualityLevel(level: QualityLevel): void;
}

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return !!gl;
  } catch {
    return false;
  }
}

// Fog mixes after tone mapping and colour conversion, so these are display-space values set raw.
const HAZE_SRGB: [number, number, number] = [0.83, 0.85, 0.82];
const SUN_DIRECTION = new THREE.Vector3(0.62, 0.66, 0.3).normalize();
const WALK_BOUNDS = { minX: -3.5, maxX: 3.5, minZ: -7, maxZ: 0.6 };

export async function createScene(container: HTMLElement, env: Env): Promise<ParkSceneHandle> {
  ensurePositioned(container);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    touchAction: 'none',
  });
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);

  let quality: Quality = qualityFor(guessInitialLevel(env.coarsePointer));

  const assets = await loadSceneAssets(renderer);

  const scene = new THREE.Scene();
  const haze = new THREE.Color().setRGB(...HAZE_SRGB, THREE.LinearSRGBColorSpace);
  scene.fog = new THREE.Fog(haze.clone(), 10, 80);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromEquirectangular(skyForLighting(assets.sky)).texture;
  pmrem.dispose();
  scene.environment = envTex;
  scene.environmentIntensity = 0.75;
  scene.add(createSkyDome(assets.sky, haze));

  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.9, 0.76), 2.6);
  const sunTarget = new THREE.Object3D();
  sunTarget.position.set(0, 0, -3);
  sun.target = sunTarget;
  sun.position.copy(sunTarget.position).addScaledVector(SUN_DIRECTION, 30);
  const sc = sun.shadow.camera;
  sc.left = -11;
  sc.right = 11;
  sc.top = 11;
  sc.bottom = -11;
  sc.near = 5;
  sc.far = 60;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(sun, sunTarget);

  scene.add(createGround(assets));
  const park = createPark(assets);
  scene.add(park.root);

  const breadAnchor = new THREE.Vector3(0.3, BENCH.seatY, BENCH.frontZ + 0.11);
  const benchSpot = new THREE.Vector3(-0.3, BENCH.seatY, BENCH.frontZ + 0.16);

  const rig = new CameraRig({ anchor: breadAnchor.clone().setY(BENCH.seatY + 0.06) });
  rig.reducedMotion = env.reducedMotion;
  const camera = rig.camera;

  /* ---------------------------------------------------------------- sizing */

  let width = 1;
  let height = 1;
  const resize = () => {
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(quality.pixelRatio);
    renderer.setSize(width, height, false);
    rig.setAspect(width / height);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  // Dragging the window to another monitor changes DPR without resizing the container.
  const watchDpr = () => {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener(
      'change',
      () => {
        quality = { ...quality, pixelRatio: qualityFor(quality.level).pixelRatio };
        resize();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();

  /* ---------------------------------------------------------------- quality */

  const qualityListeners = new Set<(q: Quality) => void>();
  const shadowMapSize = (l: QualityLevel) => (l === 'high' ? 2048 : 1024);
  const grassShare = (l: QualityLevel) => (l === 'high' ? 1 : l === 'medium' ? 0.6 : 0.3);

  const applyQuality = (q: Quality, notify: boolean) => {
    const shadowsChanged = renderer.shadowMap.enabled !== q.shadows;
    quality = q;
    renderer.shadowMap.enabled = q.shadows;
    sun.castShadow = q.shadows;
    const size = shadowMapSize(q.level);
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    park.grass.mesh.count = Math.floor(park.grass.capacity * grassShare(q.level));
    if (shadowsChanged) {
      // Shadow support is compiled into each program, including pigeons added by other modules.
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    resize();
    if (notify) for (const fn of qualityListeners) fn(q);
  };
  applyQuality(quality, false);

  const monitor = new FrameMonitor(() => {
    const next = lowerLevel(quality.level);
    if (next) applyQuality(qualityFor(next), true);
  });

  /* ---------------------------------------------------------------- motion prefs, pointer */

  const setReduced = (r: boolean) => {
    rig.reducedMotion = r;
    park.grass.wind.value = r ? 0 : 1;
  };
  setReduced(env.reducedMotion);
  env.onReducedMotionChange(setReduced);

  window.addEventListener('pointermove', (e) => {
    // Touch drags are throws; letting them steer the camera would move the target mid-gesture.
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const r = canvas.getBoundingClientRect();
    rig.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  });
  document.documentElement.addEventListener('pointerleave', () => rig.setPointer(0, 0));

  /* ---------------------------------------------------------------- projection helpers */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const MAX_THROW = 15;

  const screenToGround = (x: number, y: number): THREE.Vector3 | null => {
    ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    // Near-horizon taps would otherwise land hundreds of metres away; pull them in to a long throw.
    const dx = hit.x - camera.position.x;
    const dz = hit.z - camera.position.z;
    const d = Math.hypot(dx, dz);
    if (d > MAX_THROW) {
      hit.x = camera.position.x + (dx / d) * MAX_THROW;
      hit.z = camera.position.z + (dz / d) * MAX_THROW;
    }
    return hit;
  };

  const projected = new THREE.Vector3();
  const worldToScreen = (p: THREE.Vector3) => {
    projected.copy(p).project(camera);
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    const visible = projected.z > -1 && projected.z < 1 && x >= 0 && x <= width && y >= 0 && y <= height;
    return { x, y, visible };
  };

  /* ---------------------------------------------------------------- loop */

  const frameListeners = new Set<(dt: number, t: number) => void>();
  let last = performance.now();
  let elapsed = 0;
  const tick = () => {
    const now = performance.now();
    const raw = (now - last) / 1000;
    last = now;
    monitor.sample(raw);
    const dt = Math.min(Math.max(raw, 0), 1 / 20);
    elapsed += dt;
    park.grass.time.value = elapsed;
    rig.update(dt, elapsed);
    for (const fn of frameListeners) fn(dt, elapsed);
    renderer.render(scene, camera);
  };

  resize();
  rig.frameFlock(1, true);
  await renderer.compileAsync(scene, camera);
  renderer.render(scene, camera);

  let started = false;
  const handle: ParkSceneHandle = {
    renderer,
    scene,
    camera,
    canvas,
    get quality() {
      return quality;
    },
    onQualityChange(fn) {
      qualityListeners.add(fn);
      return () => qualityListeners.delete(fn);
    },
    screenToGround,
    worldToScreen,
    breadAnchor,
    benchSpot,
    walkBounds: WALK_BOUNDS,
    frameFlock(count, instant) {
      rig.frameFlock(count, instant || env.reducedMotion);
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    start() {
      if (started) return;
      started = true;
      last = performance.now();
      renderer.setAnimationLoop(tick);
    },
    setQualityLevel(level) {
      applyQuality(qualityFor(level), true);
    },
  };
  return handle;
}

/**
 * The HDRI's sun is replaced by our own shadow-casting light, and the pure-sky lower half would
 * light birds from underneath like a lightbox. Clamp the sun and paint in a soft ground bounce.
 */
function skyForLighting(src: THREE.DataTexture): THREE.DataTexture {
  const { width, height } = src.image as { width: number; height: number };
  const data = src.image.data as unknown as Uint16Array | Float32Array;
  if (width < 2) return src;
  const isHalf = data instanceof Uint16Array;
  const read = (i: number) => (isHalf ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const out = new Uint16Array(width * height * 4);
  const half = THREE.DataUtils.toHalfFloat;

  let skySum = 0;
  let skyCount = 0;
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      skySum += 0.2126 * read(i) + 0.7152 * read(i + 1) + 0.0722 * read(i + 2);
      skyCount++;
    }
  }
  const skyAvg = skySum / Math.max(1, skyCount);
  const clampLum = skyAvg * 4;
  const ground = [skyAvg * 0.26, skyAvg * 0.25, skyAvg * 0.19];

  for (let y = 0; y < height; y++) {
    // Rows run top (zenith) to bottom; blend to the ground colour just under the horizon.
    const v = (y + 0.5) / height;
    const g = THREE.MathUtils.smoothstep(v, 0.49, 0.53);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = read(i);
      let gr = read(i + 1);
      let b = read(i + 2);
      const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
      if (lum > clampLum) {
        const k = clampLum / lum;
        r *= k;
        gr *= k;
        b *= k;
      }
      out[i] = half(r * (1 - g) + ground[0] * g);
      out[i + 1] = half(gr * (1 - g) + ground[1] * g);
      out[i + 2] = half(b * (1 - g) + ground[2] * g);
      out[i + 3] = half(1);
    }
  }
  // Half floats filter linearly everywhere; full floats need an extension many phones lack.
  const tex = new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.flipY = src.flipY;
  tex.colorSpace = src.colorSpace;
  tex.needsUpdate = true;
  return tex;
}
