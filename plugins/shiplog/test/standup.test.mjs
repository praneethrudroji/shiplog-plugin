import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvents, setSyncState } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { resolveRange } from '../lib/ranges.mjs';
import {
  loadStandupState, saveStandupState, alreadyShownToday, formatStandupSummary, runStandupCheck,
  dayHeading, groupByDay,
} from '../lib/standup.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-standup-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function tempStatePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-standup-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'standup_state.json');
}

function cfg(over = {}) {
  const c = defaultConfig();
  c.timezone = 'UTC';
  c.standup = { enabled: true, range: 'last_working_day', ...over };
  return c;
}

const ev = (over) => ({
  source: 'github', event_type: 'pr_opened', external_id: `x-${Math.random()}`,
  project: 'octo', title: 'Add retry to the payment client',
  url: 'https://github.com/octo/payments/pull/42', occurred_at: '2026-08-28T10:00:00.000Z',
  raw_json: {}, synced_at: '2026-08-31T22:00:00.000Z', ...over,
});

// A Monday: last_working_day resolves to the preceding Friday.
const MONDAY = new Date('2026-08-31T12:00:00Z');

test('state starts empty and round-trips through save/load', (t) => {
  const path = tempStatePath(t);
  assert.deepEqual(loadStandupState(path), { lastShownDate: null });
  saveStandupState(path, { lastShownDate: '2026-08-31' });
  assert.deepEqual(loadStandupState(path), { lastShownDate: '2026-08-31' });
});

test('a corrupt state file is treated as empty rather than crashing the hook', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-standup-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'standup_state.json');
  writeFileSync(path, '{ not json');
  assert.deepEqual(loadStandupState(path), { lastShownDate: null });
});

test('alreadyShownToday compares against the stored date only', () => {
  assert.equal(alreadyShownToday({ lastShownDate: '2026-08-31' }, '2026-08-31'), true);
  assert.equal(alreadyShownToday({ lastShownDate: '2026-08-30' }, '2026-08-31'), false);
  assert.equal(alreadyShownToday({ lastShownDate: null }, '2026-08-31'), false);
});

test('formatStandupSummary reports counts and a stale-sync warning', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    ev({ external_id: 'a', event_type: 'pr_opened' }),
    ev({ external_id: 'b', event_type: 'pr_merged' }),
    ev({ external_id: 'c', event_type: 'pr_merged' }),
  ]);
  setSyncState(db, 'github', { status: 'error', error: 'bad credentials' });

  const range = resolveRange('last_working_day', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const text = formatStandupSummary(db, cfg(), range);

  assert.match(text, /2 PRs merged/);
  assert.match(text, /1 PR opened/);
  assert.match(text, /Add retry to the payment client/);
  assert.match(text, /github/);
  assert.match(text, /shiplog-status/);
});

test('formatStandupSummary handles a quiet period without erroring', (t) => {
  const db = tempDb(t);
  const range = resolveRange('last_working_day', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const text = formatStandupSummary(db, cfg(), range);
  assert.match(text, /no tracked activity/);
});

test('runStandupCheck is a no-op when disabled', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const result = runStandupCheck({ cfg: cfg({ enabled: false }), db, statePath: tempStatePath(t), now: MONDAY });
  assert.equal(result, null);
});

test('runStandupCheck fires once, then stays quiet for the rest of the day', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const statePath = tempStatePath(t);

  const first = runStandupCheck({ cfg: cfg(), db, statePath, now: MONDAY });
  assert.ok(first, 'first check of the day should produce a summary');

  const later = new Date(MONDAY.getTime() + 6 * 3_600_000);   // same day, six hours later
  const second = runStandupCheck({ cfg: cfg(), db, statePath, now: later });
  assert.equal(second, null, 'must not fire twice in the same day');
});

test('runStandupCheck fires again on the following day', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const statePath = tempStatePath(t);

  runStandupCheck({ cfg: cfg(), db, statePath, now: MONDAY });
  const nextDay = new Date(MONDAY.getTime() + 24 * 3_600_000);
  const result = runStandupCheck({ cfg: cfg(), db, statePath, now: nextDay });
  assert.ok(result, 'a new calendar day should fire again');
});

test('the range choice (week/month) is honored', (t) => {
  const db = tempDb(t);
  // MONDAY is 2026-08-31: last_week = Aug 24-30, last_month = July (calendar month
  // before August). Mid-July falls in neither "this week" nor "last week".
  upsertEvents(db, [ev({ external_id: 'a', occurred_at: '2026-07-15T00:00:00.000Z' })]);

  const weekResult = runStandupCheck({ cfg: cfg({ range: 'last_week' }), db, statePath: tempStatePath(t), now: MONDAY });
  assert.match(weekResult, /no tracked activity/);

  const monthResult = runStandupCheck({ cfg: cfg({ range: 'last_month' }), db, statePath: tempStatePath(t), now: MONDAY });
  assert.match(monthResult, /1 PR opened/);
});

test('with no database yet, the check still records that it ran, without a summary', (t) => {
  const statePath = tempStatePath(t);
  const result = runStandupCheck({ cfg: cfg(), db: null, statePath, now: MONDAY });
  assert.equal(result, null);
  assert.equal(loadStandupState(statePath).lastShownDate, resolveRange('today', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 }).startDate);
});

// --- since_last_working_day: the standup range, in per-day sections ---
//
// The gap this closes: last_working_day showed the previous working day and stopped
// there, so today's own work never appeared. Half a standup.

test('the standup range runs from the last working day through the end of today', () => {
  const opts = { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 };

  const single = resolveRange('last_working_day', opts);
  assert.equal(single.startDate, '2026-08-28', 'the Friday before this Monday');
  assert.equal(single.endDate, '2026-08-28', 'and it stops there, which is the problem');

  const since = resolveRange('since_last_working_day', opts);
  assert.equal(since.startDate, '2026-08-28', 'starts on the same Friday');
  assert.equal(since.endDate, '2026-08-31', 'but runs through today, the Monday');
});

test('from midweek the standup range is just yesterday through today', () => {
  const wednesday = new Date('2026-09-02T12:00:00Z');
  const range = resolveRange('since_last_working_day', { now: wednesday, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  assert.equal(range.startDate, '2026-09-01', 'Tuesday');
  assert.equal(range.endDate, '2026-09-02', 'through Wednesday');
});

test('the standup range respects a non-default weekendDays', () => {
  // A Friday-Saturday weekend, as used across much of the Middle East. On Sunday the
  // last working day is Thursday, not Friday.
  const sunday = new Date('2026-08-30T12:00:00Z');
  const opts = { now: sunday, timeZone: 'UTC', fiscalYearStartMonth: 4, weekendDays: [5, 6] };
  const range = resolveRange('since_last_working_day', opts);
  assert.equal(range.startDate, '2026-08-27', 'the Thursday');
  assert.equal(range.endDate, '2026-08-30', 'through today');
});

test('a resolved range reports the key it came from, and null for explicit dates', () => {
  const opts = { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 };
  assert.equal(resolveRange('since_last_working_day', opts).key, 'since_last_working_day');
  assert.equal(resolveRange('last week', opts).key, 'last_week', 'normalized from the spaced form');
  assert.equal(resolveRange('2026-08-01..2026-08-31', opts).key, null, 'an explicit range has no key');
});

test('dayHeading says Today and Yesterday only when literally true', () => {
  assert.equal(dayHeading('2026-08-31', '2026-08-31'), 'Today');
  assert.equal(dayHeading('2026-08-30', '2026-08-31'), 'Yesterday');
});

test('on a Monday the previous working day is Friday, and must not be called Yesterday', () => {
  // The case that makes a naive two-block "yesterday / today" standup wrong for one
  // day in every five.
  assert.equal(dayHeading('2026-08-28', '2026-08-31'), 'Friday, 28 Aug');
  assert.equal(dayHeading('2026-08-29', '2026-08-31'), 'Saturday, 29 Aug');
});

test('groupByDay buckets oldest first and ignores rows with no attributed date', () => {
  const grouped = groupByDay([
    { effective_date: '2026-08-31', title: 'c' },
    { effective_date: '2026-08-28', title: 'a' },
    { effective_date: '2026-08-31', title: 'd' },
    { effective_date: null, title: 'skipped' },
    { effective_date: '2026-08-29', title: 'b' },
  ]);

  assert.deepEqual(grouped.map((g) => g.date), ['2026-08-28', '2026-08-29', '2026-08-31'],
    'oldest first, the order a standup is spoken in');
  assert.equal(grouped[2].events.length, 2, 'same-day events stay together');
  assert.equal(grouped.flatMap((g) => g.events).length, 4, 'the undated row is dropped, not bucketed under undefined');
});

test('the summary sections each day that has activity, and only those', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    ev({ external_id: 'fri', title: 'Friday work', occurred_at: '2026-08-28T10:00:00.000Z' }),
    ev({ external_id: 'mon', title: 'Monday work', occurred_at: '2026-08-31T10:00:00.000Z' }),
  ]);

  const c = cfg({ range: 'since_last_working_day' });
  const range = resolveRange('since_last_working_day', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const out = formatStandupSummary(db, c, range, MONDAY);

  assert.match(out, /Friday, 28 Aug:/, 'the Friday section, correctly labelled');
  assert.match(out, /Friday work/);
  assert.match(out, /Today:/, "today's own work now appears, which was the entire gap");
  assert.match(out, /Monday work/);

  assert.ok(!out.includes('Saturday'), 'a day with no activity gets no heading');
  assert.ok(!out.includes('Sunday'), 'nor does the rest of the empty weekend');
  assert.ok(!out.includes('Highlights:'), 'sections replace the flat list for this range');
});

test('weekend work gets its own section rather than being quietly dropped', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    ev({ external_id: 'fri', title: 'Friday work', occurred_at: '2026-08-28T10:00:00.000Z' }),
    ev({ external_id: 'sat', title: 'Saturday firefight', occurred_at: '2026-08-29T10:00:00.000Z' }),
  ]);

  const range = resolveRange('since_last_working_day', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const out = formatStandupSummary(db, cfg({ range: 'since_last_working_day' }), range, MONDAY);

  assert.match(out, /Saturday, 29 Aug:/, 'hiding it would contradict the point of an accurate record');
  assert.match(out, /Saturday firefight/);
});

test('last_week keeps the flat aggregate, since thirty day-headings is not a summary', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a', occurred_at: '2026-08-25T10:00:00.000Z' })]);

  const range = resolveRange('last_week', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const out = formatStandupSummary(db, cfg({ range: 'last_week' }), range, MONDAY);

  assert.match(out, /Highlights:/);
  assert.ok(!/^(Today|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,:]/m.test(out),
    'no per-day headings outside the standup range');
});

test('a busy day is capped per-day, so it cannot crowd out the other sections', (t) => {
  const db = tempDb(t);
  const many = Array.from({ length: 9 }, (_, i) => ev({
    external_id: `fri-${i}`, title: `Friday item ${i}`, occurred_at: '2026-08-28T10:00:00.000Z',
  }));
  upsertEvents(db, [...many, ev({ external_id: 'mon', title: 'Monday work', occurred_at: '2026-08-31T10:00:00.000Z' })]);

  const range = resolveRange('since_last_working_day', { now: MONDAY, timeZone: 'UTC', fiscalYearStartMonth: 4 });
  const out = formatStandupSummary(db, cfg({ range: 'since_last_working_day' }), range, MONDAY);

  assert.match(out, /and 4 more/, '9 events, 5 shown');
  assert.match(out, /Today:/, "today must still get its section");
  assert.match(out, /Monday work/, 'and its content, rather than being pushed out by Friday');
});

// D22: every date boundary must be computed in the configured timezone. A test that
// only ever uses UTC proves nothing, because UTC is the one offset where slicing an
// ISO string and converting it properly happen to agree.
test('sections land on the right local day in a timezone well ahead of UTC', (t) => {
  const db = tempDb(t);
  // 22:30 UTC on the Sunday is already 08:00 Monday in Sydney, so this event belongs
  // to Monday's section, not the previous day's.
  upsertEvents(db, [ev({ external_id: 'early-mon', title: 'Monday morning standup prep', occurred_at: '2026-08-30T22:30:00.000Z' })]);

  const c = cfg({ range: 'since_last_working_day' });
  c.timezone = 'Australia/Sydney';
  const opts = { now: new Date('2026-08-31T03:00:00Z'), timeZone: 'Australia/Sydney', fiscalYearStartMonth: 4 };
  const range = resolveRange('since_last_working_day', opts);
  const out = formatStandupSummary(db, c, range, opts.now);

  assert.match(out, /Today:/, 'it is already Monday in Sydney, so this is today');
  assert.match(out, /Monday morning standup prep/);
});
