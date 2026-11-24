import type { Quality, QualityLevel } from '../contracts';

const ORDER: QualityLevel[] = ['high', 'medium', 'low'];

export function qualityFor(level: QualityLevel): Quality {
  const dpr = window.devicePixelRatio || 1;
  switch (level) {
    case 'high':
      return { level, shadows: true, pixelRatio: Math.min(dpr, 2), maxPigeons: 24 };
    case 'medium':
      return { level, shadows: true, pixelRatio: Math.min(dpr, 1.5), maxPigeons: 18 };
    case 'low':
      return { level, shadows: false, pixelRatio: Math.min(dpr, 1), maxPigeons: 10 };
  }
}

export function guessInitialLevel(coarsePointer: boolean): QualityLevel {
  const small = Math.min(window.screen.width, window.screen.height) < 600;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarsePointer || small || cores <= 4) return 'medium';
  return 'high';
}

export function lowerLevel(level: QualityLevel): QualityLevel | null {
  const i = ORDER.indexOf(level);
  return i < ORDER.length - 1 ? ORDER[i + 1] : null;
}

/**
 * Watches real frame times and asks for a step down only on sustained slowness.
 * It never steps up: oscillating between levels is far more noticeable than staying a notch lower.
 */
export class FrameMonitor {
  private sum = 0;
  private frames = 0;
  private windowTime = 0;
  private slowWindows = 0;
  // Shader compiles and texture uploads make the first seconds unrepresentative.
  private grace = 2.5;

  constructor(private onSlow: () => void) {}

  /** rawDt in seconds, unclamped. */
  sample(rawDt: number) {
    // A long gap is a backgrounded tab or a debugger pause, not a slow GPU.
    if (rawDt > 0.25) return;
    if (this.grace > 0) {
      this.grace -= rawDt;
      return;
    }
    this.sum += rawDt;
    this.frames++;
    this.windowTime += rawDt;
    if (this.windowTime < 2) return;

    const avg = this.sum / this.frames;
    this.sum = 0;
    this.frames = 0;
    this.windowTime = 0;
    // ~36 fps: below this, motion in the throw and the waddle starts to look steppy.
    if (avg > 1 / 36) {
      this.slowWindows++;
      if (this.slowWindows >= 2) {
        this.slowWindows = 0;
        this.grace = 3;
        this.onSlow();
      }
    } else {
      this.slowWindows = 0;
    }
  }
}
