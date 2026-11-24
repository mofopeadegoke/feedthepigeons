import type { EventBus, GameEvents } from '../contracts';

type Handler = (payload: never) => void;

export function createBus(): EventBus {
  const handlers = new Map<keyof GameEvents, Set<Handler>>();
  return {
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn as Handler);
      return () => set!.delete(fn as Handler);
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        // One misbehaving listener (say, audio failing to decode) must not stop the crumb from counting.
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (err) {
          console.error(`[bus] ${String(type)} listener failed`, err);
        }
      }
    },
  };
}
