import { DatabaseSync } from 'node:sqlite';
import { readFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_VERSION = 1;
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql', 'schema.sql');

/**
 * The database holds titles and comment text pulled from private company systems, so
 * it is restricted to the owner. SQLite creates it 0644 by default, and creates the
 * -wal and -shm sidecars separately, which hold the same data and need the same
 * treatment.
 */
export function restrictPermissions(path) {
  if (process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${path}${suffix}`;
    try {
      if (existsSync(p)) chmodSync(p, 0o600);
    } catch { /* best effort: a permissions failure must not break a sync */ }
  }
}

export function openDatabase(path, { readOnly = false } = {}) {
  const db = new DatabaseSync(path, { readOnly });
  if (!readOnly) {
    migrate(db);
    restrictPermissions(path);
  }
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database schema is v${current}, newer than this build understands (v${SCHEMA_VERSION}). Upgrade the plugin.`,
    );
  }
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

const UPSERT = `
INSERT INTO events (
  source, event_type, external_id, project, repo, title, body, url, status, parent_key,
  occurred_at, updated_at, raw_json, synced_at, needs_enrichment
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (source, event_type, external_id) DO UPDATE SET
  project    = excluded.project,
  repo       = excluded.repo,
  title      = excluded.title,
  body       = excluded.body,
  url        = excluded.url,
  status     = excluded.status,
  parent_key = excluded.parent_key,
  updated_at = excluded.updated_at,
  raw_json   = excluded.raw_json,
  synced_at  = excluded.synced_at,
  -- Re-flag for enrichment only if the text changed and no human has ruled on it.
  needs_enrichment = CASE
    WHEN events.effective_source = 'manual' THEN 0
    WHEN events.body IS NOT excluded.body THEN excluded.needs_enrichment
    ELSE events.needs_enrichment
  END
`;

const stmtCache = new WeakMap();
function prepared(db, sql) {
  let byQuery = stmtCache.get(db);
  if (!byQuery) stmtCache.set(db, byQuery = new Map());
  let stmt = byQuery.get(sql);
  if (!stmt) byQuery.set(sql, stmt = db.prepare(sql));
  return stmt;
}

/**
 * The ON CONFLICT clause deliberately never touches effective_* columns: a re-sync
 * of an unchanged event must not discard an attribution already resolved for it.
 */
export function upsertEvent(db, e) {
  const info = prepared(db, UPSERT).run(
    e.source, e.event_type, e.external_id,
    e.project ?? null, e.repo ?? null, e.title ?? null, e.body ?? null,
    e.url ?? null, e.status ?? null, e.parent_key ?? null,
    e.occurred_at, e.updated_at ?? null,
    typeof e.raw_json === 'string' ? e.raw_json : JSON.stringify(e.raw_json ?? {}),
    e.synced_at ?? new Date().toISOString(),
    e.needs_enrichment ? 1 : 0,
  );
  return info.changes;
}

export function upsertEvents(db, events) {
  db.exec('BEGIN');
  try {
    let n = 0;
    for (const e of events) n += upsertEvent(db, e);
    db.exec('COMMIT');
    return n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setAttribution(db, id, { effective_at, precision, confidence, source, reasoning }) {
  return db.prepare(`
    UPDATE events SET
      effective_at = ?, effective_precision = ?, effective_confidence = ?,
      effective_source = ?, effective_reasoning = ?, needs_enrichment = 0
    WHERE id = ?
  `).run(effective_at, precision ?? 'day', confidence ?? null, source, reasoning ?? null, id).changes;
}

/** Events flagged by the prefilter and not yet resolved. */
export function pendingEnrichment(db, limit = 50) {
  return db.prepare(`
    SELECT id, source, event_type, body, title, occurred_at
    FROM events WHERE needs_enrichment = 1
    ORDER BY occurred_at DESC LIMIT ?
  `).all(limit);
}

export function getSyncState(db, source) {
  return db.prepare('SELECT * FROM sync_state WHERE source = ?').get(source) ?? null;
}

export function setSyncState(db, source, { cursor, status, error }) {
  db.prepare(`
    INSERT INTO sync_state (source, last_cursor, last_synced_at, last_status, last_error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source) DO UPDATE SET
      -- A failed run must not advance the watermark, or its window is lost forever.
      last_cursor    = CASE WHEN excluded.last_status = 'ok' THEN excluded.last_cursor
                            ELSE sync_state.last_cursor END,
      last_synced_at = CASE WHEN excluded.last_status = 'ok' THEN excluded.last_synced_at
                            ELSE sync_state.last_synced_at END,
      last_status    = excluded.last_status,
      last_error     = excluded.last_error
  `).run(source, cursor ?? null, new Date().toISOString(), status, error ?? null);
}

export function startRun(db, source) {
  return db.prepare(
    'INSERT INTO sync_runs (source, started_at) VALUES (?, ?) RETURNING id',
  ).get(source, new Date().toISOString()).id;
}

export function finishRun(db, id, { upserted = 0, status, error = null }) {
  db.prepare(`
    UPDATE sync_runs SET finished_at = ?, events_upserted = ?, status = ?, error_detail = ?
    WHERE id = ?
  `).run(new Date().toISOString(), upserted, status, error, id);
}

export function coverageStart(db) {
  return db.prepare(
    "SELECT MIN(COALESCE(effective_at, substr(occurred_at, 1, 10))) AS d FROM events",
  ).get()?.d ?? null;
}

const KNOWN_SOURCES = ['github', 'azure_devops', 'jira'];
const KNOWN_EVENT_TYPES = [
  'pr_opened', 'pr_merged', 'pr_reviewed', 'pr_comment', 'commit',
  'ticket_created', 'ticket_comment', 'ticket_status_change', 'deployment_request',
];

// `effective_at` is a date (YYYY-MM-DD); `occurred_at` is a full ISO instant, so its
// first 10 characters are compared, never a raw string comparison across both.
const EFFECTIVE_DATE = '(CASE WHEN effective_at IS NOT NULL THEN effective_at ELSE substr(occurred_at, 1, 10) END)';

function inClause(column, values) {
  if (!values?.length) return { sql: '1=1', params: [] };
  return { sql: `${column} IN (${values.map(() => '?').join(',')})`, params: values };
}

/** Validates values against a fixed allowlist; used for anything that reaches raw SQL text. */
function assertKnown(values, allowed, label) {
  for (const v of values ?? []) {
    if (!allowed.includes(v)) throw new Error(`unknown ${label}: ${v}`);
  }
}

const GROUP_COLUMNS = {
  event_type: 'event_type',
  source: 'source',
  project: "COALESCE(project, '(none)')",
  day: EFFECTIVE_DATE,
};

/**
 * Aggregate counts over a range. `groupBy` is looked up in a fixed column allowlist
 * rather than interpolated, since it becomes part of the SQL text itself.
 */
export function getStats(db, { start, end, groupBy = 'event_type' }) {
  const column = GROUP_COLUMNS[groupBy];
  if (!column) throw new Error(`unknown groupBy: ${groupBy} (expected one of ${Object.keys(GROUP_COLUMNS).join(', ')})`);

  const rows = db.prepare(`
    SELECT ${column} AS key, COUNT(*) AS count
    FROM events
    WHERE ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?
    GROUP BY key
    ORDER BY count DESC
  `).all(start.slice(0, 10), end.slice(0, 10));

  return { total: rows.reduce((sum, r) => sum + r.count, 0), byKey: rows };
}

/** Row-level event listing. Every filter is bound as a parameter; none are interpolated. */
export function queryEvents(db, { start, end, sources, eventTypes, project, textSearch, limit = 500 }) {
  assertKnown(sources, KNOWN_SOURCES, 'source');
  assertKnown(eventTypes, KNOWN_EVENT_TYPES, 'event_type');
  const cappedLimit = Math.max(1, Math.min(limit ?? 500, 2000));

  const sourceClause = inClause('source', sources);
  const typeClause = inClause('event_type', eventTypes);
  const params = [start.slice(0, 10), end.slice(0, 10), ...sourceClause.params, ...typeClause.params];

  let projectSql = '1=1';
  if (project) {
    projectSql = 'project = ?';
    params.push(project);
  }
  let searchSql = '1=1';
  if (textSearch) {
    searchSql = '(title LIKE ? OR body LIKE ?)';
    params.push(`%${textSearch}%`, `%${textSearch}%`);
  }
  params.push(cappedLimit);

  return db.prepare(`
    SELECT id, source, event_type, project, repo, title, url, status,
           occurred_at, effective_at, effective_source, ${EFFECTIVE_DATE} AS effective_date
    FROM events
    WHERE ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?
      AND ${sourceClause.sql} AND ${typeClause.sql} AND ${projectSql} AND ${searchSql}
    ORDER BY effective_date DESC
    LIMIT ?
  `).all(...params);
}

export function listProjects(db, { start, end } = {}) {
  const hasRange = start && end;
  const rows = db.prepare(`
    SELECT COALESCE(project, '(none)') AS project, COUNT(*) AS count
    FROM events
    WHERE (NOT ? OR (${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?))
    GROUP BY project
    ORDER BY count DESC
  `).all(hasRange ? 1 : 0, hasRange ? start.slice(0, 10) : '0000-01-01', hasRange ? end.slice(0, 10) : '9999-12-31');
  return rows;
}

/** Per-source sync status, plus the size of the attribution backlog and overall coverage. */
export function getSyncHealth(db) {
  const bySource = Object.fromEntries(
    KNOWN_SOURCES.map((s) => [s, getSyncState(db, s)]),
  );
  const pending = db.prepare('SELECT COUNT(*) AS n FROM events WHERE needs_enrichment = 1').get().n;
  return { sources: bySource, pendingEnrichment: pending, coverageStart: coverageStart(db) };
}
