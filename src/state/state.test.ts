import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as S from './index.ts';
import type { StorageLike, StoredVisit } from './index';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  };
}

/** Local noon, so a test never straddles midnight by accident. */
function day(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m - 1, d, h, 0, 0);
}

function stored(partial: Partial<StoredVisit>): StoredVisit {
  return { ...S.FRESH_VISIT, ...partial };
}

/* ------------------------------------------------------------------ calendar */

test('localDay uses local time, not UTC', () => {
  assert.equal(S.localDay(new Date(2026, 0, 5, 0, 10)), '2026-01-05');
  assert.equal(S.localDay(new Date(2026, 0, 5, 23, 50)), '2026-01-05');
});

test('daysBetween is calendar arithmetic, across month/year ends and leap days', () => {
  assert.equal(S.daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(S.daysBetween('2025-12-31', '2026-01-01'), 1);
  assert.equal(S.daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.equal(S.daysBetween('2026-03-10', '2026-03-03'), -7);
  assert.equal(S.daysBetween('nonsense', '2026-03-03'), null);
  assert.equal(S.daysBetween('2026-02-30', '2026-03-03'), null);
});

test('DST transitions do not create or swallow a day', () => {
  // Spring-forward and fall-back weekends in both hemispheres' common rules; local midnights are 23h/25h apart.
  for (const [a, b] of [
    ['2026-03-07', '2026-03-08'],
    ['2026-03-08', '2026-03-09'],
    ['2026-03-28', '2026-03-29'],
    ['2026-03-29', '2026-03-30'],
    ['2026-10-24', '2026-10-25'],
    ['2026-10-25', '2026-10-26'],
    ['2026-10-31', '2026-11-01'],
    ['2026-11-01', '2026-11-02'],
  ] as const) {
    assert.equal(S.daysBetween(a, b), 1, `${a} → ${b}`);
  }
  // Late-night tosses on consecutive days across a DST change still continue the streak.
  const st = S.createVisitState(day(2026, 3, 28, 23), { storage: memoryStorage() });
  st.recordToss(new Date(2026, 2, 28, 23, 30));
  st.recordToss(new Date(2026, 2, 29, 23, 30));
  st.recordToss(new Date(2026, 2, 30, 0, 30));
  assert.equal(st.snapshot().streak, 3);
});

/* ------------------------------------------------------------------ curves */

test('flock curve hits its anchor points', () => {
  const anchors: Array<[number, number]> = [[1, 5], [3, 6], [7, 8], [14, 12], [30, 18], [45, 24]];
  for (const [f, n] of anchors) assert.equal(S.flockSizeFor(f), n, `familiarity ${f}`);
});

test('flock curve interpolates, rounds, is monotonic and bounded', () => {
  assert.equal(S.flockSizeFor(5), 7); // 6 + 2 * (2/4) = 7
  assert.equal(S.flockSizeFor(22), 15);
  assert.equal(S.flockSizeFor(0), 5);
  assert.equal(S.flockSizeFor(-4), 5);
  assert.equal(S.flockSizeFor(Number.NaN), 5);
  assert.equal(S.flockSizeFor(100), 24);
  let prev = 0;
  for (let f = 1; f <= 60; f++) {
    const n = S.flockSizeFor(f);
    assert.ok(n >= prev && n >= 5 && n <= 24, `familiarity ${f} → ${n}`);
    prev = n;
  }
});

test('Gerald stages', () => {
  assert.equal(S.geraldStageFor(0), 0);
  assert.equal(S.geraldStageFor(4), 0);
  assert.equal(S.geraldStageFor(5), 1);
  assert.equal(S.geraldStageFor(13), 1);
  assert.equal(S.geraldStageFor(14), 2);
  assert.equal(S.geraldStageFor(29), 2);
  assert.equal(S.geraldStageFor(30), 3);
  assert.equal(S.geraldStageFor(400), 3);
});

/* ------------------------------------------------------------------ arrival + commit */

test('a brand-new visitor', () => {
  const storage = memoryStorage();
  const st = S.createVisitState(day(2026, 5, 1), { storage });
  const snap = st.snapshot();
  assert.deepEqual(snap, {
    streak: 0,
    familiarity: 1,
    totalDaysFed: 0,
    flockSize: 5,
    geraldStage: 0,
    offended: false,
    firstVisitEver: true,
    hasThrownEver: false,
    fedToday: false,
  });
  assert.equal(st.getSoundOn(), false);
  // Recorded straight away, so the next visit is not "first ever".
  assert.ok(storage.data.has(S.STORAGE_KEY));
  assert.equal(S.createVisitState(day(2026, 5, 1), { storage }).snapshot().firstVisitEver, false);
});

test('first toss of the day commits once; later tosses do not', () => {
  const storage = memoryStorage();
  const st = S.createVisitState(day(2026, 5, 1), { storage });
  assert.equal(st.recordToss(day(2026, 5, 1, 9)), true);
  assert.equal(st.recordToss(day(2026, 5, 1, 10)), false);
  assert.equal(st.recordToss(day(2026, 5, 1, 23)), false);
  const snap = st.snapshot();
  assert.equal(snap.streak, 1);
  assert.equal(snap.familiarity, 1);
  assert.equal(snap.totalDaysFed, 1);
  assert.equal(snap.fedToday, true);
  assert.equal(snap.hasThrownEver, true);
  assert.equal(snap.flockSize, 5);
});

test('consecutive days build the streak and the flock', () => {
  const storage = memoryStorage();
  for (let d = 1; d <= 7; d++) {
    const st = S.createVisitState(day(2026, 5, d), { storage });
    assert.equal(st.snapshot().offended, false);
    assert.equal(st.recordToss(day(2026, 5, d)), true);
  }
  const snap = S.createVisitState(day(2026, 5, 7), { storage }).snapshot();
  assert.equal(snap.streak, 7);
  assert.equal(snap.familiarity, 7);
  assert.equal(snap.totalDaysFed, 7);
  assert.equal(snap.geraldStage, 1);
});

test('the next day, before feeding, the streak is still shown', () => {
  const s = stored({ lastFedDay: '2026-05-10', streak: 4, familiarity: 5, totalDaysFed: 4 });
  const a = S.computeArrival(s, '2026-05-11');
  assert.equal(a.streak, 4);
  assert.equal(a.missed, 0);
  assert.equal(a.offended, false);
  assert.equal(a.fedToday, false);
  assert.equal(a.familiarity, 5);
});

test('one missed day: offended, streak hidden, familiarity −2, resets to 1 on feeding', () => {
  const storage = memoryStorage();
  storage.setItem(
    S.STORAGE_KEY,
    JSON.stringify(stored({ lastFedDay: '2026-05-10', streak: 6, familiarity: 9, totalDaysFed: 12 })),
  );
  const st = S.createVisitState(day(2026, 5, 12), { storage });
  const before = st.snapshot();
  assert.equal(before.offended, true);
  assert.equal(before.streak, 0);
  assert.equal(before.familiarity, 7);
  assert.equal(before.flockSize, S.flockSizeFor(7));
  assert.equal(before.firstVisitEver, false);

  assert.equal(st.recordToss(day(2026, 5, 12)), true);
  const after = st.snapshot();
  assert.equal(after.offended, false);
  assert.equal(after.streak, 1);
  assert.equal(after.familiarity, 8);
  assert.equal(after.totalDaysFed, 13);
});

test('many missed days floor familiarity at 1', () => {
  const s = stored({ lastFedDay: '2026-01-01', streak: 30, familiarity: 31, totalDaysFed: 30 });
  const a = S.computeArrival(s, '2026-03-01');
  assert.equal(a.missed, 58);
  assert.equal(a.familiarity, 1);
  assert.equal(a.flockSize, 5);
  assert.equal(a.geraldStage, 3); // Gerald remembers even when the crowd doesn't.
  const next = S.commitFed(s, '2026-03-01');
  assert.equal(next.familiarity, 2);
  assert.equal(next.streak, 1);
});

test('the penalty is not applied twice when visiting again without feeding', () => {
  const storage = memoryStorage();
  storage.setItem(S.STORAGE_KEY, JSON.stringify(stored({ lastFedDay: '2026-05-01', streak: 3, familiarity: 10, totalDaysFed: 3 })));
  const a = S.createVisitState(day(2026, 5, 4), { storage }).snapshot();
  const b = S.createVisitState(day(2026, 5, 4, 18), { storage }).snapshot();
  assert.equal(a.familiarity, 6);
  assert.equal(b.familiarity, 6);
});

test('a page left open past midnight commits the new day on the next toss', () => {
  const st = S.createVisitState(day(2026, 5, 1, 23), { storage: memoryStorage() });
  assert.equal(st.recordToss(new Date(2026, 4, 1, 23, 59)), true);
  assert.equal(st.recordToss(new Date(2026, 4, 2, 0, 1)), true);
  assert.equal(st.snapshot().streak, 2);
});

test('clock weirdness: a last-fed day in the future is treated as today', () => {
  const s = stored({ lastFedDay: '2026-06-20', streak: 5, familiarity: 6, totalDaysFed: 5 });
  const a = S.computeArrival(s, '2026-06-01');
  assert.equal(a.offended, false);
  assert.equal(a.fedToday, true);
  assert.equal(a.streak, 5);
  assert.equal(a.familiarity, 6);
  assert.equal(S.commitFed(s, '2026-06-01'), s);
});

test('corrupt or hand-edited storage is normalised, not trusted', () => {
  const storage = memoryStorage();
  storage.setItem(S.STORAGE_KEY, '{not json');
  assert.equal(S.createVisitState(day(2026, 5, 1), { storage }).snapshot().streak, 0);

  storage.setItem(S.STORAGE_KEY, JSON.stringify({ lastFedDay: '2026-13-45', streak: 'lots', familiarity: -9, soundOn: 'yes' }));
  const st = S.createVisitState(day(2026, 5, 1), { storage });
  const snap = st.snapshot();
  assert.equal(snap.streak, 0);
  assert.equal(snap.familiarity, 1);
  assert.equal(st.getSoundOn(), false);

  assert.deepEqual(S.normalizeStored({ lastFedDay: '2026-05-01', streak: 0, familiarity: 3.7, totalDaysFed: 0 }), {
    lastFedDay: '2026-05-01',
    streak: 1,
    familiarity: 3,
    totalDaysFed: 1,
    hintSeen: false,
    soundOn: false,
  });
});

/* ------------------------------------------------------------------ storage failure */

test('storage that throws on every access still works for the session', () => {
  const throwing: StorageLike = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
  const st = S.createVisitState(day(2026, 5, 1), { storage: throwing });
  assert.equal(st.snapshot().streak, 0);
  assert.equal(st.recordToss(day(2026, 5, 1)), true);
  assert.equal(st.recordToss(day(2026, 5, 1)), false);
  st.markHintSeen();
  st.setSoundOn(true);
  assert.equal(st.getSoundOn(), true);
  assert.equal(st.snapshot().streak, 1);
  assert.equal(st.snapshot().hasThrownEver, true);
});

test('no storage at all still works for the session', () => {
  const st = S.createVisitState(day(2026, 5, 1), { storage: null });
  assert.equal(st.recordToss(day(2026, 5, 1)), true);
  assert.equal(st.recordToss(day(2026, 5, 2)), true);
  assert.equal(st.snapshot().streak, 2);
});

test('default storage lookup never throws outside a browser', () => {
  assert.doesNotThrow(() => S.createVisitState(day(2026, 5, 1)).snapshot());
});

test('hint and sound preferences persist', () => {
  const storage = memoryStorage();
  const a = S.createVisitState(day(2026, 5, 1), { storage });
  a.markHintSeen();
  a.setSoundOn(true);
  const b = S.createVisitState(day(2026, 5, 3), { storage });
  assert.equal(b.snapshot().hasThrownEver, true);
  assert.equal(b.getSoundOn(), true);
  const saved = JSON.parse(storage.data.get(S.STORAGE_KEY)!);
  assert.deepEqual(Object.keys(saved).sort(), ['familiarity', 'hintSeen', 'lastFedDay', 'soundOn', 'streak', 'totalDaysFed']);
});
