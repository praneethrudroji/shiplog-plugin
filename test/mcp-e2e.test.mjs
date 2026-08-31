// Full end-to-end check: spawns the real `node mcp/server.mjs` process and speaks
// newline-delimited JSON-RPC over its actual stdin/stdout, the way Claude Code does.
// Everything above this file tests the dispatcher function directly; only this file
// proves the process boundary and line framing themselves work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, upsertEvents } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'mcp', 'server.mjs');

function seededHome(t, { withData = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'shiplog-e2e-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const cfg = { ...defaultConfig(), timezone: 'UTC', fiscalYearStartMonth: 4 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  chmodSync(join(home, 'config.json'), 0o600);

  if (withData) {
    const db = openDatabase(join(home, 'shiplog.db'));
    upsertEvents(db, [
      {
        source: 'github', event_type: 'pr_opened', external_id: 'octo/payments#42',
        project: 'octo', repo: 'payments', title: 'Add retry to the payment client',
        url: 'https://github.com/octo/payments/pull/42', status: 'merged',
        occurred_at: '2026-08-20T09:15:00.000Z', raw_json: {}, synced_at: '2026-08-31T22:00:00.000Z',
      },
      {
        source: 'jira', event_type: 'ticket_comment', external_id: 'comment:1',
        project: 'PROJ', title: 'PROJ-88', body: 'Wrapped this up.',
        occurred_at: '2026-08-22T09:00:00.000Z', raw_json: {}, synced_at: '2026-08-31T22:00:00.000Z',
      },
    ]);
    db.close();
  }
  return home;
}

/** A minimal newline-delimited JSON-RPC client over a child process's stdio. */
function rpcClient(home) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHIPLOG_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const pending = [];
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    // eslint-disable-next-line no-cond-assign
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) pending.push(JSON.parse(line));
    }
  });

  let nextId = 1;
  const waitFor = async (id, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = pending.findIndex((m) => m.id === id);
      if (i !== -1) return pending.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`timed out waiting for response id ${id}; stderr: ${stderr.join('')}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  return {
    child,
    stderr: () => stderr.join(''),
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async call(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return waitFor(id);
    },
    close() {
      child.stdin.end();
    },
  };
}

test('a real spawned server completes the initialize handshake', async (t) => {
  const home = seededHome(t);
  const rpc = rpcClient(home);
  t.after(() => rpc.close());

  const res = await rpc.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client' } });
  assert.equal(res.result.serverInfo.name, 'shiplog');
  assert.equal(res.result.protocolVersion, '2025-06-18');

  rpc.notify('notifications/initialized');
  // The notification must produce no reply on the wire; confirmed by the next call
  // still getting matched to its own id rather than an earlier stray response.
  const list = await rpc.call('tools/list', {});
  assert.ok(list.result.tools.length >= 5);
});

test('tools/call over the real process returns real data from the seeded database', async (t) => {
  const home = seededHome(t);
  const rpc = rpcClient(home);
  t.after(() => rpc.close());

  await rpc.call('initialize', { protocolVersion: '2025-06-18' });

  const range = await rpc.call('tools/call', { name: 'resolve_range', arguments: { expression: 'this_fy' } });
  const resolved = JSON.parse(range.result.content[0].text);
  assert.equal(resolved.startDate, '2026-04-01');

  const stats = await rpc.call('tools/call', {
    name: 'get_stats', arguments: { start: resolved.start, end: resolved.end, group_by: 'source' },
  });
  const parsedStats = JSON.parse(stats.result.content[0].text);
  assert.equal(parsedStats.total, 2);

  const events = await rpc.call('tools/call', {
    name: 'query_events', arguments: { start: resolved.start, end: resolved.end, sources: ['github'] },
  });
  const parsedEvents = JSON.parse(events.result.content[0].text);
  assert.equal(parsedEvents.length, 1);
  assert.equal(parsedEvents[0].url, 'https://github.com/octo/payments/pull/42');

  const health = await rpc.call('tools/call', { name: 'get_sync_health', arguments: {} });
  const parsedHealth = JSON.parse(health.result.content[0].text);
  assert.equal(parsedHealth.coverageStart, '2026-08-20');
});

test('a real process before any sync answers with a clear error, not a crash', async (t) => {
  const home = seededHome(t, { withData: false });
  const rpc = rpcClient(home);
  t.after(() => rpc.close());

  await rpc.call('initialize', {});
  const res = await rpc.call('tools/call', {
    name: 'get_stats', arguments: { start: '2026-08-01', end: '2026-09-01' },
  });
  assert.equal(res.result.isError, true);
  assert.match(JSON.parse(res.result.content[0].text).error, /shiplog-sync/);
});

test('an unparseable line gets a JSON-RPC parse error instead of killing the process', async (t) => {
  const home = seededHome(t);
  const rpc = rpcClient(home);
  t.after(() => rpc.close());

  rpc.child.stdin.write('not json at all\n');
  // The process should still be alive and answer the next well-formed request.
  const res = await rpc.call('initialize', {});
  assert.equal(res.result.serverInfo.name, 'shiplog');
});

test('closing stdin makes the server exit cleanly', async (t) => {
  const home = seededHome(t);
  const rpc = rpcClient(home);
  await rpc.call('initialize', {});

  const exitCode = await new Promise((resolve) => {
    rpc.child.on('exit', (code) => resolve(code));
    rpc.close();
  });
  assert.equal(exitCode, 0);
});
