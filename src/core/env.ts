import type { Env } from '../contracts';

export function createEnv(): Env {
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const env: Env = {
    reducedMotion: motionQuery.matches,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    onReducedMotionChange(fn) {
      const listener = (e: MediaQueryListEvent) => {
        env.reducedMotion = e.matches;
        fn(e.matches);
      };
      motionQuery.addEventListener('change', listener);
      return () => motionQuery.removeEventListener('change', listener);
    },
  };
  return env;
}
