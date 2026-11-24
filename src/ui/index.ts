import type { CounterClient, Env, EventBus, VisitState } from '../contracts';
import './hud.css';

/* ------------------------------------------------------------------ drawings */

const BREAD_SVG = `
<svg viewBox="0 0 24 22" aria-hidden="true" focusable="false">
  <path d="M3.6 9.4C1.6 8.6 1.2 5.9 2.9 4.3 5.1 2.2 8.6 1.5 12 1.5s7 .8 9.1 2.8c1.7 1.6 1.2 4.3-.8 5.1l-.4.2.3 9.1c0 1.3-1 2.3-2.3 2.3H6.8c-1.3 0-2.3-1-2.3-2.3l.3-9.1z"
    fill="#c98543" stroke="#7a4a20" stroke-width="1.3" stroke-linejoin="round"/>
  <path d="M5.7 10.6l.1-1.7C3.9 8.4 3.6 6.4 5 5.3 6.7 4 9.2 3.5 12 3.5s5.3.5 7 1.8c1.4 1.1 1.1 3.1-.8 3.6l.2 1.7-.3 8.3c0 .4-.4.8-.8.8H6.8c-.4 0-.8-.4-.8-.8z"
    fill="#f6dba6"/>
  <path d="M8.6 9.3c.5.3.9.2 1.2-.1M13.4 12.6c.4.4.9.4 1.3.1M9.9 15.4c.4.2.8.1 1-.2M15.3 8.4c.3.3.7.3 1 .1"
    fill="none" stroke="#d6a868" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;

const SPEAKER_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.8 9.3c-.1 1.8-.1 3.6 0 5.4.1.6.5 1 1.1 1h2.6l4.3 3.6c.6.5 1.5.1 1.5-.7.2-4.4.2-8.8 0-13.2 0-.8-.9-1.2-1.5-.7L7.5 8.3H4.9c-.6 0-1 .4-1.1 1z"
    fill="currentColor" fill-opacity=".12"/>
  <g class="ftp-waves">
    <path d="M16.3 9.2c.8.8 1.2 1.8 1.2 2.9s-.4 2-1.2 2.8"/>
    <path d="M18.6 6.7c1.5 1.4 2.3 3.3 2.3 5.3s-.8 3.9-2.3 5.4"/>
  </g>
  <g class="ftp-mute">
    <path d="M16.6 9.6l4.4 4.8M21 9.7l-4.3 4.6"/>
  </g>
</svg>`;

const HAND_SVG = `
<svg viewBox="0 0 40 48" aria-hidden="true" focusable="false">
  <path d="M15.2 22.5V7.4c0-1.9 1.4-3.3 3.1-3.3s3.1 1.4 3.1 3.3v11.3c.5-1.3 1.6-2 2.9-2 1.6 0 2.8 1.2 2.9 2.8.6-.9 1.6-1.4 2.6-1.4 1.6.1 2.8 1.4 2.8 3.1.5-.5 1.2-.8 1.9-.8 1.6 0 2.8 1.4 2.8 3.1v7.6c0 7.2-5 12.8-12 12.8h-1.4c-4.4 0-7.4-1.7-9.8-5.3L6.6 29.8c-.9-1.4-.6-3.2.7-4.1 1.3-.9 3-.6 4 .6z"
    fill="#fffaf1" stroke="#3a2e23" stroke-width="1.8" stroke-linejoin="round"/>
  <path d="M21.4 19.5v5.6M27.2 20.7v4.8M32.6 23.1v3.4" fill="none" stroke="#3a2e23" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

/* ------------------------------------------------------------------ announcer */

export interface Announcer {
  /**
   * Queue a polite announcement. Messages sharing a `key` collapse into one per window; pass a function to
   * phrase the collapsed count ("3 crumbs tossed.").
   */
  say(text: string | ((times: number) => string), opts?: { key?: string }): void;
  dispose(): void;
}

const QUIET_MS = 700;
const MIN_GAP_MS = 2200;

export function createAnnouncer(root: HTMLElement): Announcer {
  const region = document.createElement('div');
  region.className = 'ftp-sr';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  root.appendChild(region);

  const pending = new Map<string, { text: string | ((n: number) => string); times: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSpokeAt = -Infinity;
  let anon = 0;

  function flush() {
    timer = null;
    if (pending.size === 0) return;
    const parts: string[] = [];
    for (const { text, times } of pending.values()) parts.push(typeof text === 'function' ? text(times) : text);
    pending.clear();
    lastSpokeAt = performance.now();
    // Blanking first makes screen readers repeat a message identical to the last one.
    region.textContent = '';
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      region.textContent = parts.join(' ');
    }, 60);
  }

  return {
    say(text, opts) {
      const key = opts?.key ?? `anon-${anon++}`;
      const prev = pending.get(key);
      pending.set(key, { text, times: (prev?.times ?? 0) + 1 });
      if (timer) clearTimeout(timer);
      const now = performance.now();
      timer = setTimeout(flush, Math.max(QUIET_MS, lastSpokeAt + MIN_GAP_MS - now));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      if (clearTimer) clearTimeout(clearTimer);
      region.remove();
    },
  };
}

/* ------------------------------------------------------------------ HUD */

export interface HudDeps {
  root: HTMLElement;
  bus: EventBus;
  env: Env;
  state: VisitState;
  counter: CounterClient;
}

const COUNT_UP_MS = 1100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export function createHud({ root, bus, env, state, counter }: HudDeps): { dispose(): void } {
  const offs: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const hud = el('div', 'ftp-hud');
  const setStill = (still: boolean) => hud.classList.toggle('is-still', still);
  setStill(env.reducedMotion);
  offs.push(env.onReducedMotionChange(setStill));

  const announcer = createAnnouncer(hud);
  offs.push(() => announcer.dispose());

  /* ---------------- streak */

  const streak = el('div', 'ftp-pill ftp-streak', BREAD_SVG);
  const streakText = document.createElement('span');
  streak.appendChild(streakText);

  function showStreak(n: number, pop: boolean) {
    const visible = n > 0;
    streak.dataset.visible = String(visible);
    streak.setAttribute('aria-hidden', String(!visible));
    if (!visible) return;
    streakText.textContent = `Day ${n}`;
    if (pop && !env.reducedMotion) {
      streak.classList.remove('is-popping');
      // Forces a style flush so the animation restarts even if the class was already there.
      void streak.offsetWidth;
      streak.classList.add('is-popping');
    }
  }
  streak.addEventListener('animationend', (e) => {
    if (e.target === streak) streak.classList.remove('is-popping');
  });

  /* ---------------- sound */

  const sound = el('button', 'ftp-pill ftp-sound', SPEAKER_SVG);
  sound.type = 'button';
  sound.setAttribute('aria-label', 'Sound');
  const renderSound = (on: boolean) => {
    sound.setAttribute('aria-pressed', String(on));
    sound.title = on ? 'Sound on' : 'Sound off';
  };
  renderSound(state.getSoundOn());
  sound.addEventListener('click', () => {
    const on = !state.getSoundOn();
    state.setSoundOn(on);
    renderSound(on);
    bus.emit('sound:toggled', { on });
  });
  // The throw input listens for Space and pointer presses on the page; a press meant for this button must stop here.
  const swallow = (e: Event) => e.stopPropagation();
  const swallowKeys = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') e.stopPropagation();
  };
  sound.addEventListener('pointerdown', swallow);
  sound.addEventListener('touchstart', swallow, { passive: true });
  sound.addEventListener('keydown', swallowKeys);
  sound.addEventListener('keyup', swallowKeys);
  offs.push(
    bus.on('sound:toggled', ({ on }) => {
      if (sound.getAttribute('aria-pressed') !== String(on)) renderSound(on);
    }),
  );

  /* ---------------- counter */

  const counterEl = el('p', 'ftp-pill ftp-counter');
  const num = el('span', 'ftp-num');
  const words = document.createElement('span');
  counterEl.append(num, words);
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  let shown = 0;
  let target = 0;
  let from = 0;
  let tweenStart = 0;
  let raf = 0;
  let ready = false;

  function renderCount(n: number) {
    num.textContent = fmt.format(n);
    words.textContent = n === 1 ? ' crumb tossed worldwide in the last 24 hours' : ' crumbs tossed worldwide in the last 24 hours';
  }

  function step(now: number) {
    const t = Math.min(1, (now - tweenStart) / COUNT_UP_MS);
    const eased = 1 - (1 - t) ** 3;
    const v = Math.round(from + (target - from) * eased);
    if (v !== shown) {
      shown = v;
      renderCount(v);
    }
    raf = t < 1 ? requestAnimationFrame(step) : 0;
  }

  function setTotal(total: number) {
    target = Math.max(0, Math.round(total));
    if (!ready) {
      ready = true;
      renderCount(env.reducedMotion ? target : 0);
      shown = env.reducedMotion ? target : 0;
      counterEl.dataset.ready = 'true';
    }
    if (env.reducedMotion || target === shown) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      shown = target;
      renderCount(target);
      return;
    }
    from = shown;
    tweenStart = performance.now();
    if (!raf) raf = requestAnimationFrame(step);
  }
  offs.push(counter.onTotal(setTotal));
  offs.push(() => raf && cancelAnimationFrame(raf));

  /* ---------------- hint */

  let hint: HTMLElement | null = null;
  const snap = state.snapshot();
  if (!snap.hasThrownEver) {
    hint = el('div', 'ftp-hint');
    const hand = el('div', 'ftp-hint-hand', HAND_SVG);
    hand.prepend(el('span', 'ftp-hint-crumb'));
    const label = el('div', 'ftp-hint-label');
    label.textContent = env.coarsePointer ? 'swipe to toss' : 'drag to toss';
    const keys = el('div', 'ftp-hint-keys', 'or press <kbd>Space</kbd>');
    // On a phone "press Space" is noise, but a keyboard user on a tablet should still find it.
    if (env.coarsePointer) {
      keys.hidden = true;
      const reveal = () => {
        keys.hidden = false;
        window.removeEventListener('keydown', reveal);
      };
      window.addEventListener('keydown', reveal);
      offs.push(() => window.removeEventListener('keydown', reveal));
    }
    hint.append(hand, label, keys);
  }

  function dismissHint() {
    if (!hint) return;
    const h = hint;
    hint = null;
    state.markHintSeen();
    h.classList.add('is-leaving');
    later(() => h.remove(), env.reducedMotion ? 0 : 600);
  }

  /* ---------------- events */

  offs.push(
    bus.on('crumb:tossed', () => {
      dismissHint();
      announcer.say((n) => (n === 1 ? 'Crumb tossed.' : `${n} crumbs tossed.`), { key: 'toss' });
    }),
    bus.on('crumb:eaten', ({ isGerald, pigeonName }) => {
      const who = isGerald ? 'Gerald' : pigeonName;
      announcer.say(who ? `${who} is eating.` : 'A pigeon is eating.', { key: 'eat' });
    }),
    bus.on('squabble', ({ winnerIsGerald }) => {
      announcer.say(winnerIsGerald ? 'Gerald wins a squabble.' : 'The pigeons squabble.', { key: 'squabble' });
    }),
    bus.on('flock:forgiven', () => {
      announcer.say('The pigeons have forgiven you.', { key: 'mood' });
    }),
    bus.on('day:fed', ({ snapshot }) => {
      showStreak(snapshot.streak, true);
      announcer.say(`Day ${snapshot.streak}.`, { key: 'day' });
    }),
  );

  showStreak(snap.streak, false);
  if (snap.offended) {
    // Delayed so the live region exists in the accessibility tree before it speaks.
    later(() => announcer.say('The pigeons are ignoring you.', { key: 'mood' }), 1500);
  }

  hud.append(streak, sound, counterEl);
  if (hint) hud.append(hint);
  root.appendChild(hud);

  return {
    dispose() {
      for (const off of offs) off();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      hud.remove();
    },
  };
}
