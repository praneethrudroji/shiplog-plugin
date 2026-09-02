#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, createWriteStream, chmodSync } from 'node:fs';
import { loadConfig, loadSecrets, resolveToken, enabledSources, syncWindowStart, paths } from '../lib/config.mjs';
import { openDatabase, upsertEvents, getSyncState, setSyncState, startRun, finishRun } from '../lib/db.mjs';
import { createHttpClient, AuthError } from '../lib/http.mjs';
import { createLogger } from '../lib/redact.mjs';
import { snapshot, prune } from '../lib/backup.mjs';
import { fetchGitHubEvents } from '../lib/sources/github.mjs';
import { fetchAzureDevOpsEvents } from '../lib/sources/azure-devops.mjs';
import { enrichPending } from '../lib/temporal/enrich.mjs';

const FETCHERS = { github: fetchGitHubEvents, azure_devops: fetchAzureDevOpsEvents };
const LOCK_STALE_MS = 60 * 60_000;

export function parseArgs(argv) {
  const args = { dryRun: false, source: null, since: null, noEnrich: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-enrich') args.noEnrich = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

const USAGE = `shiplog sync - collect your activity into the local database

  --source <name>     only sync one source (github, azure_devops, jira)
  --since <date>      override the window start (YYYY-MM-DD or ISO instant)
  --dry-run           fetch and normalize, but write nothing
  --no-enrich         skip the date-attribution stage
  -h, --help          show this message

Exit codes: 0 all sources succeeded, 2 some failed, 1 all failed.`;

/** Refuses to run concurrently; a lock older than an hour is assumed abandoned. */
function acquireLock(lockPath, log) {
  if (existsSync(lockPath)) {
    let age = Infinity;
    try {
      age = Date.now() - Date.parse(JSON.parse(readFileSync(lockPath, 'utf8')).at);
    } catch { /* an unreadable lock is treated as stale */ }

    if (age < LOCK_STALE_MS) {
      throw new Error(`another sync is running (lock at ${lockPath}); remove it if that is wrong`);
    }
    log.warn(`breaking a stale lock, ${Math.round(age / 60_000)} minutes old`);
    rmSync(lockPath, { force: true });
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  return () => rmSync(lockPath, { force: true });
}

function normalizeSince(value) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : new Date(value).toISOString();
}

export async function runSync({ args, cfg, secrets, db, log, http, now = new Date(), runClaude }) {
  const sources = args.source ? [args.source] : enabledSources(cfg);
  if (!sources.length) {
    log.warn('no sources are enabled - run /shiplog-setup');
    return { results: [], exitCode: 0 };
  }

  const results = [];
  for (const source of sources) {
    const fetcher = FETCHERS[source];
    if (!fetcher) {
      results.push({ source, status: 'error', error: 'source not implemented yet', upserted: 0 });
      continue;
    }

    const runId = args.dryRun ? null : startRun(db, source);
    const state = getSyncState(db, source);
    const since = normalizeSince(args.since) ?? syncWindowStart(cfg, state?.last_cursor, now);
    log.info(`${source}: syncing since ${since}`);

    try {
      const token = resolveToken(cfg, source, secrets);
      const { events, cursor } = await fetcher({ cfg, token, http, since, now, log: (m) => log.info(m) });

      let upserted = 0;
      if (args.dryRun) {
        log.info(`${source}: would upsert ${events.length} events (dry run)`);
      } else {
        upserted = upsertEvents(db, events);
        setSyncState(db, source, { cursor, status: 'ok' });
        finishRun(db, runId, { upserted, status: 'ok' });
      }
      log.info(`${source}: ${events.length} events, ${upserted} written`);
      results.push({ source, status: 'ok', upserted, fetched: events.length });
    } catch (err) {
      // One source failing must not stop the others, and must not advance its
      // watermark - the window it missed has to be retried next run.
      const detail = err instanceof AuthError
        ? `${err.message} (check the token and its scopes)`
        : err.message;
      log.error(`${source}: ${detail}`);
      if (!args.dryRun) {
        setSyncState(db, source, { status: 'error', error: detail });
        finishRun(db, runId, { status: 'error', error: detail });
      }
      results.push({ source, status: 'error', error: detail, upserted: 0 });
    }
  }

  const failed = results.filter((r) => r.status === 'error').length;
  const exitCode = failed === 0 ? 0 : (failed === results.length ? 1 : 2);

  // Attribution runs after every source has committed its events, and only against
  // real writes - a dry run has nothing durable yet to attribute, and --no-enrich
  // lets a run skip the LLM call entirely (e.g. for a quick manual sync).
  let enrichment = null;
  if (!args.dryRun && !args.noEnrich) {
    try {
      enrichment = await enrichPending(db, cfg, { now, log: (m) => log.info(`enrich: ${m}`), ...(runClaude ? { runClaude } : {}) });
      log.info(`enrich: processed ${enrichment.processed}, resolved ${enrichment.resolved}`);
    } catch (err) {
      // enrichPending itself does not throw for a model/parsing failure - this only
      // guards against something unexpected, so a bug here still can't break sync.
      log.error(`enrich: unexpected failure: ${err.message}`);
      enrichment = { processed: 0, resolved: 0, error: err.message };
    }
  }

  return { results, exitCode, enrichment };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const p = paths();
  // 0700 so the data directory itself is not listable by other local users.
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  // A source's error text can include repo/org/project names, so the log gets the
  // same 0600 treatment as the database. `mode` on createWriteStream only applies
  // when the file doesn't already exist yet, so a pre-existing log (from before
  // this was added, or created some other way) is chmod'd explicitly too.
  const logPath = p.logs ? `${p.logs}/sync.log` : '/dev/null';
  if (p.logs && existsSync(logPath)) {
    try { chmodSync(logPath, 0o600); } catch { /* best effort */ }
  }
  const logStream = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const log = createLogger({
    write: (line) => { logStream.write(line); process.stderr.write(line); },
  });

  const cfg = loadConfig();
  const secrets = loadSecrets();
  const db = openDatabase(p.db);
  const release = acquireLock(p.lock, log);

  try {
    if (!args.dryRun) {
      const snap = await snapshot(db, p.backups);
      const removed = prune(p.backups, { retentionDays: cfg.backup?.retentionDays ?? 30 });
      log.info(`backup ${snap.path} (${snap.bytes} bytes), pruned ${removed.length}`);
    }

    const http = createHttpClient({ log: (m) => log.info(m) });
    const { results, exitCode } = await runSync({ args, cfg, secrets, db, log, http });

    for (const r of results) {
      log.info(`${r.source}: ${r.status}${r.error ? ` - ${r.error}` : ` (${r.upserted} written)`}`);
    }
    return exitCode;
  } finally {
    release();
    db.close();
    logStream.end();
  }
}

// Only run when invoked directly, so the module stays importable by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}
