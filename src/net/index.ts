import type { CounterClient } from '../contracts';

export interface CounterClientOptions {
  endpoint?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const SEND_EVERY_MS = 5_000;
const POLL_EVERY_MS = 30_000;
const TICK_MS = 1_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Mirrors the server's clamp, so honest batches are never trimmed. */
const MAX_PER_SECOND = 10;
const MAX_PER_REQUEST = 100;

function readTotal(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const t = (body as { total?: unknown }).total;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.floor(t) : null;
}

export function createCounterClient(opts: CounterClientOptions = {}): CounterClient {
  const endpoint = opts.endpoint ?? '/api/crumbs';
  const doFetch = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const hasDocument = typeof document !== 'undefined';

  const listeners = new Set<(total: number) => void>();
  let serverTotal: number | null = null;
  let sessionCrumbs = 0;
  let queued = 0;
  let inFlight = 0;
  let lastSentAt = Date.now();
  let nextSendAt = 0;
  let nextPollAt = 0;
  let failures = 0;
  let busy = false;
  let disposed = false;
  let lastEmitted: number | null = null;

  const isHidden = () => hasDocument && document.visibilityState === 'hidden';

  function display(): number | null {
    if (serverTotal !== null) return serverTotal + queued + inFlight;
    // Until the API answers, the page still feels alive by counting this session's own crumbs.
    return sessionCrumbs > 0 ? sessionCrumbs : null;
  }

  function emit() {
    const v = display();
    if (v === null || v === lastEmitted) return;
    lastEmitted = v;
    for (const fn of [...listeners]) fn(v);
  }

  function budget(now: number): number {
    const allowance = Math.floor(((now - lastSentAt) / 1000) * MAX_PER_SECOND);
    return Math.min(MAX_PER_REQUEST, allowance, queued);
  }

  function backoff(now: number) {
    failures++;
    const delay = Math.min(MAX_BACKOFF_MS, SEND_EVERY_MS * 2 ** failures);
    nextSendAt = now + delay;
    nextPollAt = now + Math.max(delay, POLL_EVERY_MS);
  }

  async function request(method: 'GET' | 'POST', count?: number): Promise<number | null> {
    if (!doFetch) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await doFetch(endpoint, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : { accept: 'application/json' },
        body: method === 'POST' ? JSON.stringify({ count }) : undefined,
        cache: 'no-store',
        credentials: 'same-origin',
        keepalive: method === 'POST',
        signal: ctrl?.signal,
      });
      if (!res.ok) return null;
      // Vite's dev server answers unknown paths with index.html, so a 200 isn't proof the API exists.
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) return null;
      return readTotal(await res.json());
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function send(now: number) {
    const n = budget(now);
    if (n <= 0) return;
    busy = true;
    queued -= n;
    inFlight += n;
    lastSentAt = now;
    const total = await request('POST', n);
    inFlight -= n;
    busy = false;
    if (disposed) return;
    const after = Date.now();
    if (total === null) {
      queued += n;
      backoff(after);
    } else {
      failures = 0;
      serverTotal = total;
      nextSendAt = after + SEND_EVERY_MS;
      nextPollAt = after + POLL_EVERY_MS;
    }
    emit();
  }

  async function poll() {
    busy = true;
    const total = await request('GET');
    busy = false;
    if (disposed) return;
    const after = Date.now();
    if (total === null) {
      backoff(after);
    } else {
      failures = 0;
      serverTotal = total;
      nextPollAt = after + POLL_EVERY_MS;
    }
    emit();
  }

  function tick() {
    if (disposed || busy || isHidden()) return;
    const now = Date.now();
    if (queued > 0 && now >= nextSendAt && now - lastSentAt >= SEND_EVERY_MS) {
      void send(now);
    } else if (now >= nextPollAt) {
      void poll();
    }
  }

  function flushWithBeacon() {
    // Only worth it once the API has proven itself; beacons to a missing endpoint just fill the network log.
    if (queued <= 0 || failures > 0 || serverTotal === null) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    const now = Date.now();
    const n = budget(now);
    if (n <= 0) return;
    try {
      const blob = new Blob([JSON.stringify({ count: n })], { type: 'application/json' });
      if (navigator.sendBeacon(endpoint, blob)) {
        queued -= n;
        serverTotal += n;
        lastSentAt = now;
      }
    } catch {
      // A refused beacon just leaves the crumbs queued for the next visible tick.
    }
  }

  const onVisibility = () => {
    if (isHidden()) {
      flushWithBeacon();
    } else {
      tick();
    }
  };
  const onPageHide = () => flushWithBeacon();

  if (hasDocument) document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
  const interval = setInterval(tick, TICK_MS);
  // Defer the first fetch so construction stays side-effect-light for whoever wires listeners next.
  const kickoff = setTimeout(tick, 0);

  return {
    add(n = 1) {
      if (disposed || !(n > 0)) return;
      const whole = Math.floor(n);
      sessionCrumbs += whole;
      queued += whole;
      emit();
    },
    onTotal(fn) {
      listeners.add(fn);
      const v = display();
      if (v !== null) fn(v);
      return () => listeners.delete(fn);
    },
    dispose() {
      if (disposed) return;
      flushWithBeacon();
      disposed = true;
      clearInterval(interval);
      clearTimeout(kickoff);
      listeners.clear();
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    },
  };
}
