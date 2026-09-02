import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRange, fiscalYearStartYear, fiscalYearLabel, fiscalQuarter, zonedMidnightUTC, zonedParts,
} from '../lib/ranges.mjs';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

// 2026-08-31T12:00Z, a Monday, comfortably mid-day in every zone under test.
const NOW = new Date('2026-08-31T12:00:00Z');

const base = { now: NOW, timeZone: IST, fiscalYearStartMonth: 4, fiscalYearNaming: 'start_year' };

test('fiscalYearStartYear rolls back before the fiscal start month', () => {
  assert.equal(fiscalYearStartYear(2026, 8, 4), 2026);  // Aug is after April
  assert.equal(fiscalYearStartYear(2026, 3, 4), 2025);  // March belongs to FY starting 2025
  assert.equal(fiscalYearStartYear(2026, 4, 4), 2026);  // boundary month itself
  assert.equal(fiscalYearStartYear(2026, 1, 1), 2026);  // calendar-year FY
});

test('fiscalYearLabel honors naming, except for a January start', () => {
  assert.equal(fiscalYearLabel(2026, 4, 'start_year'), 2026);
  assert.equal(fiscalYearLabel(2026, 4, 'end_year'), 2027);
  // A January fiscal start IS the calendar year; end_year naming would be nonsense.
  assert.equal(fiscalYearLabel(2026, 1, 'end_year'), 2026);
});

test('fiscalQuarter is relative to the fiscal start, not the calendar', () => {
  for (const [month, q] of [[4, 1], [6, 1], [7, 2], [9, 2], [10, 3], [12, 3], [1, 4], [3, 4]]) {
    assert.equal(fiscalQuarter(2026, month, 4), q, `month ${month} should be Q${q}`);
  }
  // Calendar-aligned FY behaves conventionally.
  for (const [month, q] of [[1, 1], [4, 2], [7, 3], [10, 4]]) {
    assert.equal(fiscalQuarter(2026, month, 1), q);
  }
});

test('fiscal year bounds wrap across the calendar year', () => {
  const r = resolveRange('this_fy', base);
  assert.equal(r.startDate, '2026-04-01');
  assert.equal(r.endDate, '2027-03-31');
  assert.match(r.label, /^FY2026/);
});

test('end_year naming shifts only the label, not the bounds', () => {
  const r = resolveRange('this_fy', { ...base, fiscalYearNaming: 'end_year' });
  assert.equal(r.startDate, '2026-04-01');
  assert.equal(r.endDate, '2027-03-31');
  assert.match(r.label, /^FY2027/);
});

test('fiscal year start months 1, 4, 7, 10 all produce 12-month spans', () => {
  for (const startMonth of [1, 4, 7, 10]) {
    const r = resolveRange('this_fy', { ...base, fiscalYearStartMonth: startMonth });
    const days = (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000;
    assert.ok(days === 365 || days === 366, `start month ${startMonth} spanned ${days} days`);
    assert.equal(Number(r.startDate.slice(5, 7)), startMonth);
  }
});

test('a date just before the fiscal start belongs to the previous fiscal year', () => {
  const march = new Date('2026-03-31T12:00:00Z');
  const r = resolveRange('this_fy', { ...base, now: march });
  assert.equal(r.startDate, '2025-04-01');
  assert.equal(r.endDate, '2026-03-31');
});

test('last_fy is the full year before this_fy, with no gap or overlap', () => {
  const cur = resolveRange('this_fy', base);
  const prev = resolveRange('last_fy', base);
  assert.equal(prev.end, cur.start);
  assert.equal(prev.startDate, '2025-04-01');
});

test('quarters tile the fiscal year exactly', () => {
  const q = resolveRange('this_quarter', base);
  assert.equal(q.startDate, '2026-07-01');   // Aug 2026 is Q2 of an April FY
  assert.equal(q.endDate, '2026-09-30');
  assert.match(q.label, /^Q2 FY2026/);

  const prev = resolveRange('last_quarter', base);
  assert.equal(prev.end, q.start);
  assert.match(prev.label, /^Q1 FY2026/);
});

test('last_quarter crosses the fiscal year boundary correctly', () => {
  const may = new Date('2026-05-15T12:00:00Z');   // Q1 of FY2026 -> previous is Q4 of FY2025
  const r = resolveRange('last_quarter', { ...base, now: may });
  assert.equal(r.startDate, '2026-01-01');
  assert.equal(r.endDate, '2026-03-31');
  assert.match(r.label, /^Q4 FY2025/);
});

test('day, week and month ranges are half-open and contiguous', () => {
  const today = resolveRange('today', base);
  const yesterday = resolveRange('yesterday', base);
  assert.equal(yesterday.end, today.start);
  assert.equal(today.startDate, '2026-08-31');

  const week = resolveRange('this_week', base);
  assert.equal(week.startDate, '2026-08-31');   // Monday-start week; NOW is a Monday
  assert.equal(week.endDate, '2026-09-06');

  const lastWeek = resolveRange('last_week', base);
  assert.equal(lastWeek.end, week.start);

  const month = resolveRange('this_month', base);
  assert.equal(month.startDate, '2026-08-01');
  assert.equal(month.endDate, '2026-08-31');
});

test('weekStartsOn shifts the week boundary', () => {
  const sunday = resolveRange('this_week', { ...base, weekStartsOn: 0 });
  assert.equal(sunday.startDate, '2026-08-30');
});

test('last_month handles short months without clamping errors', () => {
  const mar31 = new Date('2026-03-31T12:00:00Z');
  const r = resolveRange('last_month', { ...base, now: mar31 });
  assert.equal(r.startDate, '2026-02-01');
  assert.equal(r.endDate, '2026-02-28');
});

test('last_N_* forms are inclusive of today', () => {
  const d = resolveRange('last 7 days', base);
  assert.equal(d.startDate, '2026-08-25');
  assert.equal(d.endDate, '2026-08-31');

  const w = resolveRange('last 3 weeks', base);
  assert.equal(w.startDate, '2026-08-11');
  assert.equal(w.endDate, '2026-08-31');

  const m = resolveRange('last_2_months', base);
  assert.equal(m.startDate, '2026-07-01');
});

test('a full year can be queried, nothing caps the range', () => {
  const r = resolveRange('last 12 months', base);
  assert.equal(r.startDate, '2025-09-01');
  assert.equal(r.endDate, '2026-08-31');
});

test('explicit ISO dates and ranges are accepted, end inclusive', () => {
  const single = resolveRange('2026-01-22', base);
  assert.equal(single.startDate, '2026-01-22');
  assert.equal(single.endDate, '2026-01-22');

  const span = resolveRange('2026-01-01..2026-03-31', base);
  assert.equal(span.startDate, '2026-01-01');
  assert.equal(span.endDate, '2026-03-31');
});

test('fy label form resolves under both naming conventions', () => {
  const a = resolveRange('fy2026', base);
  assert.equal(a.startDate, '2026-04-01');

  const b = resolveRange('fy2027', { ...base, fiscalYearNaming: 'end_year' });
  assert.equal(b.startDate, '2026-04-01');
});

test('bounds are local midnight in the configured zone, not UTC midnight', () => {
  const ist = resolveRange('today', base);
  // IST is UTC+5:30, so local midnight is the previous UTC evening.
  assert.equal(ist.start, '2026-08-30T18:30:00.000Z');

  const ny = resolveRange('today', { ...base, timeZone: NY });
  assert.equal(ny.start, '2026-08-31T04:00:00.000Z');   // EDT, UTC-4
});

test('the same instant can fall on different local days in different zones', () => {
  // 2026-08-31T20:00Z is already Sept 1 in Kolkata but still Aug 31 in New York.
  const late = new Date('2026-08-31T20:00:00Z');
  assert.equal(resolveRange('today', { ...base, now: late }).startDate, '2026-09-01');
  assert.equal(resolveRange('today', { ...base, now: late, timeZone: NY }).startDate, '2026-08-31');
});

test('zonedMidnightUTC survives a spring-forward transition', () => {
  // US DST began 2026-03-08; that local midnight is still EST (UTC-5).
  assert.equal(zonedMidnightUTC({ y: 2026, m: 3, d: 8 }, NY).toISOString(), '2026-03-08T05:00:00.000Z');
  // The day after is EDT (UTC-4).
  assert.equal(zonedMidnightUTC({ y: 2026, m: 3, d: 9 }, NY).toISOString(), '2026-03-09T04:00:00.000Z');
});

test('zonedMidnightUTC survives a fall-back transition', () => {
  // US DST ended 2026-11-01; local midnight that day is still EDT (UTC-4).
  assert.equal(zonedMidnightUTC({ y: 2026, m: 11, d: 1 }, NY).toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(zonedMidnightUTC({ y: 2026, m: 11, d: 2 }, NY).toISOString(), '2026-11-02T05:00:00.000Z');
});

test('zonedParts reports midnight as hour 0, never 24', () => {
  const p = zonedParts(new Date('2026-08-30T18:30:00Z'), IST);
  assert.deepEqual([p.y, p.m, p.d, p.hour], [2026, 8, 31, 0]);
});

test('a DST-transition day is still exactly one range, with no gap to the next', () => {
  const springForward = new Date('2026-03-08T18:00:00Z');
  const opts = { ...base, now: springForward, timeZone: NY };
  const today = resolveRange('today', opts);
  const tomorrow = resolveRange('2026-03-09', opts);
  assert.equal(today.end, tomorrow.start);
  // 23-hour day, because an hour was skipped.
  assert.equal((Date.parse(today.end) - Date.parse(today.start)) / 3_600_000, 23);
});

test('last_working_day skips the weekend on a Monday', () => {
  const monday = new Date('2026-08-31T12:00:00Z');   // NOW is a Monday
  const r = resolveRange('last_working_day', { ...base, now: monday });
  assert.equal(r.startDate, '2026-08-28', 'the preceding Friday, not Sunday');
  assert.equal(r.endDate, '2026-08-28');
});

test('last_working_day on a midweek day is simply the day before', () => {
  const wednesday = new Date('2026-09-02T12:00:00Z');
  const r = resolveRange('last_working_day', { ...base, now: wednesday });
  assert.equal(r.startDate, '2026-09-01');
});

test('last_working_day honors a custom weekend (e.g. Friday-Saturday)', () => {
  const sunday = new Date('2026-09-06T12:00:00Z');
  const r = resolveRange('last_working_day', { ...base, now: sunday, weekendDays: [5, 6] });
  assert.equal(r.startDate, '2026-09-03', 'Thursday, skipping Fri/Sat weekend');
});

test('unrecognized and malformed expressions fail loudly', () => {
  assert.throws(() => resolveRange('sometime last spring', base), /unrecognized range/);
  assert.throws(() => resolveRange('', base), /required/);
  assert.throws(() => resolveRange('2026-02-30', base), /unrecognized range/);   // not a real date
  assert.throws(() => resolveRange('2026-03-31..2026-01-01', base), /ends before it starts/);
  assert.throws(() => resolveRange('last_0_days', base), /at least 1/);
});
