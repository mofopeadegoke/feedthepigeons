import * as THREE from 'three';
import { mulberry32 } from '../core/random';

export type MorphKind = 'blueBar' | 'checker' | 'dark' | 'ashRed' | 'pied';

export const COLOR_KEYS = [
  'body', 'head', 'shield', 'bar', 'flight', 'tail', 'tailBand', 'rump',
  'iridA', 'iridB', 'beak', 'cere', 'eye', 'leg',
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export interface PigeonLook {
  kind: MorphKind;
  colors: Record<ColorKey, THREE.Color>;
  irid: number;
  checker: number;
  pied: number;
  gerald: number;
  patchSeed: number;
  size: number;
  temperament: number;
}

type Palette = Record<ColorKey, number> & { irid: number; checker: number };

const SHARED = { cere: 0xe2ddd3, eye: 0xe0681a, leg: 0xc0515c, beak: 0x2a2a2d };

const PALETTES: Record<Exclude<MorphKind, 'pied'>, Palette> = {
  blueBar: {
    ...SHARED,
    body: 0x80889a, head: 0x535a68, shield: 0xa4acba, bar: 0x222429, flight: 0x5a5f6a,
    tail: 0x7c8394, tailBand: 0x24262b, rump: 0xa9afbb, iridA: 0x2f9a63, iridB: 0x8c3f9c,
    irid: 0.9, checker: 0,
  },
  checker: {
    ...SHARED,
    body: 0x737a8a, head: 0x4b505c, shield: 0x949ba8, bar: 0x25272c, flight: 0x50555f,
    tail: 0x6f7686, tailBand: 0x222428, rump: 0x8c929e, iridA: 0x2c955f, iridB: 0x86399a,
    irid: 0.9, checker: 0.9,
  },
  dark: {
    ...SHARED,
    body: 0x3b3e45, head: 0x2b2d32, shield: 0x464a52, bar: 0x222327, flight: 0x2e3035,
    tail: 0x383b41, tailBand: 0x1d1e21, rump: 0x42454c, iridA: 0x2a9c66, iridB: 0x93409f,
    irid: 1.0, checker: 0.5,
  },
  ashRed: {
    ...SHARED,
    beak: 0xc2ab94, leg: 0xcc6466,
    body: 0xb5a49b, head: 0xa38f85, shield: 0xd0c2b8, bar: 0x8a4434, flight: 0xc3b0a4,
    tail: 0xc5b5ab, tailBand: 0xa47a68, rump: 0xd5cac2, iridA: 0x8aa766, iridB: 0xb06488,
    irid: 0.55, checker: 0,
  },
};

/** Stable per seed, so a returning visitor sees the same birds. */
export function lookForSeed(seed: number, isGerald: boolean): PigeonLook {
  const rng = mulberry32(seed * 2654435761 + 17);
  const roll = rng();
  let kind: MorphKind = 'blueBar';
  if (!isGerald) {
    if (roll < 0.48) kind = 'blueBar';
    else if (roll < 0.72) kind = 'checker';
    else if (roll < 0.84) kind = 'dark';
    else if (roll < 0.92) kind = 'ashRed';
    else kind = 'pied';
  }
  const baseKind = kind === 'pied' ? (rng() < 0.6 ? 'blueBar' : 'checker') : kind;
  const pal = PALETTES[baseKind];
  // One lightness offset for all plumage so a bird reads as a whole lighter or darker individual.
  const light = (rng() - 0.5) * 0.06;
  const sat = (rng() - 0.5) * 0.06;
  const colors = {} as Record<ColorKey, THREE.Color>;
  for (const key of ['body', 'head', 'shield', 'bar', 'flight', 'tail', 'tailBand', 'rump', 'iridA', 'iridB', 'beak', 'cere', 'eye', 'leg'] as const) {
    const c = new THREE.Color(pal[key]);
    if (key !== 'eye' && key !== 'leg' && key !== 'cere' && key !== 'beak') c.offsetHSL(0, sat, light);
    colors[key] = c;
  }
  if (kind === 'pied' && rng() < 0.5) colors.beak = new THREE.Color(0xc9b6a2);
  return {
    kind,
    colors,
    irid: pal.irid,
    checker: pal.checker * (0.7 + 0.3 * rng()),
    pied: kind === 'pied' ? 0.45 + 0.35 * rng() : 0,
    gerald: isGerald ? 1 : 0,
    patchSeed: rng() * 100,
    size: isGerald ? 1.04 : 0.93 + 0.12 * rng(),
    temperament: rng(),
  };
}
