# Architecture Decisions

This document records the decisions that shaped `shiplog`'s design: what was chosen, what alternative
was rejected, and why. It exists so that a later contributor, including the original author, months
on, can evaluate whether a decision still holds rather than re-deriving it from the code.

Entries are added as decisions are made, not after the fact. Superseded decisions are marked as such
rather than removed, so the project's history stays legible.

## Summary

| # | Decision | Chosen | Rejected alternative | Rationale |
| --- | --- | --- | --- | --- |
| D1 | Sources (v1) | Azure DevOps, Jira, GitHub | Azure DevOps + Jira only | Pull requests and commits are frequently hosted on GitHub even when issue tracking lives elsewhere |
| D2 | Destination | Local SQLite, with rotated backups | A hosted document store (e.g. Notion) | No external account, no network latency on the read path, and the data never leaves the user's machine |
| D3 | Scheduling | The user's own OS scheduler (launchd / cron) | A cloud-hosted cron service | A cloud job has no route to a local SQLite file; local scheduling keeps data and compute on one machine |
| D4 | Scope of "deployment request" | Azure DevOps only | Include GitHub Actions runs or the Deployments API | Only Azure DevOps Releases map to the concept cleanly; the GitHub equivalents are approximate enough to mislead a reader |
| D5 | Ingest / query separation | Ingest is deterministic; the LLM is invoked only at query time | Invoke the LLM during ingestion | An unattended nightly job must complete without depending on model availability or authentication |
| D6 | Date attribution | A second LLM stage, decoupled from ingestion | Rule-based extraction only, or LLM calls inline during ingestion | Comment volume is small enough that an LLM call is inexpensive, but it must not be able to block or corrupt ingestion if it fails |
| D7 | Attribution cost control | A deterministic prefilter, plus one batched call per run | One LLM call per candidate comment | Most comments carry no temporal reference; batching keeps typical nightly runs at zero or one call |
| D8 | LLM invocation | `claude -p --model haiku --fallback-model sonnet` | A pinned model ID, or a separate Anthropic API key | Reuses the user's existing Claude Code authentication; a capability alias tracks model changes without a plugin update |
| D9 | Source timestamp handling | `occurred_at` is immutable; attribution is stored separately in `effective_at` | Overwrite the timestamp in place | An attribution used as evidence of work must remain auditable against its source |
| D10 | Backdating limits | Scaled to how specific the temporal reference is | A single fixed limit | The risk of a false attribution is not uniform across reference types; the limit should reflect that |
| D11 | Date format resolution | Inferred from locale and confirmed at setup | Assume a fixed convention | Day-first and month-first conventions are both common; inference plus confirmation avoids silent misparsing |
| D12 | Runtime | Node.js ≥ 22, no third-party dependencies | Python, with a virtual environment for the query server | The distribution target is other developers' machines, where a dependency installation step is a common point of failure |
| D13 | Query server transport | A stdio JSON-RPC server, hand-implemented | The official MCP SDK | Preserves the zero-dependency property; the protocol surface used here is small enough to implement and test directly |
| D14 | Query server data access | A read-only connection; no arbitrary-SQL tool | A general-purpose SQL execution tool | Enforces the ingest/query boundary at the connection level, and removes a query-injection and prompt-injection surface |
| D15 | Secret storage | A separate `secrets.env` file, `0600` | Secrets embedded in the configuration file | Keeps the configuration file safe to inspect or share while debugging |
| D16 | Distribution target | Designed for other developers to install, not only the author | A personal, single-machine tool | Changes which failure modes are acceptable: setup friction and environment variance become first-class concerns |
| D17 | Query server connections | One persistent read-only connection per server process | A connection pool | SQLite is an embedded, file-backed database with no network handshake to amortize; a single process serves one user at a time |
| D18 | Jira | Descoped to a future release | Ship alongside GitHub and Azure DevOps in v1 | Reprioritized to ship the automatic standup summary first; the source-module pattern GitHub and Azure DevOps established carries over directly when Jira is picked back up |
| D19 | Standup summary trigger | A deterministic `SessionStart` hook, gated to once per calendar day | An MCP tool the user invokes manually | The point is that it appears without being asked, which is how a standup summary is actually used |
| D20 | Standup summary computation | Local SQLite query, no LLM call | Route it through `claude -p` like attribution does | It fires on every terminal open; it must be instant and free, not wait on a model call |
| D21 | Weekday cross-check on attribution | Deterministic: verify a claimed weekday against the resolved date's actual weekday | Trust the model's own date reasoning | Found live: the model resolved "Last Friday" to a Saturday at 0.95 confidence; a claimed weekday is a fact code can check with certainty and should not depend on the model getting right |
| D22 | Date-range boundary comparison | Convert instants to local calendar dates using the real timezone | Slice the first 10 characters off the ISO instant string | Found live: for any timezone ahead of UTC, that slice recovers today's date instead of tomorrow's, silently excluding today's own events from every query |
| D23 | Initial backfill depth | Default to 2 years back; hard cap at 2 years regardless of setting | Default to the fiscal year start (shallow); or leave the depth unbounded | Covers a full review and tenure cycle without risking a very long first sync; a cap protects against an unbounded or old-date setting even if the default is later changed |

## Ingest and query are separated by design (D5, D6, D7)

A comment posted at 23:00 on a Wednesday reading "yesterday I finished the migration" describes work
done on Tuesday. Filing it under the comment's post time misrepresents the record, which defeats the
purpose of a tool whose output is meant to stand as evidence in a review.

The system therefore runs in two stages. **Ingest** calls the source APIs, normalizes the results, and
writes them to SQLite. It performs no model inference and depends on no external service beyond the
three source APIs, which is what allows it to run unattended on a schedule for months without
intervention. **Attribution** resolves ambiguous temporal references in comment text into a concrete
date, and runs as a second pass after ingestion has already committed its data.

The ordering is the important part. If attribution fails, whether from a missing network, an expired
credential or a model-side error, the events it would have processed are already durable. The unresolved comments
remain in a backlog and are retried on the next run. Nothing is lost, and nothing blocks on the LLM
being available.

Cost is not the reason attribution uses an LLM rather than pure rules. At an expected volume of a
handful of relevant comments per day, either approach is inexpensive. The reason is accuracy: relative
and partial date references ("last Friday," "the 5th") require the same contextual reasoning a person
would apply, which a fixed rule set handles poorly. A deterministic prefilter (`lib/temporal/prefilter.mjs`)
narrows the candidate set first, so a typical night produces zero or one LLM call rather than one per
comment. The majority of comments carry no temporal reference at all.

## Source timestamps are immutable (D9, D10)

Two timestamps are stored for every event: `occurred_at`, the time the source system recorded it, and
`effective_at`, the date attribution assigns to the underlying work. The first is set once and never
modified. The second is written by the attribution stage and can be corrected manually. A query
answers using `effective_at` when it is present, and `occurred_at` otherwise, and can report both, so
an answer can state its own basis ("attributed to Jan 22 from the comment text, posted Jan 23").

The reasoning is separability of concerns: a value derived from inference and a value read directly
from a system of record should never occupy the same field. Merging them would make it impossible to
audit an attribution or to recover from a mistaken one.

Backdating is bounded, and the bound depends on how specific the reference is:

| Reference type | Example | Maximum backdate | Reasoning |
| --- | --- | --- | --- |
| Explicit date, with year | `22/01/2026` | 366 days | Unambiguous; the text carries its own evidence |
| Relative phrase | "yesterday," "last Friday" | 14 days | Bounded by the meaning of the phrase itself |
| Partial date, no year | `22/01`, "the 5th" | 90 days, higher confidence threshold | The most easily confused with an identifier (a PR number, a sprint label) rather than a date |

The asymmetry is intentional. Rejecting a legitimate reference costs little: the event simply retains
its source timestamp. Accepting a spurious one plants an incorrect entry in the historical record.
That is the more expensive failure, and the one this system exists to prevent. This limit governs only how far
attribution may move an event from its source timestamp; it does not bound how far back the database
can be queried, which is unrestricted.

## Runtime and dependencies (D12, D13, D14)

`shiplog` targets Node.js 22.16 or later and depends on no third-party packages. `node:sqlite`
provides persistence, the global `fetch` provides HTTP, and `node:test` provides the test runner, all
from the standard library.

The floor is 22.16 rather than a round 22, and that precision was earned rather than assumed. The
original claim here was simply "Node 22 or later", carried across three documents without anything
verifying it. A CI matrix bisected the real boundary: 22.13.0, 22.14.0 and 22.15.0 all fail at import
time with `The requested module 'node:sqlite' does not provide an export named 'backup'`, and 22.16.0
is the first version that passes. `lib/backup.mjs` imports that export at module load, so on an older
runtime the failure is a `SyntaxError` before any shiplog code runs, which tells the user nothing
about what to fix.

Two consequences worth keeping. `assertSupportedNode` in `lib/config.mjs` compares the minor version,
not just the major, because a major-only check waves through precisely the versions that break. And
22.16.0 is pinned as its own CI matrix cell, because the floating `22` cell resolves to the newest
22.x and would never notice the floor regressing.

This follows from the distribution target (D16). A plugin intended for other developers' machines
should not require a package installation step, because that step is a common and hard-to-diagnose
point of failure: virtual environment setup, restricted package registries, and platform-managed
Python installations that block unscoped package installation are all realistic obstacles on a
machine the author does not control.

The query server (`mcp/server.mjs`) communicates over the Model Context Protocol, implemented directly
as line-delimited JSON-RPC rather than through the official SDK. The protocol surface in use is just
`initialize`, `tools/list` and `tools/call`, small enough to implement and verify directly against
Claude Code as the client, and doing so avoids the one dependency that would otherwise be necessary.
If the protocol changes in a way this implementation does not track, adopting the official SDK remains
a contained, later change.

The query server's tools are parameterized and read-only. There is no tool that accepts and executes
arbitrary SQL. This is deliberate: the server's data includes text originating from other people's
comments and tickets, and a tool that executed model-supplied SQL would extend that content's reach
into the database itself. The server also opens its connection read-only, so the ingest/query boundary
is enforced by the operating system, not only by convention.

## Query server connection handling (D17)

The query server holds one SQLite connection, opened once when the process starts and kept open for
its lifetime. It does not use a connection pool.

A pool exists to amortize the cost of establishing a network connection, a handshake and often
authentication, across many concurrent clients, and to bound how many such connections a shared
server will accept at once. SQLite has no network connection to amortize: it is an embedded,
file-backed database, and opening it is a local file operation. The query server is also not a
multi-tenant service; one process serves one Claude Code session, and its queries complete in single
digits of milliseconds against the indices defined in the schema. A pool would introduce failure modes of its own,
such as exhaustion and connection health tracking, with no corresponding benefit.

The property a pool is meant to provide, a connection that is opened once and reused, rather than
reopened per request, is what a single persistent connection already gives for free in this setting.

Concurrent access between the query server (a reader) and the sync job (a writer) is handled by
SQLite's write-ahead log mode (`PRAGMA journal_mode = WAL`), under which readers and writers do not
block one another. This is what makes it safe to ask a question while a scheduled sync is in progress.

## A claimed weekday is verified deterministically (D21)

The first real sync against a live account surfaced a genuine correctness bug. A comment posted on a
Tuesday read "Last Friday I noticed a small typo, fixed now." The model resolved this to a date that
was, in fact, a Saturday, and it passed every existing guard: confidence 0.95, well within the
backdate window for a relative reference. Nothing checked that "Friday" actually landed on a Friday.

This is the exact failure this system exists to prevent. The whole premise is that a stored
attribution can be trusted as evidence; a wrong date accepted with high confidence is worse than no
attribution at all, since it looks authoritative.

The fix does not ask the model to try harder. It adds a check code can perform with certainty:
scan the source text for a weekday name, and if one is present, verify that the resolved
`effective_date` actually falls on that day. A mismatch is rejected the same way every other guard
rejects, the event keeps its posted date and stays queued for the next run. Reproducing the fix
against the same live comment confirmed its value directly: on retry, the model made a second,
different wrong guess, and the new check caught that one too.

The tradeoff is explicit: a weekday named in an unrelated aside ("fixed the bug reported on
Wednesday") could cause a correct attribution to be rejected. That costs little. The alternative,
ever accepting a date that contradicts what the text itself claims, is the more expensive failure,
consistent with the same asymmetry that shapes the backdating limits in D10.

## Range boundaries are timezone-converted, not sliced (D22)

Asking a plain "what did I work on recently" question against a live account surfaced a second,
more serious bug in the same session. `get_stats` reported one event when three had actually
happened. Nothing had failed, no error was raised. The count was just quietly wrong.

`resolveRange`'s exclusive `end` boundary is the UTC instant of local midnight on the day *after*
the requested range, computed correctly using civil-date arithmetic in the configured timezone. The
query layer, however, recovered a date to compare against by slicing the first ten characters off
that instant's ISO string. For any timezone with a positive UTC offset, IST among them, that instant
still carries *today's* UTC calendar date, not tomorrow's, since the local clock has not yet rolled
over in UTC terms. Slicing therefore reproduced today's own date as the exclusive upper bound, and a
strict `<` comparison excluded every one of today's events, in every query, every time, for anyone in
that half of the world's timezones. A timezone behind UTC was never affected, which is presumably
why this shipped in the first place: it worked correctly for every UTC-based test in the suite,
because a UTC offset of zero can never expose the gap between "sliced date" and "converted date".

The fix converts the instant into a calendar date using the actual configured timezone
(`zonedParts`, the same primitive `resolveRange` itself is built on) rather than reading it off the
raw string. A bare `YYYY-MM-DD` boundary, which some callers legitimately pass instead of a full
instant, is left untouched, since it is already an unambiguous local date with nothing to convert.

The lesson this leaves behind: a UTC-only test suite cannot catch a timezone-conversion bug, because
UTC is the one timezone where slicing and converting happen to agree. The tests added for this fix
deliberately exercise a real non-UTC timezone (Asia/Kolkata, where this was found) rather than adding
more UTC coverage, since that is the only way this class of bug can actually fail.

## Initial backfill is capped at 2 years, regardless of setting (D23)

The original default, the start of the configured fiscal year, turns out to be too shallow in
practice: for an April-start fiscal year, a sync run in early autumn only reaches back five or six
months, not enough to answer a question spanning a full review cycle or a rolling tenure lookback.

The other extreme, backfilling from account creation with no lower bound, has a real cost. GitHub's
search API is rate-limited, and Azure DevOps's WIQL query has no natural lower bound of its own ,
either one can turn a first sync into a very long one for years of history that mostly won't get
cited in a standup or a review. Two years covers a full fiscal year and a full tenure-anniversary
view without that risk.

The cap is enforced as a ceiling on the *resolved* date, not as a restriction on what
`initialBackfillFrom` can be set to. `all_time`, an old explicit date, or a future default nobody has
reconsidered are all still accepted as configuration, and all still get clamped to 2 years back at
the point the first sync actually runs (`initialBackfillStart` in `lib/config.mjs`). This is
deliberately more defensive than validating the setting at config-load time: a validation check can
be worked around by whatever sets the config next, including a later version of this file's own
defaults, while a floor on the computed value cannot.

This limits only how far back the *first* sync reaches. It has no bearing on how far back a later
question can be asked; that remains unrestricted, bounded only by what a sync has actually collected.
Commit history is unaffected by this change in practice, since `includeCommits` already defaults to
`false`, GitHub's commit search is the single most expensive call available, and a 2-year backfill
was exactly the scenario that default already existed to guard against.

## Model selection for attribution (D8)

The attribution stage invokes `claude -p` with `--model haiku`, a capability alias rather than a
specific model identifier, together with `--fallback-model sonnet`.

An earlier draft of this configuration specified a dated model identifier. That was incorrect for two
independent reasons. First, current model identifiers are not date-suffixed, so no such identifier was
valid. Second, and more consequentially: pinning any specific model identifier in a plugin distributed
to other machines creates a dependency on that model remaining available indefinitely. Claude Code's
tier aliases resolve, at call time, to whichever model currently serves that tier, which means this
configuration requires no update when the underlying model changes.

The general principle: a distributed plugin should request a capability tier, not a specific model.
Model lifecycle is Claude Code's responsibility to manage, not this project's.

## The standup covers the last working day through now, in per-day sections (D24)

The standup range is `since_last_working_day`, which starts at local midnight of the last working day
and ends at the exclusive end of today. It replaced `last_working_day` as the default.

The previous default showed the last working day and stopped there, so the current day's own work
never appeared. A standup is "what I did last, and what I'm on now", and a single-day range can only
ever answer the first half of that. The gap was found by running the command, not by reading it: the
output covered one past day and simply had nothing to say about today.

The range lives in `lib/ranges.mjs` rather than in the standup code, because that module is the
single source of truth for date arithmetic. Putting it anywhere else would mean a second
implementation of "what is the last working day", free to drift from the first and to miss the
timezone handling in D22.

Output is grouped into one section per day, oldest first, rather than two fixed "yesterday and today"
blocks. Two blocks cannot describe a Monday, where the previous working day is Friday and the weekend
may or may not be empty. Sections appear only for days that actually have activity, so an ordinary
Monday shows Friday and Today rather than three empty weekend headings.

Days with weekend activity are shown rather than hidden. Suppressing Saturday's work would make the
summary tidier and less true, which is the wrong trade for a tool whose entire purpose is producing an
accurate record of what someone did.

Headings say "Yesterday" only when the day genuinely is yesterday. On a Monday, Friday is labelled
"Friday, 28 Aug". Labelling it "Yesterday" would be visibly wrong to the one person guaranteed to read
it, on one day in every five.

Sections apply only to the standup's own range. `last_week` and `last_month` keep the flat aggregate,
because thirty day-headings is a log rather than a summary. Per-day event counts are capped instead of
the total, so a busy Friday cannot push today out of today's standup.

Anyone with `last_working_day` set explicitly keeps the single-day behaviour, since that is a stated
preference rather than an unconsidered default. Only the default for new installations changed.

## The reported day of an event is computed in the configured timezone (D25)

`queryEvents` and `getStats(group_by: 'day')` compute each row's calendar date with
`effectiveDateOf()` in JavaScript, using the configured timezone, rather than with SQL's
`substr(occurred_at, 1, 10)`.

This was found while building the per-day sections above, through a test written in
`Australia/Sydney` rather than UTC. An event at 22:30 UTC is already 08:30 the next morning in Sydney,
and the SQL projection filed it under the previous day.

It is the same defect as D22, one level down. D22 corrected the timezone handling of range *bounds*;
the per-row date that callers group and display by was still the UTC one. The reason it survived the
first fix is the reason D22 gives for its own existence: every test used UTC, the single offset where
slicing an ISO string and converting it properly give the same answer.

The blast radius was wider than the standup. Both `query_events` and `get_stats` are exposed over MCP,
so the wrong day reached user-facing answers about when work happened, in a tool meant to serve as
evidence.

`effective_at` is deliberately exempt, because it is already a local calendar date written by the
attribution stage. Converting it again would shift a correctly attributed date by a day.

The SQL expression is retained for filtering and ordering, where it is close enough because the bounds
themselves are already converted, and where SQLite offers no conversion to an arbitrary timezone: its
only `localtime` is the host machine's. Day grouping moved into JavaScript for the same reason. The
comment on `EFFECTIVE_DATE` now says which of the two uses it is valid for.

## The plugins/ layout did not fix Desktop installation (D26)

The move to `plugins/shiplog/` (D-adjacent, see the restructure) was made on an explicit hypothesis:
that Claude Desktop's failure, "The archive must contain a `.claude-plugin/plugin.json` manifest",
came from Desktop inspecting an archive of the resolved `source` path, and that matching the layout
Anthropic's own marketplace uses would resolve it.

**The hypothesis was wrong.** Desktop installation still fails after the restructure. Recording that
plainly, because the restructure was committed on the strength of a guess, and a guess that did not
pay off is worth as much to the next person as one that did.

What is now ruled out, each checked rather than assumed:

- The repository URL. It returns HTTP 200 from both github.com and the API, is public, is not
  archived, and its default branch is `main`. The "check the repository URL" message Desktop shows is
  misleading; the address was never the problem.
- `marketplace.json` being unreachable. It is fetchable over raw.githubusercontent.com.
- The manifests being invalid. `claude plugin validate ./plugins/shiplog --strict` exits 0, and a test
  asserts the marketplace `source` resolves to a directory that really does contain
  `.claude-plugin/plugin.json`.
- The repository layout. Both the flat layout and the `plugins/<name>/` layout fail in Desktop, and
  both succeed from the CLI.

The CLI installs correctly from this exact URL, including resolving `./plugins/shiplog` and
extracting only that directory. So the difference lies in whatever Desktop does after fetching, which
is not observable from here.

The restructure was kept regardless. It matches the reference layout, it separates the plugin from
repository-level tooling like `scripts/` and `.github/` that users should not receive, and it is what
made the marketplace-source test meaningful. It is defensible on its own merits; it simply was not
the fix it was hoped to be.

Next step, if this is picked up again, is an upstream issue with the exact error and the repository
link rather than further guessing from the outside.

## Azure DevOps status changes are dated by ChangedDate, not revisedDate (D27)

`normalizeStatusChange` takes its timestamp from the revision's own
`System.ChangedDate`, not from `revisedDate`. Rows that cannot yield a real date are
dropped rather than stored with a placeholder.

`revisedDate` is a trap in two independent ways, both confirmed against a live work
item rather than inferred from documentation:

- On a work item's **current** revision it is `9999-01-01T00:00:00Z`, a sentinel
  meaning "not superseded yet". Stored as an event date, it sorts above every real
  event, forever.
- On **every other** revision it is the moment that revision stopped being current,
  which is the timestamp of the *next* edit. A ticket moved to Done on a Friday and
  next touched three weeks later recorded the transition three weeks late. For a tool
  whose entire question is "when did I do this", that is the wrong date twice over,
  and the second case is the quieter and more damaging one.

The fixtures did not catch this because they were shaped from the provider's
documented example, which shows neither the sentinel nor `System.ChangedDate`. This
is the limit of fixture-driven testing stated plainly: fixtures encode what the
documentation says, and the documentation showed a tidy case. The bug surfaced only
by syncing a real project. The fixtures now carry the real shape, including the
sentinel and the off-by-one-revision relationship between `revisedDate` and the next
revision's `ChangedDate`.

Fixing the adapter was not sufficient on its own, which is worth recording because it
was not obvious. The upsert never overwrites `occurred_at`, deliberately, since it is
the source system's own timestamp and a later sync has no business rewriting it. That
invariant is right, but it assumes the stored value was a real timestamp. A sentinel
never was, so a re-sync left it in place. Verified by re-syncing and watching
`updated_at` correct itself while `occurred_at` did not.

So `repairSentinelTimestamps()` runs when the database is opened, recovering the true
date from the raw payload already stored beside the row. It is deliberately narrow:
only `ticket_status_change` rows, only the exact sentinel value, and only when a
usable date can be recovered. A row it cannot repair with confidence is left alone,
because an invented date in a record meant to serve as evidence is worse than a
missing one.

## Answer length scales with the question, and the rule is built in (D28)

`skills/shiplog-query/SKILL.md` now states the default answer shape — a lookup gets the
direct answer in a few lines — and scopes the grouped, fully-cited format to review and
1:1 summaries, where the length earns itself.

The previous text said, unconditionally, to lead with `get_stats` numbers and then support
them with citations from `query_events`. It described the grouped format as being "for a
review or 1:1 summary" but never said what the *default* was, so the heavy shape became the
default for everything. Asked which projects had seen activity over about a week — a question
whose honest answer is three names — it produced a themed, per-PR breakdown of all 37 events
with a link each. Nothing in it was factually wrong, which is what made it worth fixing: the
characteristic failure of a tool built to produce evidence is burying the answer in evidence.

The rejected alternative was to leave this file alone and let a general-purpose brevity
plugin (`concise`, `terse`, `caveman`) trim the output. That works on the machine where it
was set up and nowhere else. shiplog is published for other people, and a skill that only
reads well when the user happens to have installed an unrelated third-party plugin is broken
by default for everyone else. It also contradicts the zero-dependency rule the runtime
already follows (D12-D14) — buying a behaviour with someone else's plugin is still buying a
dependency, just one that is invisible until it is missing.

The same reasoning produced the reuse ladder now in `CLAUDE.md` rather than a note saying to
run `/ponytail-review`: the ladder is written out so it works for a contributor with nothing
installed, and the plugin is mentioned only as an optional way to run it mechanically.

## Query answers have one named shape per question type (D29)

`skills/shiplog-query/SKILL.md` section 5 defines five shapes — Scope, Count, Lookup, Recap,
Review pack — plus a degraded-data preamble that runs before any of them. Each names its
layout concretely enough that the same question produces the same kind of answer twice.

D28 established that answer length should scale with the question, but left the judgement
open, and a judgement re-made from scratch every invocation is exactly the thing that drifts
with whatever else is in the context window. Naming the shapes converts a judgement into a
lookup. The shapes also encode the invariants that were previously loose prose — range stated
plainly, counts from `get_stats` rather than eyeballed, `effective_at` divergence surfaced —
so following the format satisfies them rather than depending on remembering them separately.

They are defaults, not a schema. The section says outright that a question fitting none of
them should use the nearest and adapt. A rigid template set would trade the old failure
(everything gets the heavy shape) for a new one (an odd question gets forced into a
close-but-wrong shape), and the second is harder to notice.

They live inline rather than in a sibling reference file. An output format is needed on every
single invocation, so a separate file would mean an extra read every time to save nothing.
The cost was kept flat by deleting the prose the templates made redundant: the section
carries five formats in roughly the space the old unconditional advice took.

`skills/shiplog-status/SKILL.md` deliberately did not get the same treatment. Its step 4
already enumerates the fields to report and prescribes a response per failure mode, which is
what a format would supply. Adding one would have been lines in an always-read file for no
behavioural change.
