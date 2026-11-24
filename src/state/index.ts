import type { GeraldStage, VisitSnapshot, VisitState } from '../contracts';

export const STORAGE_KEY = 'ftp:v1';

/** Everything we keep about a visitor. Deliberately nothing that identifies them. */
export interface StoredVisit {
  /** Local calendar date (YYYY-MM-DD) of the last fed day, or null if never fed. */
  lastFedDay: string | null;
  streak: number;
  familiarity: number;
  totalDaysFed: number;
  hintSeen: boolean;
  soundOn: boolean;
}

/** What a visit looks like on a given day, derived from what's stored. */
export interface Arrival {
  /** Whole calendar days skipped since the last fed day (0 if none, or never fed). */
  missed: number;
  fedToday: boolean;
  /** Streak to display: 0 if never fed or broken by a missed day. */
  streak: number;
  familiarity: number;
  offended: boolean;
  flockSize: number;
  geraldStage: GeraldStage;
}

/** Minimal slice of the Web Storage API, so tests can hand in a fake or a broken one. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FRESH_VISIT: Readonly<StoredVisit> = Object.freeze({
  lastFedDay: null,
  streak: 0,
  familiarity: 1,
  totalDaysFed: 0,
  hintSeen: false,
  soundOn: false,
});

/* ------------------------------------------------------------------ calendar */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar date. Uses local getters on purpose: a streak day is the visitor's day, not UTC's. */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayNumber(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // UTC has no DST, so dividing by a fixed day length is exact here, unlike with local timestamps.
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Math.round(ms / 86_400_000);
}

/** Calendar days from `a` to `b` (positive if b is later). Null if either date is malformed. */
export function daysBetween(a: string, b: string): number | null {
  const na = dayNumber(a);
  const nb = dayNumber(b);
  if (na === null || nb === null) return null;
  return nb - na;
}

/* ------------------------------------------------------------------ curves */

const FLOCK_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 2],
  [3, 3],
  [7, 6],
  [14, 10],
  [30, 18],
  [45, 24],
];
const MAX_FLOCK = 24;

export function flockSizeFor(familiarity: number): number {
  if (!Number.isFinite(familiarity) || familiarity <= 1) return 1;
  const last = FLOCK_POINTS[FLOCK_POINTS.length - 1]!;
  if (familiarity >= last[0]) return MAX_FLOCK;
  for (let i = 1; i < FLOCK_POINTS.length; i++) {
    const [x1, y1] = FLOCK_POINTS[i]!;
    if (familiarity <= x1) {
      const [x0, y0] = FLOCK_POINTS[i - 1]!;
      const t = (familiarity - x0) / (x1 - x0);
      return Math.min(MAX_FLOCK, Math.max(1, Math.round(y0 + (y1 - y0) * t)));
    }
  }
  return MAX_FLOCK;
}

export function geraldStageFor(totalDaysFed: number): GeraldStage {
  if (!(totalDaysFed >= 5)) return 0;
  if (totalDaysFed < 14) return 1;
  if (totalDaysFed < 30) return 2;
  return 3;
}

/* ------------------------------------------------------------------ pure core */

function wholeAtLeast(v: unknown, min: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback;
}

/** Accepts anything (old versions, hand-edited storage, garbage) and returns a sane record or null. */
export function normalizeStored(raw: unknown): StoredVisit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lastFedDay =
    typeof r.lastFedDay === 'string' && dayNumber(r.lastFedDay) !== null ? r.lastFedDay : null;
  const totalDaysFed = wholeAtLeast(r.totalDaysFed, 0, 0);
  return {
    lastFedDay,
    streak: lastFedDay ? wholeAtLeast(r.streak, 1, 1) : 0,
    familiarity: wholeAtLeast(r.familiarity, 1, 1),
    totalDaysFed: lastFedDay ? Math.max(1, totalDaysFed) : totalDaysFed,
    hintSeen: r.hintSeen === true,
    soundOn: r.soundOn === true,
  };
}

export function computeArrival(stored: StoredVisit | null, today: string): Arrival {
  const s = stored ?? FRESH_VISIT;
  const gap = s.lastFedDay ? daysBetween(s.lastFedDay, today) : null;

  if (gap === null) {
    return {
      missed: 0,
      fedToday: false,
      streak: 0,
      familiarity: s.familiarity,
      offended: false,
      flockSize: s.totalDaysFed > 0 ? flockSizeFor(s.familiarity) : 1,
      geraldStage: geraldStageFor(s.totalDaysFed),
    };
  }

  // A last-fed day in the future means the clock moved backwards; treating it as today avoids punishing that.
  const fedToday = gap <= 0;
  const missed = Math.max(0, gap - 1);
  const familiarity = Math.max(1, s.familiarity - 2 * missed);
  return {
    missed,
    fedToday,
    streak: missed > 0 ? 0 : s.streak,
    familiarity,
    offended: missed > 0,
    flockSize: flockSizeFor(familiarity),
    geraldStage: geraldStageFor(s.totalDaysFed),
  };
}

/** The record after a toss on `today`. Returns the same object if today was already fed. */
export function commitFed(stored: StoredVisit | null, today: string): StoredVisit {
  const s = stored ?? FRESH_VISIT;
  const arrival = computeArrival(s, today);
  if (arrival.fedToday) return s as StoredVisit;
  const gap = s.lastFedDay ? daysBetween(s.lastFedDay, today) : null;
  return {
    ...s,
    lastFedDay: today,
    streak: gap === 1 ? s.streak + 1 : 1,
    // Day one is familiarity 1, so the curve reads as "days of friendship": day 7 → 6 birds, day 30 → 18.
    familiarity: s.lastFedDay ? arrival.familiarity + 1 : 1,
    totalDaysFed: s.totalDaysFed + 1,
  };
}

export function snapshotOf(stored: StoredVisit | null, today: string, firstVisitEver: boolean): VisitSnapshot {
  const s = stored ?? FRESH_VISIT;
  const a = computeArrival(s, today);
  return {
    streak: a.streak,
    familiarity: a.familiarity,
    totalDaysFed: s.totalDaysFed,
    flockSize: a.flockSize,
    geraldStage: a.geraldStage,
    offended: a.offended,
    firstVisitEver,
    hasThrownEver: s.hintSeen || s.totalDaysFed > 0,
    fedToday: a.fedToday,
  };
}

/* ------------------------------------------------------------------ storage */

function defaultStorage(): StorageLike | null {
  try {
    // Merely touching window.localStorage throws in some privacy modes and sandboxed iframes.
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function load(storage: StorageLike | null): { record: StoredVisit | null; ok: boolean } {
  if (!storage) return { record: null, ok: false };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { record: null, ok: true };
    return { record: normalizeStored(JSON.parse(raw)), ok: true };
  } catch {
    return { record: null, ok: false };
  }
}

function save(storage: StorageLike | null, record: StoredVisit): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota or a revoked permission: the in-memory record still carries the session.
  }
}

/* ------------------------------------------------------------------ public */

export function createVisitState(now?: Date, opts?: { storage?: StorageLike | null }): VisitState {
  const storage = opts && 'storage' in opts ? (opts.storage ?? null) : defaultStorage();
  const loaded = load(storage);
  const firstVisitEver = loaded.record === null;
  let record: StoredVisit = loaded.record ?? { ...FRESH_VISIT };
  let today = localDay(now ?? new Date());

  // Written straight away so a visitor who looks but never tosses isn't greeted as brand new next time.
  if (firstVisitEver) save(storage, record);

  const update = (next: StoredVisit) => {
    record = next;
    save(storage, record);
  };

  return {
    snapshot() {
      return snapshotOf(record, today, firstVisitEver);
    },
    recordToss(at?: Date) {
      today = localDay(at ?? new Date());
      const next = commitFed(record, today);
      if (next === record) return false;
      update(next);
      return true;
    },
    markHintSeen() {
      if (!record.hintSeen) update({ ...record, hintSeen: true });
    },
    getSoundOn() {
      return record.soundOn;
    },
    setSoundOn(on: boolean) {
      if (record.soundOn !== on) update({ ...record, soundOn: on });
    },
  };
}
