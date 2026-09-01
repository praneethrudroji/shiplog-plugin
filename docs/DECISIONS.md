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

`shiplog` targets Node.js 22 or later and depends on no third-party packages. `node:sqlite` provides
persistence, the global `fetch` provides HTTP, and `node:test` provides the test runner, all from the
standard library.

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
