---
name: shiplog-status
description: Show shiplog health - when each source last synced, how many events are stored, the size of the date-attribution backlog, whether the nightly job is registered, and when it next runs.
allowed-tools: [Bash]
---

# shiplog status

Gather the facts first, then report them in a short readable summary. Do not speculate about
causes you have not checked.

## 1. Sync health and stored data

Use the MCP tool `get_sync_health` if it is available in this session. It reports each source's last
sync time and status, the pending attribution backlog, and the earliest date covered.

If the MCP server is not connected, read the database directly instead:

```bash
sqlite3 ~/.shiplog/shiplog.db \
  "SELECT source, last_synced_at, last_status, COALESCE(last_error,'') FROM sync_state;" \
  "SELECT COUNT(*) || ' events' FROM events;" \
  "SELECT COUNT(*) || ' pending attribution' FROM events WHERE needs_enrichment = 1;" \
  "SELECT MIN(COALESCE(effective_at, substr(occurred_at,1,10))) || ' earliest' FROM events;"
```

## 2. The scheduled job

```bash
node $CLAUDE_PLUGIN_ROOT/bin/install-scheduler.mjs --status
```

## 3. Recent runs and disk

```bash
sqlite3 ~/.shiplog/shiplog.db \
  "SELECT started_at, source, status, events_upserted, COALESCE(error_detail,'') FROM sync_runs ORDER BY id DESC LIMIT 5;"
du -h ~/.shiplog/shiplog.db 2>/dev/null
ls -1 ~/.shiplog/backups 2>/dev/null | wc -l
tail -5 ~/.shiplog/logs/sync.log 2>/dev/null
```

## 4. Report

Cover: last successful sync per source, total events and coverage start, attribution backlog size,
whether the nightly job is registered and when it next runs, database size and backup count.

Call out problems directly and say what to do about them:

- A source with `last_status = 'error'`: quote the error. An auth failure means the token expired or
  lacks a scope, and `/shiplog-setup --reconfigure` will replace it.
- A source enabled in config but with no row in `sync_state`: it has never synced.
- The job not registered: offer `node $CLAUDE_PLUGIN_ROOT/bin/install-scheduler.mjs --install`.
- A last sync older than about 36 hours: say so, since any answer drawn from this data will be
  missing recent work.
- A large attribution backlog: normal if the last few runs used `--no-enrich`, otherwise it suggests
  the `claude -p` call is failing. `~/.shiplog/logs/sync.log` will show why.
