import * as THREE from 'three';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Rest-pose landmarks in bird space: metres, +Z forward, +Y up, +X is the bird's left.
 * Left-side landmarks are mirrored for the right. Sized to a real rock dove (~0.32 m long, ~0.25 m tall).
 */
export const REST = {
  body: v3(0, 0.1, 0),
  neckBase: v3(0, 0.14, 0.045),
  head: v3(0, 0.211, 0.092),
  neck: v3(0, 0.1755, 0.0685),
  shoulder: v3(0.03, 0.152, 0.048),
  tail: v3(0, 0.1, -0.055),
  hip: v3(0.018, 0.064, 0.002),
  ankle: v3(0.021, 0.006, 0.012),
  beakTip: v3(0, 0.2036, 0.1342),
  eye: v3(0.0165, 0.2155, 0.099),
} as const;

export const EYE_R = 0.0058;
export const SPAN = 0.3;
export const WRIST_U = 0.42;
/** Horizontal feet-to-beak distance when the beak touches the ground (bird units). */
export const REACH = 0.105;

export const BONE = {
  base: 0,
  body: 1,
  neck: 2,
  head: 3,
  wingL: 4,
  wingLTip: 5,
  wingR: 6,
  wingRTip: 7,
  tail: 8,
  hipL: 9,
  hipR: 10,
  footL: 11,
  footR: 12,
} as const;
export const BONE_COUNT = 13;

/** Morph target slots on the shared geometry. */
export const MORPH = { wingL: 0, wingR: 1, tail: 2 } as const;

export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Centre surface of the spread left wing. u runs root to tip, v = -1 leading edge, +1 trailing edge.
 * v is chosen so the folded and spread mappings have the same handedness; otherwise the wing would
 * turn inside out (and get back-face culled) while it opens.
 */
export function spreadCenter(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  const S = REST.shoulder;
  const le =
    S.z +
    0.012 * Math.sin((Math.min(u / WRIST_U, 1) * Math.PI) / 2) -
    0.1 * Math.pow(Math.max(0, u - WRIST_U), 1.6);
  const chord =
    (0.085 + 0.03 * Math.sin((Math.min(u / 0.5, 1) * Math.PI) / 2)) * (1 - 0.82 * smooth(0.55, 1, u));
  return out.set(
    S.x + 0.004 + u * SPAN,
    S.y + 0.008 + u * 0.03 + 0.007 * (1 - v * v) * (1 - 0.5 * u),
    le - (chord * (1 + v)) / 2,
  );
}

export const WRIST = spreadCenter(WRIST_U, -1, new THREE.Vector3());
