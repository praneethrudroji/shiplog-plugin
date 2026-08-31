import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvent } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { createDispatcher } from '../mcp/server.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-rpc-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

const cfg = () => ({ ...defaultConfig(), timezone: 'UTC', fiscalYearStartMonth: 4 });

test('initialize echoes the requested protocol version and advertises tools', () => {
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => null });
  const res = dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.serverInfo.name, 'shiplog');
  assert.deepEqual(res.result.capabilities, { tools: {} });
});

test('a notification (no id) produces no response', () => {
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => null });
  assert.equal(dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list returns every declared tool with a schema', () => {
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => null });
  const res = dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(res.result.tools.length >= 5);
  for (const t of res.result.tools) assert.ok(t.inputSchema);
});

test('tools/call reaches the real handler and returns tool content', (t) => {
  const db = tempDb(t);
  upsertEvent(db, {
    source: 'github', event_type: 'pr_opened', external_id: 'a', project: 'octo',
    occurred_at: '2026-08-15T00:00:00.000Z', raw_json: {}, synced_at: '2026-08-31T00:00:00.000Z',
  });
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => db });

  const res = dispatch({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_stats', arguments: { start: '2026-08-01T00:00:00Z', end: '2026-09-01T00:00:00Z' } },
  });
  const parsed = JSON.parse(res.result.content[0].text);
  assert.equal(parsed.total, 1);
});

test('an unknown method returns a JSON-RPC method-not-found error, not a crash', () => {
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => null });
  const res = dispatch({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(res.error.code, -32601);
});

test('ping responds with an empty result', () => {
  const dispatch = createDispatcher({ getCfg: () => cfg(), getDb: () => null });
  assert.deepEqual(dispatch({ jsonrpc: '2.0', id: 5, method: 'ping' }).result, {});
});
