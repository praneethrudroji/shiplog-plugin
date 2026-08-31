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
