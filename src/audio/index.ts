import type { EventBus, VisitState } from '../contracts';

export interface AudioDeps {
  bus: EventBus;
  state: VisitState;
}

type Vec = { x: number; y: number; z: number };

const COO_URL = `${import.meta.env.BASE_URL}assets/audio/dove-coo.ogg`;
const MASTER_GAIN = 0.55;

/** Minimum spacing per sound kind, so a burst of events reads as texture rather than a machine gun. */
const MIN_GAP_S: Record<string, number> = {
  toss: 0.05,
  tick: 0.035,
  peck: 0.05,
  flap: 0.12,
  coo: 0.9,
  grumble: 0.6,
};
const MAX_VOICES: Record<string, number> = { toss: 3, tick: 4, peck: 4, flap: 3, coo: 2, grumble: 1 };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function createAudio({ bus, state }: AudioDeps): { dispose(): void } {
  let on = state.getSoundOn();
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let cooClips: Array<{ buffer: AudioBuffer; start: number; dur: number }> | null = null;
  let cooLoading = false;
  let disposed = false;
  const lastAt: Record<string, number> = {};
  const voices: Record<string, number> = {};
  const offs: Array<() => void> = [];

  const AudioCtor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;

  /* ---------------------------------------------------------------- context */

  function ensureContext(): AudioContext | null {
    if (ctx || !AudioCtor || disposed) return ctx;
    try {
      ctx = new AudioCtor({ latencyHint: 'interactive' });
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 0;
    // A soft limiter keeps a big squabble from clipping on laptop speakers.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);
    noise = makeNoise(ctx);
    void loadCoo();
    return ctx;
  }

  function applyOn() {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(on ? MASTER_GAIN : 0, t + 0.25);
    if (on) {
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    } else {
      const c = ctx;
      setTimeout(() => {
        if (!on && c.state === 'running') void c.suspend().catch(() => {});
      }, 300);
    }
  }

  // Browsers only allow audio to start inside a user gesture, so every gesture is a chance to (re)start it.
  const onGesture = () => {
    if (!on) return;
    const c = ensureContext();
    if (c && c.state !== 'running') {
      void c.resume().catch(() => {});
      applyOn();
    } else if (c && master && master.gain.value === 0) {
      applyOn();
    }
  };
  const gestureEvents = ['pointerdown', 'keydown', 'touchend'] as const;
  if (typeof window !== 'undefined') {
    for (const type of gestureEvents) window.addEventListener(type, onGesture, { capture: true, passive: true });
    offs.push(() => {
      for (const type of gestureEvents) window.removeEventListener(type, onGesture, { capture: true });
    });
  }

  const onVisibility = () => {
    if (!ctx) return;
    if (document.visibilityState === 'hidden') void ctx.suspend().catch(() => {});
    else if (on) void ctx.resume().catch(() => {});
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    offs.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  offs.push(
    bus.on('sound:toggled', ({ on: next }) => {
      on = next;
      // Emitted from the toggle's click handler, so this is still inside the gesture.
      if (on) ensureContext();
      applyOn();
    }),
  );

  /* ---------------------------------------------------------------- assets */

  async function loadCoo() {
    if (cooLoading || !ctx) return;
    cooLoading = true;
    try {
      const res = await fetch(COO_URL);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.arrayBuffer();
      const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
        // The callback form is the one older Safari understands.
        const p = ctx!.decodeAudioData(data, resolve, reject);
        if (p && typeof p.catch === 'function') p.catch(reject);
      });
      const clips = segmentCoos(buffer);
      if (clips.length) cooClips = clips;
    } catch {
      // No Ogg Vorbis decoder (some Safari versions) or a missing file: the synthesized coo takes over.
      cooClips = null;
    }
  }

  /* ---------------------------------------------------------------- voice plumbing */

  function claim(kind: string): boolean {
    if (!on || !ctx || !master || ctx.state !== 'running') return false;
    const now = ctx.currentTime;
    if (now - (lastAt[kind] ?? -1) < (MIN_GAP_S[kind] ?? 0)) return false;
    if ((voices[kind] ?? 0) >= (MAX_VOICES[kind] ?? 4)) return false;
    lastAt[kind] = now;
    voices[kind] = (voices[kind] ?? 0) + 1;
    return true;
  }

  function release(kind: string, afterS: number) {
    setTimeout(() => {
      voices[kind] = Math.max(0, (voices[kind] ?? 1) - 1);
    }, afterS * 1000 + 50);
  }

  /** A per-sound output placed roughly where the event happened, relative to the bench. */
  function outFor(at: Vec | null, level: number): GainNode {
    const c = ctx!;
    const g = c.createGain();
    let dist = 1;
    let pan = 0;
    if (at) {
      const dx = at.x;
      const dz = at.z - 2.2;
      dist = Math.hypot(dx, dz);
      pan = Math.max(-0.7, Math.min(0.7, dx / 4));
    }
    g.gain.value = level / (1 + Math.max(0, dist - 1.5) * 0.18);
    if (typeof c.createStereoPanner === 'function') {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(master!);
    } else {
      g.connect(master!);
    }
    return g;
  }

  function noiseSource(): AudioBufferSourceNode {
    const src = ctx!.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    return src;
  }

  /* ---------------------------------------------------------------- synthesized sounds */

  function toss() {
    if (!claim('toss')) return;
    const c = ctx!;
    const t = c.currentTime + 0.005;
    const out = outFor(null, 0.16);

    // Tear: a few dry crackles, the sound of crust giving way.
    for (let i = 0; i < 3; i++) {
      const s = noiseSource();
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = rand(2500, 4200);
      const g = c.createGain();
      const at = t + i * rand(0.012, 0.022);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(rand(0.35, 0.6), at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.018);
      s.connect(hp).connect(g).connect(out);
      s.start(at, Math.random());
      s.stop(at + 0.03);
    }

    // Whoosh: band-passed air rising as the crumb leaves the hand.
    const s = noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    const w0 = t + 0.04;
    bp.frequency.setValueAtTime(rand(500, 700), w0);
    bp.frequency.exponentialRampToValueAtTime(rand(2000, 2800), w0 + 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0, w0);
    g.gain.linearRampToValueAtTime(0.5, w0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, w0 + 0.26);
    s.connect(bp).connect(g).connect(out);
    s.start(w0, Math.random());
    s.stop(w0 + 0.3);
    release('toss', 0.35);
  }

  function tick(kind: 'tick' | 'peck', at: Vec | null) {
    if (!claim(kind)) return;
    const c = ctx!;
    const t = c.currentTime + 0.003;
    const out = outFor(at, kind === 'tick' ? 0.07 : 0.09);

    const osc = c.createOscillator();
    osc.type = 'triangle';
    const f = kind === 'tick' ? rand(1700, 2300) : rand(1100, 1500);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.03);
    const og = c.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.6, t + 0.001);
    og.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'tick' ? 0.025 : 0.035));
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + 0.05);

    const s = noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = kind === 'tick' ? 4200 : 3000;
    bp.Q.value = 2;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    s.connect(bp).connect(ng).connect(out);
    s.start(t, Math.random());
    s.stop(t + 0.02);
    release(kind, 0.06);
  }

  function flap(at: Vec | null, strength: number) {
    if (!claim('flap')) return;
    const c = ctx!;
    const k = Math.max(0.15, Math.min(1, strength));
    const beats = Math.round(2 + k * 4);
    const out = outFor(at, 0.1 + 0.16 * k);
    let t = c.currentTime + 0.005;
    const period = rand(0.075, 0.095);
    for (let i = 0; i < beats; i++) {
      const s = noiseSource();
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = rand(650, 1100) * (i === 0 ? 1.3 : 1);
      bp.Q.value = 0.9;
      const g = c.createGain();
      // Beats soften as the bird settles into the air.
      const peak = (i === 0 ? 1 : 0.75) * (1 - (i / beats) * 0.45);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
      s.connect(bp).connect(g).connect(out);
      s.start(t, Math.random());
      s.stop(t + 0.09);
      t += period * rand(0.92, 1.08);
    }
    release('flap', beats * period + 0.1);
  }

  function synthCoo(out: GainNode, rate: number, grumble: boolean) {
    const c = ctx!;
    const t = c.currentTime + 0.01;
    const dur = (grumble ? 0.35 : 0.7) / rate;
    const base = (grumble ? 210 : 300) * rate;

    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * 0.92, t);
    osc.frequency.linearRampToValueAtTime(base * 1.08, t + dur * 0.35);
    osc.frequency.linearRampToValueAtTime(base * 0.86, t + dur);

    // The throaty roll of a coo is fast amplitude flutter on a soft tone.
    const trem = c.createOscillator();
    trem.frequency.value = grumble ? 34 : 24;
    const tremDepth = c.createGain();
    tremDepth.gain.value = grumble ? 0.45 : 0.3;
    const amp = c.createGain();
    amp.gain.value = 0.6;
    trem.connect(tremDepth).connect(amp.gain);

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.8, t + 0.06);
    env.gain.setValueAtTime(0.8, t + dur * 0.7);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(amp).connect(lp).connect(env).connect(out);
    osc.start(t);
    trem.start(t);
    osc.stop(t + dur + 0.05);
    trem.stop(t + dur + 0.05);
    return dur;
  }

  function coo(at: Vec | null, isGerald: boolean, grumble = false) {
    const kind = grumble ? 'grumble' : 'coo';
    if (!claim(kind)) return;
    const c = ctx!;
    const out = outFor(at, (grumble ? 0.18 : 0.22) * (isGerald ? 1.15 : 1));
    // Gerald is a touch deeper, so a regular can pick his voice out of the crowd.
    const rate = (isGerald ? 0.9 : 1) * (grumble ? 0.82 : 1) * rand(0.93, 1.07);

    if (!cooClips) {
      release(kind, synthCoo(out, rate, grumble));
      return;
    }
    const clip = cooClips[Math.floor(Math.random() * cooClips.length)]!;
    const src = c.createBufferSource();
    src.buffer = clip.buffer;
    src.playbackRate.value = rate;
    // The recording is old and a little hissy; trimming the ends of the spectrum keeps it soft.
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 160;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = grumble ? 1800 : 3200;
    const dur = Math.min(clip.dur, grumble ? 0.45 : clip.dur);
    const g = c.createGain();
    const t = c.currentTime + 0.01;
    const played = dur / rate;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.03);
    g.gain.setValueAtTime(1, t + Math.max(0.04, played - 0.08));
    g.gain.linearRampToValueAtTime(0, t + played);
    src.connect(hp).connect(lp).connect(g).connect(out);
    src.start(t, clip.start, dur);
    src.stop(t + played + 0.05);
    release(kind, played);
  }

  /* ---------------------------------------------------------------- events */

  offs.push(
    bus.on('crumb:tossed', () => toss()),
    bus.on('crumb:landed', ({ at }) => tick('tick', at)),
    bus.on('pigeon:peck', ({ at }) => tick('peck', at)),
    bus.on('pigeon:flap', ({ at, strength }) => flap(at, strength)),
    bus.on('pigeon:coo', ({ at, isGerald }) => coo(at, isGerald)),
    bus.on('squabble', ({ at, winnerIsGerald }) => {
      flap(at, 0.8);
      setTimeout(() => coo(at, winnerIsGerald, true), 140);
    }),
  );

  return {
    dispose() {
      disposed = true;
      for (const off of offs) off();
      if (ctx) void ctx.close().catch(() => {});
      ctx = null;
      master = null;
    },
  };
}

/* ------------------------------------------------------------------ helpers */

function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 1.5);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * Finds individual coos in a longer recording by their loudness, so each play can pick a different one.
 * Gaps under ~350 ms are bridged because a dove's coo is a short note then a long one, and they belong together.
 */
export function segmentCoos(buffer: AudioBuffer): Array<{ buffer: AudioBuffer; start: number; dur: number }> {
  const data = buffer.getChannelData(0);
  const win = Math.max(1, Math.floor(buffer.sampleRate * 0.01));
  const rms: number[] = [];
  for (let i = 0; i + win <= data.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += data[j]! * data[j]!;
    rms.push(Math.sqrt(sum / win));
  }
  const peak = Math.max(0, ...rms);
  if (peak === 0) return [];
  const threshold = Math.max(0.01, peak * 0.22);

  const runs: Array<[number, number]> = [];
  let start = -1;
  let quiet = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i]! >= threshold) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 35) {
      runs.push([start, i - quiet]);
      start = -1;
      quiet = 0;
    }
  }
  if (start >= 0) runs.push([start, rms.length - 1]);

  const out: Array<{ buffer: AudioBuffer; start: number; dur: number }> = [];
  for (const [a, b] of runs) {
    const s = Math.max(0, a * 0.01 - 0.04);
    const e = Math.min(buffer.duration, (b + 1) * 0.01 + 0.08);
    const dur = e - s;
    if (dur >= 0.4 && dur <= 2.5) out.push({ buffer, start: s, dur });
  }
  // A recording with no clean gaps still gives us something rather than nothing.
  if (out.length === 0 && buffer.duration > 0.3) out.push({ buffer, start: 0, dur: Math.min(1.2, buffer.duration) });
  return out;
}
