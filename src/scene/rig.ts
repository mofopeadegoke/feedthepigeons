import * as THREE from 'three';

const DEG = Math.PI / 180;

export interface RigOptions {
  /** The point that must stay near the bottom of the frame (the bread). */
  anchor: THREE.Vector3;
}

/**
 * The seated viewer's camera. Framing is solved each frame from two constraints rather than
 * hand-tuned per breakpoint: the bread sits a fixed fraction above the bottom edge, and the far
 * edge of the flock sits below the top edge. Aspect only changes how much FOV / dolly that needs.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private anchor: THREE.Vector3;
  private flock = 0;
  private flockTarget = 0;
  private pointer = new THREE.Vector2();
  private pointerSmoothed = new THREE.Vector2();
  private aspect = 1;
  reducedMotion = false;

  constructor(opts: RigOptions) {
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 600);
    this.anchor = opts.anchor.clone();
  }

  setAspect(aspect: number) {
    this.aspect = aspect;
    this.apply(0);
  }

  /** Normalised pointer in [-1, 1]; the parallax target. */
  setPointer(x: number, y: number) {
    this.pointer.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(y, -1, 1));
  }

  frameFlock(count: number, instant: boolean) {
    const f = THREE.MathUtils.clamp((count - 1) / 23, 0, 1);
    // Most of the pull-back happens over the first dozen birds, where each new one changes the scene most.
    this.flockTarget = Math.sqrt(f);
    if (instant || this.reducedMotion) {
      this.flock = this.flockTarget;
      this.apply(0);
    }
  }

  update(dt: number, t: number) {
    // Slow, critically damped feel: a flock arriving shouldn't yank the viewer's head.
    this.flock += (this.flockTarget - this.flock) * (1 - Math.exp(-dt * 1.1));
    if (this.reducedMotion) {
      this.pointerSmoothed.set(0, 0);
    } else {
      this.pointerSmoothed.lerp(this.pointer, 1 - Math.exp(-dt * 2.2));
    }
    this.apply(t);
  }

  private apply(t: number) {
    const f = this.flock;
    const a = this.aspect;
    // Narrow screens dolly back and up a little so the sides of the flock aren't lost.
    const narrow = THREE.MathUtils.clamp((1.25 - a) / 0.8, 0, 1);

    const camY = 1.12 + 0.16 * f + 0.45 * narrow;
    const camZ = 2.42 + 0.28 * f + 0.7 * narrow;

    const farZ = THREE.MathUtils.lerp(-3.4, -7.4, f);
    // On a phone held upright the sides of a big flock can spill out; the bread and the centre matter more.
    const halfW = THREE.MathUtils.lerp(1.5, 3.6, f) * THREE.MathUtils.lerp(1, 0.72, narrow);
    const midZ = THREE.MathUtils.lerp(-0.8, -2.6, f);

    const aAnchor = Math.atan2(camY - this.anchor.y, camZ - this.anchor.z);
    const aFar = Math.atan2(camY, camZ - farZ);
    const anchorNdc = -0.8;
    const farNdc = 0.5;
    const horizonNdc = THREE.MathUtils.lerp(0.92, 0.6, f);

    let lo = 30 * DEG;
    let hi = 92 * DEG;
    for (let i = 0; i < 24; i++) {
      const v = (lo + hi) / 2;
      const tv = Math.tan(v / 2);
      const pitch = aAnchor - Math.atan(-anchorNdc * tv);
      // Keep a band of tree line and sky above the horizon: it's what makes this a park, not a floor.
      const farOk = pitch - aFar <= Math.atan(farNdc * tv) && pitch <= Math.atan(horizonNdc * tv);
      if (farOk) hi = v;
      else lo = v;
    }
    let vfov = hi;
    const hHalf = Math.atan(halfW / (camZ - midZ));
    const vFromH = 2 * Math.atan(Math.tan(hHalf) / a);
    vfov = Math.min(Math.max(vfov, vFromH * 0.9), THREE.MathUtils.lerp(80, 66, narrow) * DEG);
    const tv = Math.tan(vfov / 2);
    const pitch = aAnchor - Math.atan(-anchorNdc * tv);

    const px = this.pointerSmoothed.x;
    const py = this.pointerSmoothed.y;
    const breathe = this.reducedMotion ? 0 : Math.sin(t * 0.9) * 0.0035;

    const cam = this.camera;
    cam.position.set(px * 0.09, camY + py * 0.035 + breathe, camZ);
    cam.rotation.set(-pitch - py * 0.012, -px * 0.025, 0, 'YXZ');
    cam.fov = vfov / DEG;
    cam.aspect = a;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
