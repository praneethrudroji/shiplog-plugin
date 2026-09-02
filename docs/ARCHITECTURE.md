# Architecture

This document explains how `shiplog` is built: the data flow between its stages, the responsibility of
each module, and the invariants the implementation depends on. It assumes no prior familiarity with
the codebase. For *why* a given approach was chosen over an alternative, see
[DECISIONS.md](DECISIONS.md), which this document references rather than repeats.

## Overview

`shiplog` runs in three stages, each with a distinct trust boundary:

```
 ┌──────────────┐      ┌───────────────┐      ┌──────────────────┐
 │   1. Ingest   │ ───▶ │  2. Attribute │ ───▶ │    3. Query       │
 │               │      │               │      │                  │
 │ Source APIs   │      │ LLM resolves  │      │ MCP server reads  │
 │  → normalize  │      │ ambiguous     │      │ SQLite; Claude    │
 │  → SQLite     │      │ dates in text │      │ composes answers  │
 │               │      │               │      │                  │
 │ No LLM call.  │      │ Best-effort;  │      │ Runs only when    │
 │ Runs on the   │      │ failure never │      │ the user asks a   │
 │ OS scheduler. │      │ loses data.   │      │ question.         │
 └──────────────┘      └───────────────┘      └──────────────────┘
```

Stage 1 is deterministic and depends on nothing beyond the three source APIs; it is what the OS
scheduler invokes on a nightly cadence. Stage 2 is best-effort: if it fails, the events it would have
processed are already committed by Stage 1, and simply remain queued for the next run. Stage 3 runs
on demand, when a question is actually asked, and is the only stage where an LLM has access to the
data rather than merely helping to prepare it.

A fourth, much smaller piece sits alongside these: a `SessionStart` hook (`bin/standup.mjs`) that
surfaces a short, deterministic summary with no LLM involved, the first time a session starts on a
given calendar day, covering whichever range the user configured (yesterday's working day, last week, or
last month). It reads the same database Stage 3 does, but is gated separately (once per day) and
triggered automatically rather than on request. See [Automatic standup summary](#automatic-standup-summary-binstandupmjs)
below.

## Module map

Paths are relative to `plugins/shiplog/`, where the plugin lives. The repository root holds only the
marketplace manifest, the documentation and the CI workflows.

| Path | Responsibility |
| --- | --- |
| `lib/ranges.mjs` | Calendar arithmetic: named ranges, fiscal years and quarters, timezone-correct day boundaries |
| `lib/config.mjs` | Loads and validates `~/.shiplog/config.json`; separates secrets from configuration |
| `sql/schema.sql`, `lib/db.mjs` | The SQLite schema and all read/write access to it |
| `lib/http.mjs` | A shared HTTP client with retry, backoff, and rate-limit handling |
| `lib/redact.mjs` | Strips credential-shaped strings from anything written to the log |
| `lib/backup.mjs` | Database snapshots (via SQLite's online backup API) and retention |
| `lib/temporal/prefilter.mjs` | Deterministic detection of date references in free text |
| `lib/temporal/enrich.mjs` | LLM-based date attribution for the flagged backlog, run after ingestion |
| `lib/sources/github.mjs` | Fetches and normalizes a developer's own GitHub activity |
| `lib/sources/azure-devops.mjs` | Fetches and normalizes Azure DevOps PRs, work items, and deployments |
| `bin/sync.mjs` | The ingestion entry point; what the OS scheduler runs |
| `mcp/tools.mjs` | The query tools' definitions and handler logic, independent of transport |
| `mcp/server.mjs` | The stdio JSON-RPC harness Claude Code launches and communicates with |
| `skills/shiplog-query/SKILL.md` | Teaches Claude when and how to use the query tools |
| `lib/standup.mjs` | Standup summary logic: once-per-day gating and plain-text formatting |
| `bin/standup.mjs`, `hooks/hooks.json` | The `SessionStart` hook that surfaces the summary automatically |

## Stage 1: Ingest

### Calendar arithmetic (`lib/ranges.mjs`)

Every other stage that reasons about dates calls into this module rather than computing dates
independently. That covers ingestion windows, query ranges and fiscal reporting periods, so that
"this quarter" means the same thing everywhere in the system.

Dates are represented internally as plain `{year, month, day}` objects and converted to and from a
day-count integer for arithmetic. This avoids a common class of bug in date libraries that operate
directly on calendar fields, where adding a month to the last day of a longer month produces an
unintended date (adding one month to January 31st, for instance).

Two properties are load-bearing:

- **Ranges are half-open.** A range's `end` boundary is exclusive. This is what allows adjacent ranges
  ("yesterday" and "today") to tile exactly, with neither a gap nor an overlap between them.
- **Boundaries are computed in the configured timezone, not UTC.** "Today" means local midnight to
  local midnight where the user is, not where the server happens to be. This is implemented by asking
  the platform's `Intl` API for the UTC offset in effect at a given local time, then re-deriving that
  offset from the corrected instant. The second pass is necessary because the first estimate can be
  wrong across a daylight-saving transition.

Fiscal years and quarters are computed relative to a configurable start month, not the calendar year.
An organization using an April-start fiscal year and one using a January-start fiscal year both express
their reporting periods correctly through the same function.

### Configuration and secrets (`lib/config.mjs`)

Configuration is loaded from `~/.shiplog/config.json`, validated field by field, and merged over a set
of defaults, so a configuration file written against an older version of `shiplog` still loads
correctly after an upgrade adds new fields.

Two properties are enforced at load time rather than left as documentation:

- **File permissions are checked before the file is trusted.** A configuration or secrets file
  readable by another user or group is treated as a setup error, not a warning, because both files
  govern access to the developer's own work history and, for secrets, live credentials.
- **Secrets are never stored in the configuration file.** `config.json` records the *name* of an
  environment variable (`tokenEnv: "SHIPLOG_GITHUB_TOKEN"`); the value lives in a separate
  `secrets.env` file. This means the configuration file remains safe to inspect, log, or share while
  debugging, without risk of exposing a credential.

### The data model (`sql/schema.sql`, `lib/db.mjs`)

All activity is stored in a single `events` table, one row per PR, commit, comment, review, or ticket
change, normalized to a common shape regardless of source. Two columns carry the design's central
distinction:

- `occurred_at` is the timestamp the source system recorded. It is set once and never modified.
- `effective_at` is the date the work is attributed to, populated by Stage 2 and never inferred by
  Stage 1. Queries read this column when present and fall back to `occurred_at` otherwise.

A `UNIQUE(source, event_type, external_id)` constraint makes every write idempotent: re-ingesting the
same event twice updates the existing row rather than duplicating it. This is what allows Stage 1 to
safely re-pull an overlapping time window on every run (to catch edits made after a previous sync),
without accumulating duplicates.

The upsert's conflict clause is deliberately asymmetric. Mutable fields such as status, title and
body are always refreshed from the source. The `effective_at` family of columns is never touched by a
re-ingestion, so an attribution already resolved for an event survives indefinitely, unless the
underlying comment text changes, in which case the event is re-queued for attribution. A manually
corrected attribution (`effective_source = 'manual'`) is never re-queued regardless of later edits,
because a human's correction is treated as final.

A `sync_state` table tracks, per source, the timestamp through which that source has been
successfully ingested. Its update is also asymmetric: a failed run records its error but does not
advance this timestamp, so the time window it failed to cover is retried on the next run rather than
silently skipped.

### The HTTP client (`lib/http.mjs`)

A single client implementation is shared by every source module, so that retry behavior, backoff, and
rate-limit handling are written and tested once. It distinguishes three response categories:

- A client error with no rate-limit signal (for example, 401 or 403 without rate-limit headers) is
  treated as an authentication failure and is not retried, retrying a request with an invalid
  credential wastes time without a prospect of succeeding.
- A response indicating an exhausted rate limit (a 403 or 429 carrying rate-limit headers) causes the
  client to wait until the indicated reset time and then retry, without consuming the request's retry
  budget. This distinction matters because GitHub's search API, in particular, returns exactly this
  shape when its budget is exhausted, and treating it as an ordinary retryable failure would exhaust
  the retry budget in a single burst.
- A server error (5xx) or a generic rate-limit response without explicit reset information is retried
  with exponential backoff, up to a configured limit.

Pagination follows a response's `Link: rel="next"` header up to a fixed maximum page count, so that a
malformed or unexpectedly circular pagination response cannot cause an unattended run to loop
indefinitely.

### Logging and redaction (`lib/redact.mjs`)

Every log line passes through a redaction filter before being written to disk. The filter recognizes
the shape of credentials from each supported source (GitHub, Atlassian, generic bearer tokens, and
`KEY=value`-style assignments) and replaces them with a placeholder. This exists because a nightly
job's log file is a plausible artifact for a user to paste into a bug report, and a credential must
never depend on the user remembering to redact it manually first.

### Detecting temporal references (`lib/temporal/prefilter.mjs`)

Before an event's comment text is considered for LLM-based attribution, it passes through a
deterministic filter that decides whether it contains a date reference worth resolving. This filter
performs no attribution itself, only detection, and exists to keep Stage 2's LLM usage rare and
inexpensive.

The filter classifies a match into one of three categories, which later determines how far Stage 2 is
permitted to backdate the event (see [DECISIONS.md § Source timestamps are immutable](DECISIONS.md)):
an **explicit** date carrying its own year, a **relative** phrase ("yesterday," "last Friday"), or a
**partial** date with no year (`22/01`). Before matching, the filter removes code blocks, inline code
spans, and URLs from the text, since these are the primary source of false positives, a pull request
numbered `22/01`, or a version string, is not a date.

### Ingestion sources (`lib/sources/*.mjs`)

Each source module exports a single fetch function that accepts an injected HTTP client and returns a
list of normalized events. The injection is what allows the module's tests to run against fixed,
recorded fixtures rather than a live API or an HTTP-mocking layer, a test simply supplies a fetcher
that returns prepared responses.

`lib/sources/azure-devops.mjs` follows the same pattern. Its endpoint shapes (pull requests, PR
comment threads, WIQL, the work item batch and comments and updates APIs, and Release deployments)
were verified against the current Microsoft Learn REST API v7.1 documentation rather than recalled
from training, and its fixtures are built directly from that documentation's own examples. Unlike
GitHub, this source has **not** been exercised against a real Azure DevOps organization, no
credentials were available during development, so its live-request behavior (pagination edge cases,
field presence in practice) carries more residual risk than the fixture tests alone can rule out.
Two things worth knowing before the first real sync: review votes only get a real timestamp because
they surface as system-generated PR thread comments (e.g. "Jane voted 10"), since the reviewer list
itself carries no per-vote time. Deployment tracking covers Classic Release pipelines only, since
YAML pipeline environment approvals have no equivalent REST endpoint. That is a documented v1 gap.

`lib/sources/github.mjs` is implemented first, and establishes the pattern later sources follow: it
resolves the developer's identity once (via GitHub's `/user` endpoint) rather than trusting a
manually-entered username, restricts every query to that identity so another person's activity is
never recorded as the user's own, and re-validates every result's own timestamp against the requested
window, because a search index can return results slightly outside the requested range, and the
mapper, not the API, is the final authority on what belongs in the window.

### The sync entry point (`bin/sync.mjs`)

This is the script an OS scheduler invokes. It acquires an exclusive lock (breaking a lock older than
an hour, on the assumption that a previous run crashed), snapshots the database before making changes,
and then processes each enabled source independently, a failure in one source is caught, logged, and
recorded against that source's `sync_state`, without affecting any other source's run or advancing
that source's watermark past the point of failure. The process exit code reflects the outcome: `0` if
every source succeeded, `2` if some but not all failed, `1` if all failed, which is what a future
`/shiplog-status` command surfaces to the user.

### Backups (`lib/backup.mjs`)

A snapshot is taken using SQLite's online backup API rather than a plain file copy, because a file
copy taken while the database is open under write-ahead logging can capture a torn, inconsistent
state. Snapshots older than the configured retention window are pruned, with one exception: the most
recent snapshot is never pruned, even if it is older than the retention window, so that a machine left
off for an extended period is never left with zero backups.

## Stage 2: Attribute (`lib/temporal/enrich.mjs`)

Stage 2 consumes the backlog of events flagged by the prefilter (`needs_enrichment = 1`) and resolves
each one's `effective_at` with a single batched call to `claude -p --model haiku --fallback-model
sonnet` (see [DECISIONS.md § Model selection](DECISIONS.md) for why this is a capability alias rather
than a pinned model). It is invoked from `bin/sync.mjs` once, after every source has finished
ingesting, and is skipped entirely on a dry run or with `--no-enrich`.

Three properties make this stage safe to run unattended:

- **The invocation is dependency-injected.** `enrichPending(db, cfg, { runClaude })` defaults
  `runClaude` to the real CLI wrapper (`runClaudeCli`), but every test supplies a fake, so the
  automated test suite makes no network calls and costs nothing to run. The one live check that
  exercises the real `claude` binary was run manually during development, not folded into the
  permanent suite, for the same reason.
- **Parsing is defensive, not optimistic.** The model is instructed to return only a JSON array, but
  in practice sometimes wraps it in a markdown code fence regardless of that instruction.
  `parseAttributions` tries a fenced-stripped parse, then falls back to extracting the first
  bracketed substring, and only throws if neither yields a valid array, but it never invents a result
  when nothing parses.
- **Every returned attribution is independently validated** (`validateAttribution`) before being
  written: the confidence must clear a configured floor, the date must not be in the future or after
  the comment's own post date, and how far back it may reach is capped according to the reference
  kind detected by the prefilter (see [DECISIONS.md § Source timestamps are immutable](DECISIONS.md)).
  A rejected attribution, an unparseable response, or a failed CLI invocation all result in the same
  outcome: the event stays in the backlog, and the next run tries again. An id the model returns that
  wasn't part of the batch it was asked about is silently ignored rather than trusted.

## Stage 3: Query

The query server (`mcp/server.mjs`) is a Model Context Protocol server, run as a local subprocess and
communicated with over standard input and output as line-delimited JSON-RPC. It holds a single
read-only SQLite connection for its lifetime, see
[DECISIONS.md § Query server connection handling](DECISIONS.md) for why this is not a connection
pool. It exposes five parameterized tools (`mcp/tools.mjs`) rather than a general-purpose SQL
execution tool: `resolve_range`, `get_stats`, `query_events`, `list_projects`, and `get_sync_health`. This keeps
the boundary between what Stage 1 writes and what a query can read enforced at the connection level,
not only by convention.

The transport (`mcp/server.mjs`) and the tool logic (`mcp/tools.mjs`) are deliberately separate files.
`createDispatcher` in the server takes plain functions (`getCfg`, `getDb`) and returns a function from
a parsed JSON-RPC request to a response, with no dependency on stdio, so the protocol logic (method
routing, notification handling, error shaping) can be tested by calling it directly, and only a
smaller set of tests needs to exercise the real subprocess and its line framing. Both configuration and
the database connection are resolved lazily and re-checked per call, since a freshly installed plugin
has neither yet: a tool invoked before `/shiplog-setup` or before the first sync returns a clear,
catchable error rather than crashing the server process.

`skills/shiplog-query/SKILL.md` is a model-invoked skill, Claude reaches for it based on its
description, not a slash command, that sequences these tools: check `get_sync_health` first and
surface staleness, resolve the range through `resolve_range` rather than computing dates directly,
get aggregate shape from `get_stats` before specifics from `query_events`, and cite each event's
`effective_at` alongside its `occurred_at` when they differ, so an answer can state its own evidentiary
basis.

## Automatic standup summary (`bin/standup.mjs`)

This exists so a standup summary appears without being asked for, the entire point of the feature is
that it's automatic (see [DECISIONS.md D19](DECISIONS.md)). It runs as a `SessionStart` hook
(`hooks/hooks.json`), matched to `"startup"` only, a resumed, cleared, compacted, or forked session
never re-triggers it, only a genuinely new one.

**How a hook actually reaches the user matters here, and it's indirect.** A `SessionStart` hook cannot
print to the terminal directly; its JSON output on stdout becomes context injected into Claude's own
prompt (`hookSpecificOutput.additionalContext`), and Claude decides what to do with it. `bin/standup.mjs`
therefore emits not just the summary text but an explicit instruction alongside it, to show the
summary near the top of the first reply, briefly and close to verbatim, before addressing whatever the
user actually asked. Without that instruction the summary is just background context a model might
reasonably fold in only where topically relevant, which would defeat the purpose.

**The computation itself is deterministic**, a `getStats`/`queryEvents` read against the local
database, no LLM call (see [DECISIONS.md D20](DECISIONS.md)), because a `SessionStart` hook runs on
every terminal open and must be instant.

Three things make the hook safe to ship into an automatic, unattended path:

- **It must never fail a session start.** Every failure mode, no config yet, a corrupt state file, no
  database yet, an exception anywhere in the summary logic, is caught and results in silence (`main`
  in `bin/standup.mjs` is wrapped end to end), never a thrown error or non-zero exit.
- **"No sync has ever run" and "synced, but nothing in this range" are deliberately distinguished.**
  The first stays silent, a fresh install shouldn't greet the user with a status report before
  they've even configured a source. The second still says so ("no tracked activity for last week"),
  because that is itself useful information once the feature is active.
  A corrupt `standup_state.json` is treated the same way as a missing one, for the same reason: this
  path must degrade to silence, never to an error.
- **Gating is a plain date comparison** (`lastShownDate` in `~/.shiplog/standup_state.json` against
  today's date in the configured timezone), checked and updated by `runStandupCheck` in
  `lib/standup.mjs`, kept independent of the hook transport so it's tested directly, without spawning
  a process, for every case except the transport itself.

`last_working_day` (one of the three configurable ranges, alongside `last_week` and `last_month`) is a
calendar-engine addition, not a standup-specific one, it walks backward from today, skipping
configured weekend days (`weekendDays`, default Saturday/Sunday), and is available to any caller of
`resolveRange`, including the MCP tools.

## Testing approach

Every module above `bin/sync.mjs` is unit-tested using Node's built-in test runner, without a network
connection or live credentials. This is possible because of two consistent choices: source modules
accept an injected fetcher rather than calling `fetch` directly, and the SQLite layer runs equally well
against an on-disk temporary file or an in-memory database. `bin/sync.mjs` is exercised the same way,
with a scripted HTTP client standing in for the network, and additionally against the real GitHub API
using a deliberately invalid credential, to confirm the failure path behaves as designed and that no
credential reaches the log file under any code path.

`bin/standup.mjs` gets the same two-layer treatment: `lib/standup.mjs`'s logic is tested directly
(gating, formatting, the never-synced/no-activity distinction), and a separate suite spawns the actual
script as a subprocess via `child_process.execFileSync`, the way the `SessionStart` hook itself would,
and asserts on the literal JSON written to stdout, including that a malformed config still exits 0
rather than ever risking a blocked session start.
