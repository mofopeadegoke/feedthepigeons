import * as THREE from 'three';
import type { Env, InputKind, SceneHandle } from '../contracts';
import type { Bread } from './bread';
import { TUNING } from './tuning';

export interface AimInputDeps {
  scene: SceneHandle;
  env: Env;
  bread: Bread;
  /** Where the flock roughly is, so an untouched keyboard ring can wander near the birds. */
  flockCentre(out: THREE.Vector3): THREE.Vector3;
  /** `to` null means a tap: an underhand drop in front of the bread. Returns false if throttled. */
  onToss(to: THREE.Vector3 | null, input: InputKind): boolean;
}

export interface AimInput {
  update(dt: number, t: number): void;
  dispose(): void;
}

const RING_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAG = /* glsl */ `
  uniform float uOpacity;
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float breathe = 0.03 * sin(uTime * 3.2);
    float ring = smoothstep(0.58 + breathe, 0.76 + breathe, r) * (1.0 - smoothstep(0.8 + breathe, 1.0, r));
    float fill = 0.12 * (1.0 - smoothstep(0.0, 0.7, r));
    float a = (ring * 0.7 + fill) * uOpacity;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const STYLE_ID = 'feeding-focus-style';

function injectFocusStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Inset so the outline survives a full-bleed canvas; the dark halo keeps it visible over pale sky and path alike.
  style.textContent = `
    canvas[data-feeding]:focus { outline: none; }
    canvas[data-feeding]:focus-visible {
      outline: 3px solid #fff6df;
      outline-offset: -7px;
      box-shadow: inset 0 0 0 7px rgba(58, 40, 22, 0.55);
    }
    canvas[data-feeding] { cursor: grab; }
    canvas[data-feeding][data-dragging] { cursor: grabbing; }
  `;
  document.head.appendChild(style);
}

export function createAimInput(deps: AimInputDeps): AimInput {
  const { scene, env, bread } = deps;
  const canvas = scene.canvas;
  injectFocusStyle();

  const prevTabIndex = canvas.getAttribute('tabindex');
  const prevAriaHidden = canvas.getAttribute('aria-hidden');
  // The canvas becomes the interactive control, so it must be exposed to assistive tech.
  canvas.removeAttribute('aria-hidden');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute(
    'aria-label',
    'Pigeons in a park. Press Space or Enter to toss a crumb to the aim ring; arrow keys move the ring. ' +
      'With a mouse or finger, drag up and away from the bread and let go to throw; tap for a short drop.',
  );
  canvas.setAttribute('aria-roledescription', 'pigeon feeding area');
  canvas.dataset.feeding = '';
  canvas.style.touchAction = 'none';

  /* ---------------------------------------------------------- ring */

  const ringMat = new THREE.ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color('#fff4dc') } },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 5;
  ring.visible = false;
  ring.name = 'aim-ring';
  scene.scene.add(ring);

  const ringPos = new THREE.Vector3();
  let ringOpacity = 0;
  let ringPulse = 0;
  let ringPlaced = false;

  /* ---------------------------------------------------------- mapping */

  const anchor = scene.breadAnchor;
  const b = scene.walkBounds;
  const clampTarget = (p: THREE.Vector3) => {
    const T = TUNING.throw;
    p.x = THREE.MathUtils.clamp(p.x, b.minX - 1.5, b.maxX + 1.5);
    // The bread may sit on the bench behind the walkable path; near throws still land where a bird can reach.
    const nearest = Math.min(anchor.z - T.minAheadOfBread, b.maxZ - 0.08);
    p.z = THREE.MathUtils.clamp(p.z, anchor.z - T.maxDistance - 0.5, nearest);
    p.y = 0;
    return p;
  };

  /** Drag in CSS px (dx right, forward = up the screen) → landing point, or null in the cancel zone. */
  const dragToTarget = (dx: number, forward: number, out: THREE.Vector3): THREE.Vector3 | null => {
    const T = TUNING.throw;
    if (forward < T.cancelPx) return null;
    const h = canvas.clientHeight || window.innerHeight;
    const ref = THREE.MathUtils.clamp(h * T.refFraction, T.refMinPx, T.refMaxPx);
    const length = Math.hypot(dx, forward);
    const f = THREE.MathUtils.clamp((length - T.cancelPx * 0.5) / ref, 0, 1);
    const dMin = Math.max(T.minDistance, anchor.z - b.maxZ + 0.1);
    const d = dMin + (T.maxDistance - dMin) * Math.pow(f, T.curveExponent);
    const angle = THREE.MathUtils.clamp(Math.atan2(dx * T.aimGain, Math.max(forward, 30)), -T.aimMax, T.aimMax);
    out.set(anchor.x + Math.sin(angle) * d, 0, anchor.z - Math.cos(angle) * d);
    return clampTarget(out);
  };

  /* ---------------------------------------------------------- pointer */

  interface Drag {
    id: number;
    kind: InputKind;
    x0: number;
    y0: number;
    moved: number;
    target: THREE.Vector3 | null;
  }
  let drag: Drag | null = null;
  const dragTarget = new THREE.Vector3();

  const localXY = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 || drag) return;
    const { x, y } = localXY(e);
    drag = { id: e.pointerId, kind: e.pointerType === 'mouse' ? 'mouse' : 'touch', x0: x, y0: y, moved: 0, target: null };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; synthetic or already-released pointers can refuse it */
    }
    canvas.dataset.dragging = '';
    keyboardActive = false;
    // A little anticipation pinch on press, so the bread feels grabbed before you even move.
    bread.setPull(new THREE.Vector3(anchor.x, 0, anchor.z - 1), 0.25);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { x, y } = localXY(e);
    const dx = x - drag.x0;
    const forward = drag.y0 - y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, forward));
    if (drag.moved < TUNING.throw.tapSlopPx) return;
    drag.target = dragToTarget(dx, forward, dragTarget);
    if (drag.target) {
      if (!ringPlaced || ringOpacity < 0.05) {
        ringPos.copy(drag.target);
        ringPlaced = true;
      }
      const d = drag.target.distanceTo(new THREE.Vector3(anchor.x, 0, anchor.z));
      bread.setPull(drag.target, 0.3 + 0.7 * Math.min(1, d / 8));
    } else {
      bread.setPull(null, 0);
    }
  };

  const endDrag = (e: PointerEvent, cancelled: boolean) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    delete canvas.dataset.dragging;
    bread.setPull(null, 0);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (cancelled) return;
    if (d.moved < TUNING.throw.tapSlopPx) {
      deps.onToss(null, d.kind);
    } else if (d.target) {
      if (deps.onToss(d.target.clone(), d.kind)) ringPulse = 1;
    }
  };
  const onPointerUp = (e: PointerEvent) => endDrag(e, false);
  const onPointerCancel = (e: PointerEvent) => endDrag(e, true);

  /* ---------------------------------------------------------- keyboard */

  const held = new Set<string>();
  const kbTarget = new THREE.Vector3();
  let kbMoved = false;
  let keyboardActive = false;
  let holdTime = 0;
  const drift = { from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1 };

  const pickDriftSpot = (out: THREE.Vector3) => {
    deps.flockCentre(out);
    const a = Math.random() * Math.PI * 2;
    const r = 0.3 + Math.random() * 1.1;
    out.x += Math.cos(a) * r;
    out.z += Math.sin(a) * r * 0.8;
    out.x = THREE.MathUtils.clamp(out.x, b.minX + 0.3, b.maxX - 0.3);
    out.z = THREE.MathUtils.clamp(out.z, b.minZ + 0.3, Math.min(b.maxZ - 0.2, anchor.z - 1));
    return clampTarget(out);
  };
  pickDriftSpot(kbTarget);

  const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (ARROWS.has(e.key)) {
      e.preventDefault();
      if (!held.has(e.key)) held.add(e.key);
      kbMoved = true;
      drift.t = 1;
      keyboardActive = true;
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      keyboardActive = true;
      if (deps.onToss(kbTarget.clone(), 'keyboard')) {
        ringPulse = 1;
        if (!kbMoved) {
          drift.from.copy(kbTarget);
          pickDriftSpot(drift.to);
          drift.t = env.reducedMotion ? 1 : 0;
          if (env.reducedMotion) kbTarget.copy(drift.to);
        }
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.key);
  };
  const onFocus = () => {
    let visible = true;
    try {
      visible = canvas.matches(':focus-visible');
    } catch {
      /* older engines without :focus-visible: assume keyboard, a stray ring is harmless */
    }
    if (visible) keyboardActive = true;
  };
  const onBlur = () => {
    held.clear();
    keyboardActive = false;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('focus', onFocus);
  canvas.addEventListener('blur', onBlur);

  const tmp = new THREE.Vector3();

  return {
    update(dt, t) {
      // Hold-to-move ramps up so a single tap nudges and a long hold travels.
      if (held.size > 0) {
        holdTime += dt;
        const ramp = Math.min(1, 0.25 + holdTime / TUNING.ring.keyAccelSeconds);
        const dist = Math.hypot(kbTarget.x - anchor.x, kbTarget.z - anchor.z);
        const scale = ramp * (1 + dist / 6);
        let lx = 0, lz = 0;
        if (held.has('ArrowLeft')) lx -= 1;
        if (held.has('ArrowRight')) lx += 1;
        if (held.has('ArrowUp')) lz -= 1;
        if (held.has('ArrowDown')) lz += 1;
        kbTarget.x += lx * TUNING.ring.keySpeedLateral * scale * dt;
        kbTarget.z += lz * TUNING.ring.keySpeedDepth * scale * dt;
        clampTarget(kbTarget);
      } else {
        holdTime = 0;
      }
      if (drift.t < 1) {
        drift.t = Math.min(1, drift.t + dt / TUNING.ring.driftSeconds);
        const k = drift.t * drift.t * (3 - 2 * drift.t);
        kbTarget.lerpVectors(drift.from, drift.to, k);
      }

      const dragging = drag !== null && drag.target !== null;
      const show = dragging || keyboardActive;
      const goal = dragging ? drag!.target! : keyboardActive ? kbTarget : null;
      if (goal) {
        if (!ringPlaced || env.reducedMotion || ringOpacity < 0.02) ringPos.copy(goal);
        else ringPos.lerp(goal, 1 - Math.exp(-dt * 22));
        ringPlaced = true;
      }
      const rate = show ? 1 / TUNING.ring.fadeIn : -1 / TUNING.ring.fadeOut;
      ringOpacity = THREE.MathUtils.clamp(ringOpacity + rate * dt, 0, 1);
      ringPulse = Math.max(0, ringPulse - dt * 3.5);

      ring.visible = ringOpacity > 0.001;
      if (ring.visible) {
        tmp.set(anchor.x, 0, anchor.z);
        const d = ringPos.distanceTo(tmp);
        const radius = TUNING.ring.baseRadius + TUNING.ring.radiusPerMetre * d;
        // A quick contraction on toss acknowledges the input without a flash.
        const pulse = env.reducedMotion ? 1 : 1 - 0.22 * Math.sin(ringPulse * Math.PI);
        ring.scale.setScalar(radius * pulse);
        ring.position.set(ringPos.x, 0.006, ringPos.z);
        const eased = ringOpacity * ringOpacity * (3 - 2 * ringOpacity);
        ringMat.uniforms.uOpacity.value = eased * 0.9;
        ringMat.uniforms.uTime.value = env.reducedMotion ? 0 : t;
      }
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('focus', onFocus);
      canvas.removeEventListener('blur', onBlur);
      delete canvas.dataset.feeding;
      delete canvas.dataset.dragging;
      if (prevAriaHidden !== null) canvas.setAttribute('aria-hidden', prevAriaHidden);
      if (prevTabIndex === null) canvas.removeAttribute('tabindex');
      else canvas.setAttribute('tabindex', prevTabIndex);
      scene.scene.remove(ring);
      ring.geometry.dispose();
      ringMat.dispose();
    },
  };
}
