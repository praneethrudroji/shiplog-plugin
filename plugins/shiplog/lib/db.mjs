import { DatabaseSync } from 'node:sqlite';
import { readFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { zonedParts } from './ranges.mjs';

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

/**
 * Repairs Azure DevOps work item status changes stored with the year-9999 sentinel
 * as their timestamp, written by builds before that trap was known.
 *
 * A re-sync cannot fix these on its own, and deliberately so: the upsert never
 * overwrites `occurred_at`, because it is the source system's own timestamp and a
 * later sync has no business rewriting it. That invariant is right, but it assumes
 * the stored value was a real timestamp to begin with. A sentinel never was, so it
 * would otherwise sit in the database forever, sorting above every genuine event.
 *
 * Narrow on purpose: only rows that are exactly this known-bad value, and only when
 * the correct timestamp can be recovered from the raw payload that was stored
 * alongside it. Anything it cannot repair confidently is left alone rather than
 * guessed at.
 */
function repairSentinelTimestamps(db) {
  const broken = db.prepare(`
    SELECT id, raw_json FROM events
    WHERE event_type = 'ticket_status_change' AND occurred_at LIKE '9999-%'
  `).all();
  if (!broken.length) return 0;

  const update = db.prepare('UPDATE events SET occurred_at = ? WHERE id = ?');
  let repaired = 0;
  for (const row of broken) {
    let changed = null;
    try {
      changed = JSON.parse(row.raw_json)?.fields?.['System.ChangedDate']?.newValue ?? null;
    } catch { /* unparseable payload: leave the row alone rather than invent a date */ }

    if (changed && !String(changed).startsWith('9999')) {
      update.run(changed, row.id);
      repaired += 1;
    }
  }
  return repaired;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database schema is v${current}, newer than this build understands (v${SCHEMA_VERSION}). Upgrade the plugin.`,
    );
  }
  if (current === SCHEMA_VERSION) {
    repairSentinelTimestamps(db);
    return;
  }
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  repairSentinelTimestamps(db);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export { repairSentinelTimestamps };

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
// Used for filtering and ordering inside SQL, where a timezone conversion is not
// available: SQLite's only localtime is the machine's own, not a configurable one.
// It is close enough for range filtering, since the bounds themselves are already
// converted by localDateBound. It is NOT correct for reporting which day a row
// belongs to, because substr() yields the UTC date. Use effectiveDateOf() for that.
const EFFECTIVE_DATE = '(CASE WHEN effective_at IS NOT NULL THEN effective_at ELSE substr(occurred_at, 1, 10) END)';

/**
 * The local calendar date a row belongs to, in the configured timezone.
 *
 * `effective_at` is already a local date, written by the attribution stage, so it is
 * taken as-is. `occurred_at` is a UTC instant and must be converted rather than
 * sliced: slicing yields the UTC date, which is the wrong day for any timezone far
 * enough from UTC. An event at 22:30 UTC is already the next morning in Sydney, and
 * slicing files it under the previous day.
 *
 * This is the same class of bug as D22, one level down: D22 was about range bounds,
 * this is about the per-row date those rows are reported and grouped under.
 */
export function effectiveDateOf(row, timezone = 'UTC') {
  if (row.effective_at) return String(row.effective_at).slice(0, 10);
  return localDateBound(row.occurred_at, timezone);
}

/**
 * Converts a range boundary to the local calendar date it refers to, in the given
 * timezone. A bare "YYYY-MM-DD" is already an unambiguous local date and is
 * returned as-is. A full instant is converted properly rather than sliced.
 *
 * Slicing would be wrong here specifically: resolveRange's exclusive `end` is the
 * UTC instant of local midnight on the day *after* the range, but for any positive
 * UTC offset (IST, most of Asia, Australia, much of Europe) that instant's own UTC
 * calendar date is still today, not tomorrow. `end.slice(0, 10)` would silently
 * recover today's date as the exclusive bound, which excludes today's own events
 * from every query the moment they occur in a timezone ahead of UTC, the majority
 * of the timezones this plugin actually gets used in. Converting with the real
 * timezone recovers the date that instant is local midnight *of*, which is always
 * the correct bound regardless of offset direction.
 */
function localDateBound(value, timezone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const p = zonedParts(new Date(value), timezone);
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

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
export function getStats(db, { start, end, groupBy = 'event_type', timezone = 'UTC' }) {
  const column = GROUP_COLUMNS[groupBy];
  if (!column) throw new Error(`unknown groupBy: ${groupBy} (expected one of ${Object.keys(GROUP_COLUMNS).join(', ')})`);

  const bounds = [localDateBound(start, timezone), localDateBound(end, timezone)];

  // Grouping by day is done in JS rather than SQL, because the day a row belongs to
  // depends on the configured timezone and SQLite cannot convert to an arbitrary one.
  // Grouping on the UTC date would put an evening event under the previous day for
  // anyone east of UTC, which is exactly the kind of quiet wrongness D22 describes.
  if (groupBy === 'day') {
    const rows = db.prepare(`
      SELECT occurred_at, effective_at
      FROM events
      WHERE ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?
    `).all(...bounds);

    const counts = new Map();
    for (const row of rows) {
      const day = effectiveDateOf(row, timezone);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const byKey = [...counts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : 1));

    return { total: rows.length, byKey };
  }

  const rows = db.prepare(`
    SELECT ${column} AS key, COUNT(*) AS count
    FROM events
    WHERE ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?
    GROUP BY key
    ORDER BY count DESC
  `).all(...bounds);

  return { total: rows.reduce((sum, r) => sum + r.count, 0), byKey: rows };
}

/** Row-level event listing. Every filter is bound as a parameter; none are interpolated. */
export function queryEvents(db, { start, end, sources, eventTypes, project, textSearch, limit = 500, timezone = 'UTC' }) {
  assertKnown(sources, KNOWN_SOURCES, 'source');
  assertKnown(eventTypes, KNOWN_EVENT_TYPES, 'event_type');
  const cappedLimit = Math.max(1, Math.min(limit ?? 500, 2000));

  const sourceClause = inClause('source', sources);
  const typeClause = inClause('event_type', eventTypes);
  const params = [localDateBound(start, timezone), localDateBound(end, timezone), ...sourceClause.params, ...typeClause.params];

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

  const rows = db.prepare(`
    SELECT id, source, event_type, project, repo, title, url, status,
           occurred_at, effective_at, effective_source, ${EFFECTIVE_DATE} AS effective_date
    FROM events
    WHERE ${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?
      AND ${sourceClause.sql} AND ${typeClause.sql} AND ${projectSql} AND ${searchSql}
    ORDER BY effective_date DESC
    LIMIT ?
  `).all(...params);

  // Recompute the reported date in the configured timezone. SQL's version is the UTC
  // one, which files an evening event under the wrong day for anyone far enough from
  // UTC, and this value is what callers group and display by.
  return rows.map((row) => ({ ...row, effective_date: effectiveDateOf(row, timezone) }));
}

export function listProjects(db, { start, end, timezone = 'UTC' } = {}) {
  const hasRange = start && end;
  const rows = db.prepare(`
    SELECT COALESCE(project, '(none)') AS project, COUNT(*) AS count
    FROM events
    WHERE (NOT ? OR (${EFFECTIVE_DATE} >= ? AND ${EFFECTIVE_DATE} < ?))
    GROUP BY project
    ORDER BY count DESC
  `).all(
    hasRange ? 1 : 0,
    hasRange ? localDateBound(start, timezone) : '0000-01-01',
    hasRange ? localDateBound(end, timezone) : '9999-12-31',
  );
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
