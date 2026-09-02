import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvents, getStats, queryEvents, listProjects, getSyncHealth, setSyncState } from '../lib/db.mjs';
import { resolveRange } from '../lib/ranges.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-queries-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const ev = (over) => ({
  source: 'github', event_type: 'pr_opened', external_id: `x-${Math.random()}`,
  project: 'octo', title: 't', body: null, occurred_at: '2026-08-15T10:00:00.000Z',
  raw_json: {}, synced_at: '2026-08-31T00:00:00.000Z', ...over,
});

function seed(db) {
  upsertEvents(db, [
    ev({ external_id: 'a', event_type: 'pr_opened', source: 'github', project: 'octo', occurred_at: '2026-08-10T09:00:00.000Z' }),
    ev({ external_id: 'b', event_type: 'pr_merged', source: 'github', project: 'octo', occurred_at: '2026-08-12T09:00:00.000Z' }),
    ev({ external_id: 'c', event_type: 'ticket_comment', source: 'jira', project: 'PROJ', occurred_at: '2026-07-01T09:00:00.000Z' }),
    ev({ external_id: 'd', event_type: 'pr_opened', source: 'azure_devops', project: 'Payments', occurred_at: '2026-08-20T09:00:00.000Z' }),
  ]);
  // An event whose comment was attributed to a different day than it was posted.
  const id = db.prepare("SELECT id FROM events WHERE external_id = 'a'").get().id;
  db.prepare("UPDATE events SET effective_at = '2026-08-09' WHERE id = ?").run(id);
}

const RANGE = { start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' };

test('getStats groups by event_type and totals correctly', (t) => {
  const db = tempDb(t);
  seed(db);
  const stats = getStats(db, { ...RANGE, groupBy: 'event_type' });
  assert.equal(stats.total, 3, 'the July jira comment is out of range');
  const byKey = Object.fromEntries(stats.byKey.map((r) => [r.key, r.count]));
  assert.deepEqual(byKey, { pr_opened: 2, pr_merged: 1 });
});

test('getStats groups by source and by project', (t) => {
  const db = tempDb(t);
  seed(db);
  const bySource = getStats(db, { ...RANGE, groupBy: 'source' });
  assert.deepEqual(
    Object.fromEntries(bySource.byKey.map((r) => [r.key, r.count])),
    { github: 2, azure_devops: 1 },
  );
  const byProject = getStats(db, { ...RANGE, groupBy: 'project' });
  assert.deepEqual(
    Object.fromEntries(byProject.byKey.map((r) => [r.key, r.count])),
    { octo: 2, Payments: 1 },
  );
});

test('getStats uses the effective date, not the occurred date, for filtering', (t) => {
  const db = tempDb(t);
  seed(db);
  // Event 'a' is attributed to 2026-08-09, so a range starting the 10th should exclude it.
  const stats = getStats(db, { start: '2026-08-10T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z', groupBy: 'event_type' });
  assert.equal(stats.total, 2);
});

test('getStats rejects an unknown groupBy rather than silently interpolating it', (t) => {
  const db = tempDb(t);
  assert.throws(() => getStats(db, { ...RANGE, groupBy: 'DROP TABLE events; --' }), /unknown groupBy/);
});

test('queryEvents filters by source, event type, and project', (t) => {
  const db = tempDb(t);
  seed(db);
  assert.equal(queryEvents(db, { ...RANGE, sources: ['github'] }).length, 2);
  assert.equal(queryEvents(db, { ...RANGE, eventTypes: ['pr_merged'] }).length, 1);
  assert.equal(queryEvents(db, { ...RANGE, project: 'Payments' }).length, 1);
});

test('queryEvents rejects unknown source/event_type values instead of building bad SQL', (t) => {
  const db = tempDb(t);
  assert.throws(() => queryEvents(db, { ...RANGE, sources: ["github'; DROP TABLE events; --"] }), /unknown source/);
  assert.throws(() => queryEvents(db, { ...RANGE, eventTypes: ['not_a_type'] }), /unknown event_type/);
});

test('queryEvents text search matches title or body', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    ev({ external_id: 'x', title: 'Fix the settlement rounding bug', occurred_at: '2026-08-05T00:00:00Z' }),
    ev({ external_id: 'y', title: 'Unrelated', body: 'mentions settlement in passing', occurred_at: '2026-08-06T00:00:00Z' }),
    ev({ external_id: 'z', title: 'Nothing to do with it', occurred_at: '2026-08-07T00:00:00Z' }),
  ]);
  const rows = queryEvents(db, { ...RANGE, textSearch: 'settlement' });
  assert.equal(rows.length, 2);
});

test('queryEvents caps the limit and returns newest first', (t) => {
  const db = tempDb(t);
  upsertEvents(db, Array.from({ length: 10 }, (_, i) => ev({
    external_id: `n${i}`, occurred_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
  })));
  const rows = queryEvents(db, { ...RANGE, limit: 3 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].effective_date, '2026-08-10');

  const overCap = queryEvents(db, { ...RANGE, limit: 999999 });
  assert.ok(overCap.length <= 2000);
});

test('queryEvents surfaces both occurred_at and effective_at for auditability', (t) => {
  const db = tempDb(t);
  seed(db);
  const row = queryEvents(db, { ...RANGE, sources: ['github'], eventTypes: ['pr_opened'] })[0];
  assert.equal(row.occurred_at, '2026-08-10T09:00:00.000Z');
  assert.equal(row.effective_at, '2026-08-09');
  assert.equal(row.effective_date, '2026-08-09', 'the coalesced date used for filtering');
});

test('listProjects aggregates across all data with no range given', (t) => {
  const db = tempDb(t);
  seed(db);
  const rows = listProjects(db);
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.project, r.count])),
    { octo: 2, PROJ: 1, Payments: 1 },
  );
});

test('listProjects respects a range when given', (t) => {
  const db = tempDb(t);
  seed(db);
  const rows = listProjects(db, RANGE);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.project, r.count])), { octo: 2, Payments: 1 });
});

test('getSyncHealth reports every known source, synced or not', (t) => {
  const db = tempDb(t);
  setSyncState(db, 'github', { cursor: '2026-08-31T00:00:00Z', status: 'ok' });
  seed(db);

  const health = getSyncHealth(db);
  assert.equal(health.sources.github.last_status, 'ok');
  assert.equal(health.sources.jira, null, 'never synced, but still present as a known source');
  assert.equal(health.sources.azure_devops, null);
  assert.equal(health.pendingEnrichment, 0);
  assert.equal(health.coverageStart, '2026-07-01');
});

test('getSyncHealth counts the attribution backlog', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    ev({ external_id: 'p1', needs_enrichment: 1 }),
    ev({ external_id: 'p2', needs_enrichment: 1 }),
    ev({ external_id: 'p3', needs_enrichment: 0 }),
  ]);
  assert.equal(getSyncHealth(db).pendingEnrichment, 2);
});

// Regression: found live, running the plugin against a real IST account. A range
// ending "today" has an exclusive `end` that is local midnight of *tomorrow* —
// but for any positive UTC offset, that instant's own UTC calendar date is still
// today. Slicing the raw instant string recovered today's date as the exclusive
// bound, silently excluding today's own events from every query. This only
// reproduces with a real timezone conversion in play, so these tests go through
// resolveRange exactly as the MCP tools do, rather than hand-building boundaries.

test("an event effective today is included in a range ending today, in a timezone ahead of UTC", (t) => {
  const db = tempDb(t);
  // 2026-09-01T12:00:00Z is 17:30 IST — solidly "today" in Kolkata, matching the
  // live case (IST, UTC+5:30).
  const now = new Date('2026-09-01T12:00:00Z');
  upsertEvents(db, [ev({ external_id: 'today-event', occurred_at: '2026-09-01T09:00:00Z' })]);

  const range = resolveRange('today', { now, timeZone: 'Asia/Kolkata', fiscalYearStartMonth: 4 });
  const stats = getStats(db, { start: range.start, end: range.end, timezone: 'Asia/Kolkata' });
  assert.equal(stats.total, 1, 'the event happened today in IST and must be counted');

  const rows = queryEvents(db, { start: range.start, end: range.end, timezone: 'Asia/Kolkata' });
  assert.equal(rows.length, 1);
});

test('the same case with timezone left at the UTC default reproduces the original bug', (t) => {
  // Documents why the fix has to be the timezone conversion, not just "use
  // resolveRange's boundaries" — passing the *correct* boundaries with the *wrong*
  // (default) timezone for interpreting them still drops the event, because the
  // instant genuinely is ambiguous without knowing which zone it's local-midnight in.
  const db = tempDb(t);
  const now = new Date('2026-09-01T12:00:00Z');
  upsertEvents(db, [ev({ external_id: 'today-event', occurred_at: '2026-09-01T09:00:00Z' })]);

  const range = resolveRange('today', { now, timeZone: 'Asia/Kolkata', fiscalYearStartMonth: 4 });
  const stats = getStats(db, { start: range.start, end: range.end }); // timezone defaults to UTC
  assert.equal(stats.total, 0, 'without the real timezone, the end bound is misread as excluding today');
});

test('last_4_weeks in IST includes an event from earlier today', (t) => {
  // The exact scenario that surfaced this: a plain "last 4 weeks" query, in the
  // afternoon IST, missing same-day activity.
  const db = tempDb(t);
  const now = new Date('2026-09-01T17:18:08Z'); // matches the real timestamp this bug was found at
  upsertEvents(db, [
    ev({ external_id: 'opened', event_type: 'pr_opened', occurred_at: '2026-09-01T17:13:31Z' }),
    ev({ external_id: 'merged', event_type: 'pr_merged', occurred_at: '2026-09-01T17:13:58Z' }),
    ev({ external_id: 'commented', event_type: 'pr_comment', occurred_at: '2026-09-01T17:13:54Z' }),
  ]);

  const range = resolveRange('last_4_weeks', { now, timeZone: 'Asia/Kolkata', fiscalYearStartMonth: 4 });
  const stats = getStats(db, { start: range.start, end: range.end, timezone: 'Asia/Kolkata' });
  assert.equal(stats.total, 3, 'all three of today\'s events must be counted, not just the attributed one');
});

test('a UTC-behind timezone (e.g. US Eastern) was never affected, and stays correct', (t) => {
  const db = tempDb(t);
  const now = new Date('2026-09-01T22:00:00Z'); // 18:00 Eastern (EDT, UTC-4) — still "today" there
  upsertEvents(db, [ev({ external_id: 'today-event', occurred_at: '2026-09-01T21:00:00Z' })]);

  const range = resolveRange('today', { now, timeZone: 'America/New_York', fiscalYearStartMonth: 4 });
  const stats = getStats(db, { start: range.start, end: range.end, timezone: 'America/New_York' });
  assert.equal(stats.total, 1);
});

test('listProjects respects timezone the same way', (t) => {
  const db = tempDb(t);
  const now = new Date('2026-09-01T12:00:00Z');
  upsertEvents(db, [ev({ external_id: 'today-event', project: 'octo', occurred_at: '2026-09-01T09:00:00Z' })]);

  const range = resolveRange('today', { now, timeZone: 'Asia/Kolkata', fiscalYearStartMonth: 4 });
  const rows = listProjects(db, { start: range.start, end: range.end, timezone: 'Asia/Kolkata' });
  assert.deepEqual(rows.map((r) => r.project), ['octo']);
});

test('a bare YYYY-MM-DD boundary is treated as an already-local date, not re-converted', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'x', occurred_at: '2026-08-15T09:00:00Z' })]);
  // A bare date must mean exactly that date regardless of timezone, since it carries
  // no time component to convert.
  const stats = getStats(db, { start: '2026-08-01', end: '2026-09-01', timezone: 'Asia/Kolkata' });
  assert.equal(stats.total, 1);
});
