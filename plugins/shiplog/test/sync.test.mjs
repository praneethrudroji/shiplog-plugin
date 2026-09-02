import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runSync } from '../bin/sync.mjs';
import { openDatabase, getSyncState, upsertEvent } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { createHttpClient } from '../lib/http.mjs';
import * as fx from './fixtures/github.mjs';

const NOW = new Date('2026-08-31T22:00:00.000Z');

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-sync-'));
  const db = openDatabase(join(dir, 'shiplog.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function config() {
  const cfg = defaultConfig();
  cfg.timezone = 'UTC';
  cfg.identity = { githubLogin: 'janedoe' };
  cfg.sources.github = { ...cfg.sources.github, enabled: true, tokenEnv: 'T' };
  // Off by default here: enrichPending's default `runClaude` is the real CLI, and
  // these tests must never make a live call. The dedicated enrichment-wiring test
  // below re-enables it with an injected fake.
  cfg.enrich = { ...cfg.enrich, enabled: false };
  return cfg;
}

function http(routes) {
  return createHttpClient({
    fetcher: async (url) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`no route for ${url}`);
      const value = routes[key];
      if (value instanceof Error) throw value;
      if (typeof value === 'number') {
        return { status: value, ok: false, headers: { get: () => null }, text: async () => 'failure' };
      }
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(value) };
    },
  });
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const EMPTY = { 'q=author': { items: [] }, 'q=commenter': { items: [] }, 'q=reviewed-by': { items: [] } };
const args = (over = {}) => ({ dryRun: false, source: null, since: null, noEnrich: false, ...over });

test('flags parse, and an unknown flag is rejected', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--source', 'github', '--since', '2026-01-01']), {
    dryRun: true, source: 'github', since: '2026-01-01', noEnrich: false,
  });
  assert.throws(() => parseArgs(['--wat']), /unknown flag: --wat/);
});

test('a successful sync writes events and advances the watermark', async (t) => {
  const db = tempDb(t);
  const { results, exitCode } = await runSync({
    args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  });

  assert.equal(exitCode, 0);
  assert.equal(results[0].upserted, 2, 'pr_opened and pr_merged');
  assert.equal(getSyncState(db, 'github').last_cursor, NOW.toISOString());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
});

test('a dry run fetches but writes nothing', async (t) => {
  const db = tempDb(t);
  const { results, exitCode } = await runSync({
    args: args({ dryRun: true }), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  });

  assert.equal(exitCode, 0);
  assert.equal(results[0].fetched, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  assert.equal(getSyncState(db, 'github'), null, 'no watermark on a dry run');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n, 0, 'no audit row either');
});

test('a failing source records the error without advancing the watermark', async (t) => {
  const db = tempDb(t);
  const { results, exitCode } = await runSync({
    args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ 'q=author': 401 }),
  });

  assert.equal(exitCode, 1, 'the only source failed');
  assert.equal(results[0].status, 'error');
  assert.match(results[0].error, /check the token and its scopes/);

  const state = getSyncState(db, 'github');
  assert.equal(state.last_status, 'error');
  assert.equal(state.last_cursor, null, 'the missed window must be retried next run');
});

test('a partial failure exits 2 and does not block the healthy source', async (t) => {
  const db = tempDb(t);
  const cfg = config();
  cfg.sources.jira.enabled = true;   // not implemented yet, so it reports an error

  const { results, exitCode } = await runSync({
    args: args(), cfg, secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  });

  assert.equal(exitCode, 2);
  assert.equal(results.find((r) => r.source === 'github').status, 'ok');
  assert.equal(results.find((r) => r.source === 'jira').status, 'error');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2, "github's events still landed");
});

test('re-running the sync is idempotent', async (t) => {
  const db = tempDb(t);
  const run = () => runSync({
    args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  });

  await run();
  const first = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  await run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, first);
});

test('a recorded attribution survives a re-sync through the full pipeline', async (t) => {
  const db = tempDb(t);
  const opts = {
    args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  };

  await runSync(opts);
  const pr = db.prepare("SELECT * FROM events WHERE event_type = 'pr_opened'").get();
  assert.equal(pr.needs_enrichment, 1, 'the PR body says "Yesterday I finished..."');

  db.prepare("UPDATE events SET effective_at = '2026-08-19', effective_source = 'llm', needs_enrichment = 0 WHERE id = ?")
    .run(pr.id);

  await runSync(opts);
  const after = db.prepare('SELECT * FROM events WHERE id = ?').get(pr.id);
  assert.equal(after.effective_at, '2026-08-19');
  assert.equal(after.needs_enrichment, 0);
});

test('--since overrides the computed window', async (t) => {
  const db = tempDb(t);
  let seen = null;
  await runSync({
    args: args({ since: '2026-06-01' }), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: createHttpClient({
      fetcher: async (url) => {
        if (!seen) seen = decodeURIComponent(url);
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"items":[]}' };
      },
    }),
  });
  assert.match(seen, /updated:>=2026-06-01/);
});

test('--source limits the run to one source', async (t) => {
  const db = tempDb(t);
  const cfg = config();
  cfg.sources.jira.enabled = true;

  const { results } = await runSync({
    args: args({ source: 'github' }), cfg, secrets: { T: 'token' }, db, log: silent, now: NOW, http: http(EMPTY),
  });
  assert.deepEqual(results.map((r) => r.source), ['github']);
});

test('with no sources enabled the run succeeds quietly', async (t) => {
  const db = tempDb(t);
  const cfg = defaultConfig();
  const { results, exitCode } = await runSync({
    args: args(), cfg, secrets: {}, db, log: silent, now: NOW, http: http({}),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(results, []);
});

test('every run is recorded in the audit log', async (t) => {
  const db = tempDb(t);
  await runSync({
    args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
  });

  const run = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(run.source, 'github');
  assert.equal(run.status, 'ok');
  assert.equal(run.events_upserted, 2);
  assert.ok(run.finished_at);
});

test('the second run asks only for the incremental window', async (t) => {
  const db = tempDb(t);
  upsertEvent(db, {
    source: 'github', event_type: 'pr_opened', external_id: 'seed',
    occurred_at: '2026-08-01T00:00:00.000Z', raw_json: {}, synced_at: NOW.toISOString(),
  });

  const urls = [];
  const capture = createHttpClient({
    fetcher: async (url) => {
      urls.push(decodeURIComponent(url));
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"items":[]}' };
    },
  });

  const opts = { args: args(), cfg: config(), secrets: { T: 'token' }, db, log: silent, now: NOW, http: capture };
  await runSync(opts);
  urls.length = 0;
  // 48h lookback from the previous cursor, not a full backfill.
  await runSync({ ...opts, now: new Date('2026-09-01T22:00:00.000Z') });
  assert.match(urls[0], /updated:>=2026-08-29/);
});

test('enrichment runs after ingestion and resolves the freshly-synced backlog', async (t) => {
  const db = tempDb(t);
  const cfg = config();
  cfg.enrich = { ...cfg.enrich, enabled: true };
  let calls = 0;

  const { enrichment } = await runSync({
    args: args(), cfg, secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
    runClaude: async ({ prompt }) => {
      calls += 1;
      const [{ event_id }] = JSON.parse(prompt.match(/Comments:\n([\s\S]*)$/)[1]);
      return JSON.stringify([{ event_id, effective_date: '2026-08-19', confidence: 0.9 }]);
    },
  });

  assert.equal(calls, 1);
  assert.equal(enrichment.resolved, 1, "the PR body's \"Yesterday I finished...\" should resolve");
  const row = db.prepare("SELECT * FROM events WHERE event_type = 'pr_opened'").get();
  assert.equal(row.effective_at, '2026-08-19');
});

test('enrichment is skipped on a dry run and with --no-enrich', async (t) => {
  const cfg = config();
  cfg.enrich = { ...cfg.enrich, enabled: true };
  const failIfCalled = async () => { throw new Error('must not be called'); };

  const db1 = tempDb(t);
  const dry = await runSync({
    args: args({ dryRun: true }), cfg, secrets: { T: 'token' }, db: db1, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }), runClaude: failIfCalled,
  });
  assert.equal(dry.enrichment, null);

  const db2 = tempDb(t);
  const skipped = await runSync({
    args: args({ noEnrich: true }), cfg, secrets: { T: 'token' }, db: db2, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }), runClaude: failIfCalled,
  });
  assert.equal(skipped.enrichment, null);
});

test('an enrichment failure does not affect the sync exit code', async (t) => {
  const db = tempDb(t);
  const cfg = config();
  cfg.enrich = { ...cfg.enrich, enabled: true };

  const { exitCode, enrichment } = await runSync({
    args: args(), cfg, secrets: { T: 'token' }, db, log: silent, now: NOW,
    http: http({ ...EMPTY, 'q=author': { items: [fx.authoredPr] } }),
    runClaude: async () => { throw new Error('model unavailable'); },
  });

  assert.equal(exitCode, 0, "ingestion succeeded; enrichment's failure is a separate, non-fatal concern");
  assert.match(enrichment.error, /model unavailable/);
});
