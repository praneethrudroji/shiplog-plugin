import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase, upsertEvent, upsertEvents, setAttribution,
  pendingEnrichment, getSyncState, setSyncState, startRun, finishRun, coverageStart,
} from '../lib/db.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const sample = (over = {}) => ({
  source: 'github',
  event_type: 'pr_opened',
  external_id: 'octo/repo#42',
  project: 'octo',
  repo: 'repo',
  title: 'Add retry to the payment client',
  body: 'Yesterday I finished the retry logic.',
  url: 'https://github.com/octo/repo/pull/42',
  status: 'open',
  occurred_at: '2026-08-31T09:00:00.000Z',
  updated_at: '2026-08-31T09:00:00.000Z',
  raw_json: { number: 42 },
  synced_at: '2026-08-31T22:00:00.000Z',
  needs_enrichment: 1,
  ...over,
});

const countEvents = (db) => db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
const getEvent = (db) => db.prepare('SELECT * FROM events LIMIT 1').get();

test('schema applies and sets user_version', (t) => {
  const db = tempDb(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(countEvents(db), 0);
});

test('re-syncing the same event does not duplicate it', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample());
  upsertEvent(db, sample());
  upsertEvent(db, sample());
  assert.equal(countEvents(db), 1);
});

test('re-syncing updates mutable fields', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample());
  upsertEvent(db, sample({ status: 'merged', title: 'Add retry (merged)' }));
  const row = getEvent(db);
  assert.equal(row.status, 'merged');
  assert.equal(row.title, 'Add retry (merged)');
  assert.equal(countEvents(db), 1);
});

test('a resolved attribution survives a later re-sync', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample());
  const { id } = getEvent(db);
  setAttribution(db, id, {
    effective_at: '2026-08-30', precision: 'day', confidence: 0.9,
    source: 'llm', reasoning: '"Yesterday" relative to a 31 Aug comment',
  });

  upsertEvent(db, sample({ status: 'merged' }));   // the nightly re-pull

  const row = getEvent(db);
  assert.equal(row.effective_at, '2026-08-30', 'attribution must not be clobbered');
  assert.equal(row.effective_source, 'llm');
  assert.equal(row.status, 'merged', 'but mutable fields still update');
  assert.equal(row.needs_enrichment, 0);
});

test('changed comment text re-opens enrichment, unchanged text does not', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample());
  const { id } = getEvent(db);
  setAttribution(db, id, { effective_at: '2026-08-30', source: 'llm', confidence: 0.9 });

  upsertEvent(db, sample());
  assert.equal(getEvent(db).needs_enrichment, 0, 'identical body should stay resolved');

  upsertEvent(db, sample({ body: 'Actually I finished this last Friday.' }));
  assert.equal(getEvent(db).needs_enrichment, 1, 'edited body should be re-examined');
});

test('a manual attribution is never re-opened, even if the text changes', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample());
  const { id } = getEvent(db);
  setAttribution(db, id, { effective_at: '2026-08-28', source: 'manual', confidence: 1 });

  upsertEvent(db, sample({ body: 'Rewritten comment mentioning last Tuesday.' }));

  const row = getEvent(db);
  assert.equal(row.needs_enrichment, 0, 'a human ruling outranks the extractor');
  assert.equal(row.effective_at, '2026-08-28');
});

test('the enrichment backlog only returns flagged rows', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [
    sample({ external_id: 'a', needs_enrichment: 1 }),
    sample({ external_id: 'b', needs_enrichment: 0 }),
    sample({ external_id: 'c', needs_enrichment: 1 }),
  ]);
  assert.equal(pendingEnrichment(db).length, 2);

  const first = pendingEnrichment(db)[0];
  setAttribution(db, first.id, { effective_at: '2026-08-30', source: 'llm' });
  assert.equal(pendingEnrichment(db).length, 1);
});

test('a batch upsert is atomic, one bad row rolls back the whole batch', (t) => {
  const db = tempDb(t);
  upsertEvent(db, sample({ external_id: 'existing' }));
  assert.throws(() => upsertEvents(db, [
    sample({ external_id: 'good-1' }),
    sample({ external_id: 'bad', event_type: 'not_a_real_type' }),
    sample({ external_id: 'good-2' }),
  ]));
  assert.equal(countEvents(db), 1, 'partial batch must not land');
});

test('invalid enum values are rejected by the schema', (t) => {
  const db = tempDb(t);
  assert.throws(() => upsertEvent(db, sample({ source: 'gitlab' })), /CHECK/i);
  assert.throws(() => upsertEvent(db, sample({ event_type: 'deployed_maybe' })), /CHECK/i);
});

test('a failed sync does not advance the watermark', (t) => {
  const db = tempDb(t);
  setSyncState(db, 'github', { cursor: '2026-08-01T00:00:00Z', status: 'ok' });
  setSyncState(db, 'github', { cursor: '2026-08-31T00:00:00Z', status: 'error', error: '403 rate limited' });

  const state = getSyncState(db, 'github');
  assert.equal(state.last_cursor, '2026-08-01T00:00:00Z', 'cursor must not move on failure');
  assert.equal(state.last_status, 'error');
  assert.equal(state.last_error, '403 rate limited');
});

test('a successful sync after a failure does advance the watermark', (t) => {
  const db = tempDb(t);
  setSyncState(db, 'github', { cursor: '2026-08-01T00:00:00Z', status: 'ok' });
  setSyncState(db, 'github', { cursor: '2026-08-15T00:00:00Z', status: 'error', error: 'boom' });
  setSyncState(db, 'github', { cursor: '2026-08-31T00:00:00Z', status: 'ok' });

  const state = getSyncState(db, 'github');
  assert.equal(state.last_cursor, '2026-08-31T00:00:00Z');
  assert.equal(state.last_status, 'ok');
});

test('sync runs are recorded for the status command', (t) => {
  const db = tempDb(t);
  const id = startRun(db, 'jira');
  finishRun(db, id, { upserted: 12, status: 'ok' });

  const run = db.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id);
  assert.equal(run.source, 'jira');
  assert.equal(run.events_upserted, 12);
  assert.equal(run.status, 'ok');
  assert.ok(run.finished_at);
});

test('coverage start reports the earliest attributed day', (t) => {
  const db = tempDb(t);
  assert.equal(coverageStart(db), null);
  upsertEvents(db, [
    sample({ external_id: 'x', occurred_at: '2026-06-15T10:00:00.000Z' }),
    sample({ external_id: 'y', occurred_at: '2026-03-02T10:00:00.000Z' }),
  ]);
  assert.equal(coverageStart(db), '2026-03-02');
});

test('a read-only handle cannot write', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-ro-'));
  const path = join(dir, 'ro.db');
  const rw = openDatabase(path);
  upsertEvent(rw, sample());
  rw.close();

  const ro = openDatabase(path, { readOnly: true });
  t.after(() => { ro.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.equal(ro.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
  assert.throws(() => upsertEvent(ro, sample({ external_id: 'nope' })), /readonly/i);
});
