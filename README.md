# shiplog

A Claude Code plugin that remembers what you actually did at work, so you don't have to reconstruct
it from memory the morning of a review.

Every night it collects your own activity from Azure DevOps and GitHub into a local SQLite database.
Later you just ask:

> what did I contribute in the last 3 weeks?
>
> how many PRs did I raise this quarter?
>
> summarize my work for my one-on-one

and you get real counts and real links back, not a vague recollection.

It can also greet you with a short standup summary the first time you open a terminal each day.

## Status

Early development, but the core is built and tested (266 tests, no network or credentials required to
run them).

| Area | State |
| --- | --- |
| GitHub source | Working, verified against the live API |
| Azure DevOps source | Working, verified against Microsoft's published API docs and fixtures. Not yet exercised against a real organization |
| Nightly sync, backups, retention | Working, launchd job verified end to end on macOS |
| Question answering (MCP server plus skill) | Working, verified over real stdio as a subprocess |
| Date attribution from comment text | Working, verified against the real `claude` CLI |
| Standup summary on first terminal open | Working, verified by running the real hook script |
| Jira | Not in this release. See [Roadmap](#roadmap) |

## Why this exists

Your work is scattered across three or four systems, and none of them can answer "what did I do in
Q2". Ticket systems show current state, not history. Git shows commits, not context. By review time
the details have aged out of easy recall, and what you can remember tends to be whatever happened
most recently.

shiplog keeps a durable local record so the answer is a query rather than an archaeology project.

## How it works

Three stages, deliberately separated:

1. **Ingest.** A plain script calls the source APIs, normalizes the results, and writes them to
   SQLite. No model involved, so the nightly run is fast, free, and reliable enough to leave alone
   for months. This is what your scheduler runs.
2. **Attribute.** Resolves dates mentioned in prose. A comment posted on the 23rd saying "yesterday I
   finished the migration" belongs to the 22nd. This runs after ingest, so if it fails, the events are
   already saved and it just retries tomorrow.
3. **Query.** Only when you actually ask something. Claude reads the collected data through a
   read only server and writes the answer.

Your data stays on your machine. Nothing is uploaded anywhere.

## Requirements

- **Node.js 22 or later.** Uses the built in `node:sqlite`, so there is nothing to `npm install`.
  The plugin has zero third party dependencies.
- **macOS** for automatic scheduling (launchd). Everything else works anywhere Node runs, and on
  Linux you can add the cron line yourself.
- Read only access tokens for whichever sources you turn on.

## Install

Add the marketplace and install the plugin:

```
/plugin marketplace add praneethrudroji/shiplog-plugin
/plugin install shiplog
```

Or clone it directly into your plugins directory:

```bash
git clone https://github.com/praneethrudroji/shiplog-plugin.git ~/.claude/plugins/shiplog
```

Then restart Claude Code so the plugin's MCP server and hook are picked up.

To confirm it loaded, run `/help` and look for the `shiplog` commands, or just run
`/shiplog-status`.

## Setup

Run this and answer the questions:

```
/shiplog-setup
```

It walks through connecting your sources, resolves your user identity from each API rather than
asking you to type an id, confirms your fiscal year and timezone, validates every credential with a
dry run before anything is scheduled, and then offers to install the nightly job and run a first
backfill.

You will need:

**GitHub.** If you already use the `gh` CLI, setup offers to reuse `gh auth token` and you need
nothing else. Otherwise create a token with read access to the repositories you work in.

**Azure DevOps.** A personal access token from `https://dev.azure.com/{org}/_usersSettings/tokens`
with three read scopes: Code (read), Work Items (read), Release (read). You will also be asked for
your organization and which projects to track.

Tokens are written to `~/.shiplog/secrets.env` with mode 0600 and are never stored in the config file.

## Using it

### Just ask

Once there is data, ask questions in plain language. The plugin's skill activates on its own:

```
what did I work on last week?
how many PRs did I merge this quarter?
what have I been doing in the payments project since April?
summarize my contributions this financial year for my review
what did I ship between January and March?
```

Answers cite real titles and links, and note when a date was inferred from a comment rather than
taken from a timestamp.

### Commands

| Command | What it does |
| --- | --- |
| `/shiplog-setup` | Configure sources, calendar, schedule, standup. Add `--reconfigure` to change existing settings |
| `/shiplog-sync` | Sync now instead of waiting for tonight. Useful right before a standup or review |
| `/shiplog-status` | Last sync per source, event counts, backlog size, whether the nightly job is registered |

`/shiplog-sync` takes the same flags as the underlying script: `--dry-run` to check credentials
without writing, `--source github` to limit it, `--since 2026-01-01` to backfill further, and
`--no-enrich` to skip the date attribution step.

### Time ranges

Say it however you normally would: `today`, `yesterday`, `last_working_day`, `this_week`,
`last_month`, `this_quarter`, `this_fy`, `last 3 weeks`, `last 12 months`, `fy2026`, `2026-01-22`, or
`2026-01-01..2026-03-31`.

Quarters and financial years follow *your* calendar. Set `fiscalYearStartMonth` to 4 for an April to
March year, and `fiscalYearNaming` to say whether April 2026 to March 2027 is called FY2026 or
FY2027. Range boundaries are local midnight in your timezone, which is what makes "yesterday" mean
the same thing to the tool as it does to you.

`last_working_day` skips weekends, so on a Monday it means the previous Friday.

There is no limit on how far back you can ask. If the data is in the database, you can query it.

### Standup summary

Turn this on and the first time you start a session each day, you get a short summary before anything
else:

```
📋 shiplog - last working day (2026-08-28 to 2026-08-28):
  • 2 PRs merged
  • 1 PR opened
  • 3 ticket comments

Highlights:
  - Add retry to the payment client (https://github.com/octo/payments/pull/42)
  - Fix settlement rounding drift (https://dev.azure.com/acme/Payments/_workitems/edit/299)
```

Set it in `~/.shiplog/config.json`:

```json
"standup": { "enabled": true, "range": "last_working_day" }
```

`range` can be `last_working_day`, `last_week`, or `last_month`. It fires at most once per calendar
day, and it costs nothing to run because it reads the local database directly with no model call.

## What gets tracked

| Source | Events |
| --- | --- |
| GitHub | PRs you opened and merged, reviews you submitted, comments you wrote, and optionally commits |
| Azure DevOps | PRs you opened and completed, review votes, PR comments, work items you created, comments you wrote, status changes you made, and Classic Release deployments you requested |

Only your own activity is recorded. Your identity is resolved from each API at setup, and every query
filters on it, so a colleague's comment on your PR never becomes part of your record.

## Configuration

Everything lives in `~/.shiplog/config.json` (mode 0600):

```json
{
  "version": 1,
  "timezone": "Asia/Kolkata",
  "dateFormat": "DMY",
  "weekStartsOn": 1,
  "weekendDays": [0, 6],
  "fiscalYearStartMonth": 4,
  "fiscalYearNaming": "start_year",
  "identity": { "githubLogin": "", "adoUserId": "" },
  "sources": {
    "github": { "enabled": true, "useGhCli": true, "tokenEnv": "SHIPLOG_GITHUB_TOKEN", "orgs": [], "includeCommits": false },
    "azure_devops": { "enabled": true, "orgUrl": "", "projects": [], "tokenEnv": "SHIPLOG_ADO_PAT", "includeDeployments": true }
  },
  "sync": { "lookbackHours": 48, "initialBackfillFrom": "fy-start", "maxBodyChars": 2000 },
  "enrich": { "enabled": true, "model": "haiku", "fallbackModel": "sonnet", "confidenceFloor": 0.6, "batchSize": 50 },
  "backup": { "retentionDays": 30 },
  "schedule": { "type": "daily", "hour": 2, "minute": 0 },
  "standup": { "enabled": false, "range": "last_working_day" }
}
```

A few worth knowing about:

- `initialBackfillFrom` controls how far back the very first sync reaches. It defaults to the start of
  your financial year and accepts any range expression.
- `includeCommits` is off by default because GitHub's commit search is the most expensive call in the
  whole sync.
- `enrich.model` is a capability tier, not a model id, so it keeps working when models change.

## Where your data lives

```
~/.shiplog/
├── config.json      settings, mode 0600, holds env var names and never secrets
├── secrets.env      tokens, mode 0600
├── shiplog.db       the record, mode 0600
├── backups/         rotated gzipped snapshots, mode 0600
└── logs/sync.log    what the nightly job did
```

This sits outside the plugin directory on purpose, so upgrading or reinstalling the plugin never
touches your history.

## Security

- Tokens live in a separate file from the config, both mode 0600, and the config only ever records
  the *name* of an environment variable.
- The database and its backups are mode 0600, because they hold titles and comment text from private
  company systems.
- Every log line passes through a redaction filter that strips token shaped strings, since a log file
  is the sort of thing people paste into bug reports.
- The query server opens the database read only, and exposes parameterized tools rather than anything
  that runs model supplied SQL.
- Text arriving from GitHub and Azure DevOps is treated as untrusted data. It is flattened and length
  capped before it reaches Claude's context, and it is explicitly labelled as data rather than
  instructions.

## Scheduling

Setup installs a launchd job that runs nightly at the hour you choose. You can manage it directly:

```bash
node bin/install-scheduler.mjs --print       # show the exact files, write nothing
node bin/install-scheduler.mjs --install
node bin/install-scheduler.mjs --status
node bin/install-scheduler.mjs --uninstall
```

If your Mac is asleep at the scheduled time, the job runs when it next wakes, so a missed night
catches itself up. On a managed Mac, registration can need approval under System Settings, General,
Login Items, and the installer tells you when that happens rather than reporting a success it did not
get.

Linux is not automated yet. The installer prints the cron line to add.

## Development

```bash
node --test test/
```

The suite runs in under a second, makes no network calls, and needs no credentials. Source modules
take an injected fetcher so they can be tested against recorded fixtures, and the SQLite layer runs
against a temporary file.

Two suites go further and exercise real process boundaries: `test/mcp-e2e.test.mjs` spawns the query
server and speaks real JSON-RPC to it over stdio, and `test/standup-hook.test.mjs` runs the hook
script the way Claude Code invokes it.

### Live testing against real data

Fixtures prove the code handles the shapes it was given correctly. They cannot prove it behaves
correctly against a live account, real pagination, a real token, a comment someone actually wrote.
[shiplog-test-data](https://github.com/praneethrudroji/shiplog-test-data) is a small sandbox repo
kept for exactly that: real PRs, real comments, sometimes deliberately awkward phrasing aimed at
shiplog's date attribution rather than at building anything. Running the plugin's first real sync
against it caught a genuine bug this way: an attribution that resolved "last Friday" to a Saturday,
which is what led to the deterministic weekday check described in
[docs/DECISIONS.md](docs/DECISIONS.md).

## Design notes

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the code fits together, module by module.
- [docs/DECISIONS.md](docs/DECISIONS.md) records what was chosen, what was rejected, and why.

## Roadmap

- **Jira** (Cloud and Server). Deliberately left out of this release. The source module pattern that
  GitHub and Azure DevOps established carries over directly.
- Linux cron support in the scheduler installer.
- A command for correcting a date attribution by hand.
- Azure DevOps YAML pipeline approvals, which have no clean REST equivalent to Classic Releases today.

## Contributing

Issues and pull requests are welcome, particularly from anyone running this against a real Azure
DevOps organization, since that path has not been exercised against live data yet.

If you are adding a source, `lib/sources/github.mjs` is the reference implementation. The pattern is:
take an injected `fetcher` rather than calling `fetch` directly, resolve the user's identity from the
API rather than trusting configuration, filter every result to that identity, and build fixtures from
the provider's own documented examples. That keeps the tests offline and credential free.

Please run `node --test test/` before opening a pull request. The suite should stay under a second and
should never need network access or credentials.

## License

MIT. See [LICENSE](LICENSE).
