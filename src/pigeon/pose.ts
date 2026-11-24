/** Animation channels. Layers write targets every frame; each channel eases toward its target at its own rate. */
export const C = {
  bodyPitch: 0, bodyRoll: 1, bodyYaw: 2, bodyLift: 3, bodyFwd: 4, bodySide: 5,
  puff: 6, throat: 7,
  headYaw: 8, headPitch: 9, headRoll: 10, headFwd: 11, headUp: 12, headSide: 13,
  spreadL: 14, spreadR: 15, flapL: 16, flapR: 17, sweepL: 18, sweepR: 19, tipL: 20, tipR: 21,
  liftL: 22, liftR: 23,
  tailPitch: 24, tailYaw: 25, tailSpread: 26,
  tuck: 27, legReach: 28,
} as const;
export type Channel = (typeof C)[keyof typeof C];
const N = 29;

const DEF = new Float32Array(N);
DEF[C.puff] = 1;
DEF[C.throat] = 1;

const RATE = new Float32Array(N).fill(12);
for (const c of [C.bodyPitch, C.bodyRoll, C.bodyYaw, C.bodyLift, C.bodyFwd, C.bodySide]) RATE[c] = 10;
RATE[C.puff] = 3.5;
RATE[C.throat] = 7;
for (const c of [C.headYaw, C.headPitch, C.headRoll]) RATE[c] = 14;
for (const c of [C.headFwd, C.headUp, C.headSide]) RATE[c] = 16;
for (const c of [C.tailPitch, C.tailYaw, C.tailSpread]) RATE[c] = 9;
RATE[C.tuck] = 8;
RATE[C.legReach] = 8;

export class Pose {
  readonly v = new Float32Array(N);
  private readonly t = new Float32Array(N);
  private readonly r = new Float32Array(N);

  constructor() {
    this.v.set(DEF);
  }

  begin(): void {
    this.t.set(DEF);
    this.r.set(RATE);
  }

  /** Set a target. rate = Infinity snaps (needed for oscillations like wingbeats that smoothing would flatten). */
  to(ch: Channel, value: number, rate?: number): void {
    this.t[ch] = value;
    if (rate !== undefined) this.r[ch] = rate;
  }

  add(ch: Channel, delta: number): void {
    this.t[ch] += delta;
  }

  target(ch: Channel): number {
    return this.t[ch];
  }

  step(dt: number): void {
    for (let i = 0; i < N; i++) {
      const r = this.r[i];
      if (r === Infinity) this.v[i] = this.t[i];
      else this.v[i] += (this.t[i] - this.v[i]) * (1 - Math.exp(-r * dt));
    }
  }

  reset(): void {
    this.v.set(DEF);
    this.t.set(DEF);
  }
}
