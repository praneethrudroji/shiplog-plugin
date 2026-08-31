-- worklog schema v1
-- Timestamps are ISO8601 UTC strings. Dates attributed to work (effective_at) are
-- calendar dates in the user's configured timezone, stored as YYYY-MM-DD.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('azure_devops', 'jira', 'github')),
  event_type   TEXT NOT NULL CHECK (event_type IN (
                 'pr_opened', 'pr_merged', 'pr_reviewed', 'pr_comment', 'commit',
                 'ticket_created', 'ticket_comment', 'ticket_status_change',
                 'deployment_request'
               )),
  external_id  TEXT NOT NULL,

  project      TEXT,
  repo         TEXT,
  title        TEXT,
  body         TEXT,
  url          TEXT,
  status       TEXT,
  parent_key   TEXT,

  -- When the source recorded it. Always known, never overwritten.
  occurred_at  TEXT NOT NULL,

  -- When the work actually happened, per the prose. NULL until resolved.
  effective_at          TEXT,
  effective_precision   TEXT CHECK (effective_precision IN ('day', 'week', 'month')),
  effective_confidence  REAL,
  effective_source      TEXT CHECK (effective_source IN ('timestamp', 'llm', 'manual')),
  effective_reasoning   TEXT,
  needs_enrichment      INTEGER NOT NULL DEFAULT 0,

  updated_at   TEXT,
  raw_json     TEXT NOT NULL,
  synced_at    TEXT NOT NULL,

  UNIQUE (source, event_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_events_effective ON events(effective_at);
CREATE INDEX IF NOT EXISTS idx_events_occurred  ON events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type      ON events(source, event_type);
CREATE INDEX IF NOT EXISTS idx_events_project   ON events(project);

-- The enrichment backlog. Partial index so it stays tiny regardless of table size.
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(id) WHERE needs_enrichment = 1;

CREATE TABLE IF NOT EXISTS sync_state (
  source         TEXT PRIMARY KEY,
  last_cursor    TEXT,
  last_synced_at TEXT,
  last_status    TEXT,
  last_error     TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  events_upserted INTEGER NOT NULL DEFAULT 0,
  status          TEXT,
  error_detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
