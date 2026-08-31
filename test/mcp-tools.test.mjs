import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvents, setSyncState } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { TOOLS, createToolHandlers, callTool } from '../mcp/tools.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'worklog-mcp-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function cfg(over = {}) {
  return { ...defaultConfig(), timezone: 'UTC', fiscalYearStartMonth: 4, ...over };
}

const ev = (over) => ({
  source: 'github', event_type: 'pr_opened', external_id: `x-${Math.random()}`,
  project: 'octo', title: 'Fix retry logic', occurred_at: '2026-08-15T10:00:00.000Z',
  raw_json: {}, synced_at: '2026-08-31T00:00:00.000Z', ...over,
});

function parse(result) {
  assert.ok(!result.isError, () => `unexpected error result: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

test('every declared tool has a matching handler', () => {
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => null });
  for (const tool of TOOLS) {
    assert.ok(handlers[tool.name], `no handler for declared tool ${tool.name}`);
    assert.ok(tool.inputSchema, `${tool.name} has no inputSchema`);
  }
});

test('resolve_range delegates to the calendar engine using the configured fiscal year', () => {
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => null });
  const result = callTool(handlers, 'resolve_range', { expression: 'this_fy' });
  const range = parse(result);
  assert.equal(range.startDate, new Date().getUTCMonth() + 1 >= 4
    ? `${new Date().getUTCFullYear()}-04-01`
    : `${new Date().getUTCFullYear() - 1}-04-01`);
});

test('resolve_range without configuration returns a clear, catchable error', () => {
  const handlers = createToolHandlers({ cfg: null, getDb: () => null });
  const result = callTool(handlers, 'resolve_range', { expression: 'today' });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /worklog-setup/);
});

test('a query tool before any sync returns a clear error instead of crashing', () => {
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => null });
  const result = callTool(handlers, 'get_stats', { start: '2026-08-01', end: '2026-09-01' });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /worklog-sync/);
});

test('get_stats and query_events work once data exists', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' }), ev({ external_id: 'b', event_type: 'pr_merged' })]);
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => db });

  const stats = parse(callTool(handlers, 'get_stats', { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' }));
  assert.equal(stats.total, 2);

  const events = parse(callTool(handlers, 'query_events', { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' }));
  assert.equal(events.length, 2);
});

test('query_events rejects an unknown source cleanly through the tool boundary', (t) => {
  const db = tempDb(t);
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => db });
  const result = callTool(handlers, 'query_events', {
    start: '2026-08-01', end: '2026-09-01', sources: ["github'; DROP TABLE events; --"],
  });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /unknown source/);
});

test('list_projects works with and without a range', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a', project: 'octo' }), ev({ external_id: 'b', project: 'ledger' })]);
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => db });

  assert.equal(parse(callTool(handlers, 'list_projects', {})).length, 2);
  assert.equal(
    parse(callTool(handlers, 'list_projects', { start: '2026-01-01', end: '2026-01-02' })).length,
    0,
  );
});

test('get_sync_health reports enabled-but-never-synced sources', (t) => {
  const db = tempDb(t);
  setSyncState(db, 'github', { cursor: '2026-08-31T00:00:00Z', status: 'ok' });
  const c = cfg();
  c.sources.github.enabled = true;
  c.sources.jira.enabled = true;
  const handlers = createToolHandlers({ cfg: c, getDb: () => db });

  const health = parse(callTool(handlers, 'get_sync_health', {}));
  assert.deepEqual(health.neverSynced, ['jira']);
  assert.equal(health.sources.github.last_status, 'ok');
});

test('get_sync_health before any sync reports zero data without erroring', () => {
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => null });
  const health = parse(callTool(handlers, 'get_sync_health', {}));
  assert.equal(health.pendingEnrichment, 0);
  assert.equal(health.coverageStart, null);
});

test('resolve_range for "all_time" reaches the database for a coverage start', (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a', occurred_at: '2026-03-01T00:00:00.000Z' })]);
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => db });
  const range = parse(callTool(handlers, 'resolve_range', { expression: 'all_time' }));
  assert.equal(range.startDate, '2026-03-01');
});

test('calling an unknown tool name fails cleanly rather than throwing', () => {
  const handlers = createToolHandlers({ cfg: cfg(), getDb: () => null });
  const result = callTool(handlers, 'delete_everything', {});
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /unknown tool/);
});
